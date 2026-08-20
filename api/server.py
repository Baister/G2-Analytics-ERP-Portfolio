"""API de demonstração — FastAPI sobre o dataset sintético.

Serve os mesmos padrões do sistema original, sem nenhuma dependência de banco
proprietário: autenticação por perfil de acesso, eventos em tempo real (SSE),
três estratégias distintas de cache e serialização uniforme.

    python -m uvicorn server:app --port 8765
    # ou, com os bots rodando em background:
    python server.py
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
import threading
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

import config
from bots.base import BotManager
from bots.clientes import BotClientes
from bots.crm import BotCrm
from bots.dashboard import BotDashboard
from bots.estoque import BotEstoque
from bots.financeiro import BotFinanceiro
from bots.imposto import BotImposto
from bots.vendas import BotVendas
from consultas import busca_clientes, cliente_marca_produto, perfil_cliente, painel_pedidos
from core.cache import Cache, limpar_para_json
from core.db import Database

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

db = Database(config.BANCO, modo_guarda=config.MODO_GUARDA)
cache = Cache(config.CACHE)
manager = BotManager(db, cache)

_loop: asyncio.AbstractEventLoop | None = None
_filas: list[asyncio.Queue] = []


def _montar_bots() -> None:
    for classe, nome in [
        (BotDashboard, "dashboard"), (BotVendas, "vendas"), (BotEstoque, "estoque"),
        (BotFinanceiro, "financeiro"), (BotCrm, "crm"), (BotImposto, "imposto"),
        (BotClientes, "clientes"),
    ]:
        manager.registrar(classe(db, cache, intervalo=config.INTERVALOS[nome]))


def _avisar_front(nome: str, _resultado: dict) -> None:
    """Publica no SSE que um bot terminou o ciclo.

    Os bots rodam em threads; o loop de eventos é outro mundo. `call_soon_
    threadsafe` é a única ponte correta entre os dois — sem isso o payload some
    silenciosamente.
    """
    if _loop is None:
        return
    evento = json.dumps({"bot": nome, "em": datetime.now().strftime("%H:%M:%S")})
    for fila in list(_filas):
        try:
            _loop.call_soon_threadsafe(fila.put_nowait, evento)
        except Exception:
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _loop
    _loop = asyncio.get_event_loop()
    _montar_bots()
    manager.add_callback(_avisar_front)
    manager.carregar_do_cache()   # a tela abre cheia antes do 1º ciclo terminar
    manager.iniciar()
    yield
    manager.parar()


app = FastAPI(title="G2 Analytics — API de demonstração", version="1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

# ── Autenticação por perfil ───────────────────────────────────────────────
_tokens: dict[str, dict] = {}
_bearer = HTTPBearer(auto_error=True)


class Login(BaseModel):
    password: str


def _abas(token: str) -> list[str]:
    info = _tokens.get(token)
    return info["tabs"] if info else []


def verificar_token(cred: HTTPAuthorizationCredentials = Depends(_bearer)) -> str:
    token = cred.credentials
    info = _tokens.get(token)
    if not info or info["exp"] < time.time():
        _tokens.pop(token, None)
        raise HTTPException(status_code=401, detail="sessão expirada")
    return token


def exigir_aba(token: str, aba: str) -> None:
    """Fecha a porta no servidor, não só na navegação."""
    abas = _abas(token)
    if "*" not in abas and aba not in abas:
        raise HTTPException(status_code=403, detail=f"perfil sem acesso à aba '{aba}'")


@app.post("/auth")
def autenticar(req: Login):
    abas = config.PERFIS.get(req.password.strip())
    if abas is None:
        raise HTTPException(status_code=400, detail="Senha incorreta")
    token = secrets.token_urlsafe(32)
    _tokens[token] = {"exp": time.time() + config.TOKEN_TTL, "tabs": abas}
    return {"access_token": token, "token_type": "bearer", "tabs": abas}


@app.get("/")
def raiz():
    return {"status": "ok", "servico": "G2 Analytics — demonstração",
            "perfis": sorted(config.PERFIS)}


# ── Estado dos bots ───────────────────────────────────────────────────────
@app.get("/status")
def estado(token: str = Depends(verificar_token)):
    """Lista só os bots que o perfil enxerga.

    Quem só tem acesso a Vendas não descobre por aqui que existe Financeiro.
    """
    abas = _abas(token)
    todos = manager.status()
    if "*" in abas:
        return {"bots": todos}
    return {"bots": {n: s for n, s in todos.items() if n in abas}}


# ── Eventos em tempo real ─────────────────────────────────────────────────
def _token_de_query(token: Optional[str] = Query(default=None)) -> str:
    # O EventSource do navegador não envia cabeçalho Authorization — nesta rota,
    # e só nela, o token vem por query string.
    if not token or token not in _tokens or _tokens[token]["exp"] < time.time():
        raise HTTPException(status_code=401, detail="token inválido")
    return token


@app.get("/stream")
async def stream(token: str = Depends(_token_de_query)):
    fila: asyncio.Queue = asyncio.Queue()
    _filas.append(fila)

    async def eventos():
        try:
            yield "event: ping\ndata: {}\n\n"      # abre o canal imediatamente
            while True:
                try:
                    dado = await asyncio.wait_for(fila.get(), timeout=30)
                    yield f"event: atualizado\ndata: {dado}\n\n"
                except asyncio.TimeoutError:
                    yield "event: ping\ndata: {}\n\n"   # mantém a conexão viva
        finally:
            if fila in _filas:
                _filas.remove(fila)

    return StreamingResponse(eventos(), media_type="text/event-stream")


# ── Serialização uniforme ─────────────────────────────────────────────────
def responder(payload: dict) -> Response:
    """Todo caminho de resposta passa por aqui.

    `limpar_para_json` neutraliza NaN/Inf e datas; `default=str` cobre o resto.
    No sistema de origem, o único endpoint que não fazia isso respondia 503 em
    produção quando o banco devolvia um `Decimal`.
    """
    return Response(
        content=json.dumps(limpar_para_json(payload), ensure_ascii=False, default=str),
        media_type="application/json",
    )


# ── Metas (única escrita da API — em arquivo, não no banco) ───────────────
_METAS = config.RAIZ / "metas.json"


def _ler_metas() -> dict:
    if _METAS.exists():
        try:
            return json.loads(_METAS.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            logger.warning("metas.json inválido — usando o padrão")
    return {"meta_mensal_total": config.META_PADRAO, "metas_individuais": {}}


@app.get("/metas")
def obter_metas(token: str = Depends(verificar_token)):
    return responder(_ler_metas())


@app.post("/metas")
def salvar_metas(corpo: dict, token: str = Depends(verificar_token)):
    exigir_aba(token, "configuracoes")
    total = corpo.get("meta_mensal_total", 0)
    individuais = corpo.get("metas_individuais", {}) or {}

    def valido(v) -> bool:
        # `NaN < 0` é False: uma validação ingênua deixaria NaN passar e
        # envenenaria o arquivo, quebrando todo GET seguinte.
        try:
            f = float(v)
        except (TypeError, ValueError):
            return False
        return f == f and f not in (float("inf"), float("-inf")) and f >= 0

    if not valido(total) or any(not valido(v) for v in individuais.values()):
        raise HTTPException(status_code=422, detail="valores de meta inválidos")

    dados = {"meta_mensal_total": float(total),
             "metas_individuais": {k: float(v) for k, v in individuais.items()}}
    # Escrita atômica: um processo morto no meio não deixa arquivo pela metade.
    tmp = _METAS.with_suffix(".tmp")
    tmp.write_text(json.dumps(dados, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(_METAS)
    return {"ok": True}


# ── Consultas sob demanda ─────────────────────────────────────────────────
# NOTA: estas rotas precisam ser registradas ANTES de /dados/{bot}, senão o
# FastAPI absorve "cliente" e "painel-pedidos" como valor do path param.

_TTL_PAINEL = 20.0
_painel_cache: tuple[float, dict] | None = None
_painel_lock = threading.Lock()


@app.get("/dados/painel-pedidos")
def rota_painel(token: str = Depends(verificar_token)):
    """Single-flight: N telas em polling compartilham UMA consulta."""
    global _painel_cache
    exigir_aba(token, "painel_pedidos")
    with _painel_lock:
        if _painel_cache and time.time() - _painel_cache[0] < _TTL_PAINEL:
            return responder(_painel_cache[1])
        payload = painel_pedidos(db)
        # O erro sai por exceção antes daqui, então nunca é cacheado.
        _painel_cache = (time.time(), payload)
    return responder(payload)


_cli_cache: "OrderedDict[str, tuple[float, dict]]" = OrderedDict()
_cli_lock = threading.Lock()
_TTL_CLIENTE = 60.0


@app.get("/dados/cliente")
def rota_cliente(busca: Optional[str] = Query(default=None),
                 cod: Optional[str] = Query(default=None),
                 token: str = Depends(verificar_token)):
    """LRU com teto: reabrir a mesma ficha em menos de um minuto não toca o banco."""
    exigir_aba(token, "cliente")
    if cod:
        chave = cod.strip()[:20]
        with _cli_lock:
            achado = _cli_cache.get(chave)
            if achado and time.time() - achado[0] < _TTL_CLIENTE:
                _cli_cache.move_to_end(chave)
                return responder(achado[1])
        payload = perfil_cliente(db, chave)
        with _cli_lock:
            _cli_cache[chave] = (time.time(), payload)
            _cli_cache.move_to_end(chave)
            while len(_cli_cache) > 100:
                _cli_cache.popitem(last=False)
        return responder(payload)
    if busca and busca.strip():
        return responder(busca_clientes(db, busca.strip()))
    return responder({"modo": "vazio"})


_cmp_cache: "OrderedDict[tuple, tuple[float, dict]]" = OrderedDict()
_cmp_lock = threading.Lock()
_TTL_CMP = 60.0


@app.get("/dados/cliente-marca-produto")
def rota_cmp(dt_de: Optional[str] = Query(default=None),
             dt_ate: Optional[str] = Query(default=None),
             clientes: Optional[str] = Query(default=None),
             vendedores: Optional[str] = Query(default=None),
             marcas: Optional[str] = Query(default=None),
             token: str = Depends(verificar_token)):
    """LRU chaveado pela tupla NORMALIZADA de filtros.

    Ordenar as listas antes de compor a chave faz "marca A,B" e "marca B,A"
    acertarem o mesmo cache.
    """
    exigir_aba(token, "cliente")

    def lista(bruto: Optional[str]) -> list[str]:
        return [v.strip()[:60] for v in (bruto or "").split(",") if v.strip()][:100]

    filtros = {
        "dt_de": (dt_de or "")[:10], "dt_ate": (dt_ate or "")[:10],
        "clientes": lista(clientes), "vendedores": lista(vendedores),
        "marcas": lista(marcas),
    }
    chave = (filtros["dt_de"], filtros["dt_ate"], tuple(sorted(filtros["clientes"])),
             tuple(sorted(filtros["vendedores"])), tuple(sorted(filtros["marcas"])))
    with _cmp_lock:
        achado = _cmp_cache.get(chave)
        if achado and time.time() - achado[0] < _TTL_CMP:
            _cmp_cache.move_to_end(chave)
            return responder(achado[1])

    payload = cliente_marca_produto(db, filtros)
    with _cmp_lock:
        _cmp_cache[chave] = (time.time(), payload)
        _cmp_cache.move_to_end(chave)
        while len(_cmp_cache) > 50:
            _cmp_cache.popitem(last=False)
    return responder(payload)


@app.get("/dados/dashboard/filtered")
def rota_dashboard_filtrado(dt_de: Optional[str] = Query(default=None),
                            dt_ate: Optional[str] = Query(default=None),
                            vendedores: Optional[str] = Query(default=None),
                            marcas: Optional[str] = Query(default=None),
                            grupos: Optional[str] = Query(default=None),
                            token: str = Depends(verificar_token)):
    """Período personalizado: consulta na hora, sem tocar o cache do bot."""
    exigir_aba(token, "dashboard")
    bot = manager.bots.get("dashboard")
    if bot is None:
        raise HTTPException(status_code=503, detail="bot indisponível")

    def lista(bruto: Optional[str]) -> list[str]:
        return [v.strip()[:60] for v in (bruto or "").split(",") if v.strip()][:100]

    try:
        return responder(bot.analisar_filtrado({
            "dt_de": dt_de, "dt_ate": dt_ate, "vendedores": lista(vendedores),
            "marcas": lista(marcas), "grupos": lista(grupos),
        }))
    except Exception as e:
        logger.error("dashboard filtrado falhou: %s", e)
        raise HTTPException(status_code=503, detail=str(e))


# ── Caminho quente: o payload do bot, direto da memória ───────────────────
@app.get("/dados/{bot_nome}")
def rota_bot(bot_nome: str, token: str = Depends(verificar_token)):
    exigir_aba(token, bot_nome)
    bot = manager.bots.get(bot_nome)
    if bot is None:
        raise HTTPException(status_code=404, detail=f"bot '{bot_nome}' não existe")
    if bot.resultado:
        return responder(bot.resultado)
    guardado = cache.carregar(bot_nome)
    if guardado:
        return responder(guardado)
    raise HTTPException(status_code=503, detail="primeiro ciclo ainda não terminou")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=config.PORTA, log_level="info")
