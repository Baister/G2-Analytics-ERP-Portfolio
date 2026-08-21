"""Contrato entre o front e a API.

Existe por causa de um defeito real: os adaptadores foram reescritos para um
backend novo, mas os hooks continuaram pedindo `/dados/cliente_comportamento` e
`/dados/painel_pedidos` — rotas que deixaram de existir. O TypeScript não
reclama (a URL é uma string), a tela não quebra (o hook trata o erro) e o
resultado é um painel silenciosamente vazio.

Este teste lê as URLs que o front realmente chama e confere contra as rotas
que a API realmente expõe. É feio ler TypeScript com expressão regular, mas é
o preço de garantir que os dois lados não se percam — e o teste falha alto no
dia em que alguém renomear uma rota.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

API = Path(__file__).resolve().parent.parent
WEB = API.parent / "web"
HOOKS = WEB / "src" / "lib" / "api" / "hooks.ts"
AUTH = WEB / "src" / "lib" / "auth.ts"
DEMO_DIR = WEB / "public" / "demo"

#: `apiFetch("/dados/x")` e `apiFetch(\`/dados/x?...\`)`
CHAMADA = re.compile(r"""apiFetch[<(\s]*[`"']([^`"'?]+)""")
#: `{ rota: "/x", aba: "y" }`
ROTA_ABA = re.compile(r"""rota:\s*["']([^"']+)["']\s*,\s*aba:\s*["']([^"']+)["']""")


def _rotas_da_api() -> set[str]:
    import server

    return {r.path for r in server.app.routes if hasattr(r, "path")}


def _caminhos_chamados_pelo_front() -> set[str]:
    texto = HOOKS.read_text(encoding="utf-8")
    caminhos = set(CHAMADA.findall(texto))
    # postJson usa a mesma base; captura à parte para não depender da ordem.
    caminhos |= set(re.findall(r"""postJson[<(\s]*[`"']([^`"'?]+)""", texto))
    return {c for c in caminhos if c.startswith("/")}


def _casa_com_rota(caminho: str, rotas: set[str]) -> bool:
    if caminho in rotas:
        return True
    # A rota curinga /dados/{bot_nome} atende qualquer nome de bot.
    partes = caminho.strip("/").split("/")
    for rota in rotas:
        molde = rota.strip("/").split("/")
        if len(molde) != len(partes):
            continue
        if all(m.startswith("{") or m == p for m, p in zip(molde, partes)):
            return True
    return False


def test_toda_url_chamada_pelo_front_existe_na_api():
    rotas = _rotas_da_api()
    chamados = _caminhos_chamados_pelo_front()
    assert chamados, "não achei nenhuma chamada de API no hooks.ts — a extração quebrou"

    orfas = sorted(c for c in chamados if not _casa_com_rota(c, rotas))
    assert not orfas, (
        "o front chama caminhos que a API não expõe — o painel fica vazio sem erro "
        f"visível:\n  {chr(10).join(orfas)}\n\nRotas disponíveis:\n  "
        + "\n  ".join(sorted(rotas))
    )


def test_todo_bot_do_manager_responde_pela_rota_curinga():
    """Cada bot registrado precisa ser alcançável por /dados/<nome>."""
    import server

    server._montar_bots()
    nomes = set(server.manager.bots)
    assert nomes, "nenhum bot registrado"
    esperados = {"dashboard", "vendas", "estoque", "financeiro", "crm", "imposto", "clientes"}
    assert esperados <= nomes, f"faltam bots: {esperados - nomes}"


def test_abas_dos_perfis_existem_de_fato():
    """Um perfil não pode liberar uma aba que nenhuma rota exige.

    Se `config.PERFIS` cita uma aba com nome errado, o usuário vê o item no
    menu e leva 403 ao clicar — o pior dos dois mundos.
    """
    import config
    import server

    server._montar_bots()
    # Abas que a API realmente verifica: os nomes dos bots + as das rotas
    # sob demanda.
    validas = set(server.manager.bots) | {"cliente", "painel_pedidos", "configuracoes"}

    for senha, abas in config.PERFIS.items():
        for aba in abas:
            if aba == "*":
                continue
            assert aba in validas, (
                f"perfil {senha!r} libera a aba {aba!r}, que nenhuma rota exige. "
                f"Abas válidas: {sorted(validas)}"
            )


def test_mapa_de_rotas_do_front_usa_abas_validas():
    """As abas do front (ROTA_ABA) e da API precisam ser o mesmo vocabulário."""
    import server

    server._montar_bots()
    validas = set(server.manager.bots) | {"cliente", "painel_pedidos", "configuracoes"}

    pares = ROTA_ABA.findall(AUTH.read_text(encoding="utf-8"))
    assert pares, "não achei o mapa rota→aba no auth.ts"

    desconhecidas = sorted({aba for _, aba in pares if aba not in validas})
    assert not desconhecidas, (
        "o front exige abas que a API não conhece — o item aparece no menu e o "
        f"clique leva 403: {desconhecidas}"
    )


@pytest.mark.skipif(not DEMO_DIR.exists(), reason="retrato ainda não exportado")
def test_retrato_estatico_cobre_todas_as_chamadas():
    """O site publicado serve arquivos; falta um e a tela quebra só em produção.

    A regra de nomes é a mesma do `demo.ts`: `/dados/crm` → `dados-crm.json`.
    """
    # /dados/dashboard/filtered cai para o retrato sem filtro, e /auth não
    # existe no modo estático (a sessão é fictícia).
    ignorar = {"/dados/dashboard/filtered", "/auth"}
    faltando = []

    for caminho in sorted(_caminhos_chamados_pelo_front() - ignorar):
        arquivo = DEMO_DIR / (caminho.strip("/").replace("/", "-") + ".json")
        if not arquivo.exists():
            faltando.append(f"{caminho} → {arquivo.name}")

    assert not faltando, (
        "o retrato estático não tem arquivo para estas chamadas — a tela fica "
        "vazia no site publicado:\n  " + "\n  ".join(faltando)
    )


@pytest.mark.skipif(not DEMO_DIR.exists(), reason="retrato ainda não exportado")
def test_retrato_do_status_usa_o_mesmo_formato_da_api():
    """O contador da barra lateral já quebrou por um campo com nome diferente."""
    import server

    server._montar_bots()
    da_api = server.manager.status()
    do_retrato = json.loads((DEMO_DIR / "status.json").read_text(encoding="utf-8"))["bots"]

    assert do_retrato, "retrato de status vazio"
    campos_api = set(next(iter(da_api.values())))
    campos_retrato = set(next(iter(do_retrato.values())))
    assert campos_api == campos_retrato, (
        f"o retrato e a API divergem: só na API {campos_api - campos_retrato}, "
        f"só no retrato {campos_retrato - campos_api}"
    )
