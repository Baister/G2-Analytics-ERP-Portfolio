"""Rotinas de análise em background.

Cada painel do sistema é alimentado por um "bot": uma thread que consulta o
banco em ciclo próprio, agrega o resultado e publica. A tela abre instantânea
porque lê o último ciclo pronto, não porque a consulta é rápida.

Três padrões daqui nasceram de incidentes reais no sistema de origem e são o
motivo de esta classe existir separada das consultas:

1. **Boot escalonado** — sete bots disparando juntos derrubavam as consultas
   mais pesadas por timeout no rush pós-inicialização. Cada bot entra com um
   atraso crescente; o cache cobre a espera.
2. **Manter o último bom** — se um ciclo volta vazio por falha transitória, o
   bot devolve o resultado anterior em vez de publicar um payload mínimo. É a
   diferença entre "o painel piscou" e "o painel zerou".
3. **Degradação por consulta** — o fan-out paralelo trata cada consulta
   isoladamente: uma que falha vira DataFrame vazio. O painel perde um
   gráfico, não a página.
"""
from __future__ import annotations

import concurrent.futures as cf
import logging
import threading
import time
from datetime import datetime
from typing import Callable

import pandas as pd

logger = logging.getLogger(__name__)


def registros(df: pd.DataFrame) -> list[dict]:
    """DataFrame → lista de dicionários com tipos NATIVOS do Python.

    `df.to_dict("records")` devolve `numpy.int64` e `numpy.float64`, que o
    `json.dumps` não serializa — e que, com `default=str`, virariam strings no
    payload sem ninguém perceber até o gráfico não desenhar. Aqui a conversão é
    explícita, e `NaN` vira `None` (JSON não tem NaN).
    """
    if df is None or df.empty:
        return []
    saida: list[dict] = []
    for linha in df.to_dict("records"):
        limpa: dict = {}
        for chave, valor in linha.items():
            if valor is None or (isinstance(valor, float) and pd.isna(valor)):
                limpa[chave] = None
            elif hasattr(valor, "item"):        # numpy int64/float64/bool_
                limpa[chave] = valor.item()
            elif isinstance(valor, (int, float, str, bool)):
                limpa[chave] = valor
            else:
                limpa[chave] = str(valor)
        saida.append(limpa)
    return saida


class BaseBot(threading.Thread):
    """Ciclo de análise. Subclasses implementam apenas `analisar()`."""

    #: segundos entre ciclos — sobrescrito por subclasse ou pelo manager
    intervalo = 300

    def __init__(self, nome: str, db, cache=None, intervalo: int | None = None,
                 boot_delay: int = 0):
        super().__init__(daemon=True, name=nome)
        self.nome = nome
        self.db = db
        self.cache = cache
        if intervalo is not None:
            self.intervalo = intervalo
        self.boot_delay = boot_delay

        self.resultado: dict = {}
        self.status = "aguardando"        # aguardando | executando | ok | erro
        self.erro_msg = ""
        self.ultimo_update = "—"
        self._ultimo_update_dt: datetime | None = None
        self._parar = threading.Event()
        self.callbacks: list[Callable[[str, dict], None]] = []

    # ── ciclo de vida ──────────────────────────────────────────────────────
    def parar(self) -> None:
        self._parar.set()

    def add_callback(self, fn: Callable[[str, dict], None]) -> None:
        self.callbacks.append(fn)

    def segundos_para_o_proximo(self) -> int | None:
        """Alimenta o contador regressivo que a interface mostra."""
        if self.status == "executando":
            return 0
        if self._ultimo_update_dt is None:
            return None
        passou = (datetime.now() - self._ultimo_update_dt).total_seconds()
        return max(0, int(self.intervalo - passou))

    def _publicar(self) -> None:
        agora = datetime.now()
        self._ultimo_update_dt = agora
        self.ultimo_update = agora.strftime("%H:%M:%S")
        for cb in self.callbacks:
            try:
                cb(self.nome, self.resultado)
            except Exception as e:
                # Um observador com defeito não pode derrubar o ciclo do bot.
                logger.warning("callback de [%s] falhou: %s", self.nome, e)
        if self.cache is not None and self.resultado:
            # Só persiste com dado de verdade: gravar payload vazio destruiria
            # o cache que serve a tela no próximo boot.
            try:
                self.cache.salvar(self.nome, self.resultado)
            except Exception as e:
                logger.warning("cache de [%s] falhou: %s", self.nome, e)

    def run(self) -> None:
        logger.info("bot [%s] iniciado (ciclo de %ds)", self.nome, self.intervalo)
        for _ in range(self.boot_delay):
            if self._parar.is_set():
                return
            time.sleep(1)

        while not self._parar.is_set():
            self.status = "executando"
            try:
                novo = self.analisar()
                if not novo and self.resultado:
                    # Manter o último bom: ciclo vazio não apaga o que já existe.
                    logger.warning("bot [%s] voltou vazio — mantendo o resultado anterior", self.nome)
                    self.status = "ok"
                else:
                    self.resultado = novo
                    self.status = "ok"
                self.erro_msg = ""
            except Exception as e:
                logger.error("bot [%s] erro: %s", self.nome, e)
                self.status = "erro"
                self.erro_msg = str(e)
            self._publicar()

            # Sono fatiado: para responder ao pedido de parada em até 1s em vez
            # de segurar o desligamento por um ciclo inteiro.
            for _ in range(self.intervalo):
                if self._parar.is_set():
                    break
                time.sleep(1)

    def analisar(self) -> dict:
        raise NotImplementedError

    # ── utilidades para as subclasses ──────────────────────────────────────
    def paralelo(self, consultas: dict[str, tuple[str, tuple]]) -> dict[str, pd.DataFrame]:
        """Roda as consultas em paralelo; cada falha vira DataFrame vazio.

        O painel perde um gráfico em vez da página inteira — e o log diz qual.
        """
        resultado: dict[str, pd.DataFrame] = {}
        with cf.ThreadPoolExecutor(max_workers=4) as pool:
            futuros = {
                pool.submit(self.db.query, sql, params): chave
                for chave, (sql, params) in consultas.items()
            }
            for fut in cf.as_completed(futuros):
                chave = futuros[fut]
                try:
                    resultado[chave] = fut.result()
                except Exception as e:
                    logger.error("[%s] consulta '%s' falhou: %s", self.nome, chave, e)
                    resultado[chave] = pd.DataFrame()
        return resultado


class BotManager:
    """Registra, inicia e para o conjunto de bots."""

    #: atraso entre a entrada de um bot e a do seguinte, em segundos
    ESCALONAMENTO = 3

    def __init__(self, db, cache=None):
        self.db = db
        self.cache = cache
        self.bots: dict[str, BaseBot] = {}
        self._callbacks: list[Callable[[str, dict], None]] = []

    def registrar(self, bot: BaseBot) -> BaseBot:
        self.bots[bot.nome] = bot
        for cb in self._callbacks:
            bot.add_callback(cb)
        return bot

    def add_callback(self, fn: Callable[[str, dict], None]) -> None:
        self._callbacks.append(fn)
        for bot in self.bots.values():
            bot.add_callback(fn)

    def carregar_do_cache(self) -> None:
        """Hidrata os bots com o último ciclo salvo — a tela abre cheia."""
        if self.cache is None:
            return
        for nome, bot in self.bots.items():
            dados = self.cache.carregar(nome)
            if dados:
                bot.resultado = dados
                bot.status = "ok"
                bot.ultimo_update = self.cache.quando(nome) or "cache"

    def iniciar(self) -> None:
        for i, bot in enumerate(self.bots.values()):
            bot.boot_delay = i * self.ESCALONAMENTO
            bot.start()

    def parar(self) -> None:
        for bot in self.bots.values():
            bot.parar()

    def status(self) -> dict[str, dict]:
        return {
            nome: {
                "status": bot.status,
                "ultimo_update": bot.ultimo_update,
                "erro_msg": bot.erro_msg,
                "segundos_para_o_proximo": bot.segundos_para_o_proximo(),
            }
            for nome, bot in self.bots.items()
        }

    def resultado(self, nome: str) -> dict | None:
        bot = self.bots.get(nome)
        return bot.resultado if bot else None
