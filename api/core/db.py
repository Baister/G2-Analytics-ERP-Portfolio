"""Camada de dados somente-leitura sobre SQLite.

Três garantias, nesta ordem:

1. **Somente leitura por contrato** — a classe não expõe nenhum método de
   escrita. Não existe `executar()`, `inserir()` ou `salvar()`.
2. **Somente leitura em runtime** — toda consulta passa por `ensure_readonly`
   antes de tocar o banco (defesa em profundidade, ver `core/sql_guard.py`).
3. **Somente leitura no driver** — a conexão é aberta em modo `ro` via URI do
   SQLite, então o próprio banco recusa escrita.

No sistema original a fonte era o SQL Server de produção de um ERP via ODBC;
aqui é um SQLite gerado por script. A estrutura é a mesma — o que muda é a
`factory` de conexão passada ao pool.
"""
from __future__ import annotations

import logging
import sqlite3
import threading
from pathlib import Path

import pandas as pd

from core.pool import ConnectionPool, PoolEsgotado
from core.sql_guard import SqlGuardError, ensure_readonly

logger = logging.getLogger(__name__)

# Teto padrão de linhas por consulta. Existe para que um `SELECT` sem filtro
# não vire um problema de memória do processo inteiro.
MAX_LINHAS_PADRAO = 5000


class Database:
    def __init__(
        self,
        caminho: str | Path,
        *,
        pool_max: int = 8,
        max_linhas: int = MAX_LINHAS_PADRAO,
        modo_guarda: str = "enforce",
    ):
        self.caminho = Path(caminho)
        self.max_linhas = max_linhas
        # "enforce" recusa, "warn" só registra, "off" desliga. O sistema original
        # rodou meses em "warn" e só virou a chave depois que a varredura de AST
        # provou que nenhuma consulta legítima era rejeitada.
        self.modo_guarda = modo_guarda
        # last_error por THREAD: com consultas paralelas, o erro de um worker
        # sobrescrevia o flag lido por outro. Contrato: "" em sucesso, mensagem
        # em erro, "" para quem nunca consultou.
        self._tls = threading.local()
        self._pool = ConnectionPool(
            factory=self._conectar,
            cap=pool_max,
            max_idle_s=300.0,
            wait_s=30.0,
            health_check=lambda c: c.execute("SELECT 1").close(),
        )

    # ── erro por thread ────────────────────────────────────────────────────
    @property
    def last_error(self) -> str:
        return getattr(self._tls, "err", "")

    @last_error.setter
    def last_error(self, valor: str) -> None:
        self._tls.err = valor

    # ── conexão ────────────────────────────────────────────────────────────
    def _conectar(self) -> sqlite3.Connection:
        if not self.caminho.exists():
            raise FileNotFoundError(
                f"banco de demonstração não encontrado em {self.caminho} — "
                "rode: python -m dados.gerar"
            )
        # mode=ro: o driver recusa qualquer escrita, mesmo que algo passasse
        # pelo guarda. check_same_thread=False porque o pool empresta a
        # conexão para a thread que a pediu.
        uri = f"file:{self.caminho.as_posix()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, check_same_thread=False, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    # ── consulta ───────────────────────────────────────────────────────────
    def query(self, sql: str, params: tuple | list | None = None,
              max_linhas: int | None = None) -> pd.DataFrame:
        """Executa um SELECT e devolve um DataFrame.

        Nunca levanta por erro de banco: devolve DataFrame vazio e registra a
        causa em `last_error`. Quem chama decide o que fazer — foi essa escolha
        que permitiu um painel perder um gráfico em vez de a página inteira.
        """
        self.last_error = ""
        teto = self.max_linhas if max_linhas is None else max_linhas

        try:
            self._validar(sql)
        except SqlGuardError as e:
            self.last_error = f"guarda de SQL: {e}"
            logger.error("guarda bloqueou consulta: %s\n→ SQL: %.300s", e, sql.strip())
            return pd.DataFrame()

        try:
            conn = self._pool.acquire()
        except Exception as e:
            # Vale para pool esgotado E para falha ao abrir (banco ausente,
            # arquivo corrompido, permissão). O contrato da camada é não
            # levantar: quem chama lê `last_error` e decide.
            self.last_error = str(e)
            nivel = logger.warning if isinstance(e, PoolEsgotado) else logger.error
            nivel("sem conexão disponível: %s", e)
            return pd.DataFrame()

        quebrada = False
        try:
            cur = conn.execute(sql, tuple(params or ()))
            # Busca teto+1 para saber se truncou SEM materializar o excesso.
            linhas = cur.fetchmany(teto + 1)
            colunas = [d[0] for d in cur.description] if cur.description else []
            cur.close()
            if len(linhas) > teto:
                linhas = linhas[:teto]
                logger.warning(
                    "consulta truncada em %d linhas — refine o filtro: %.120s",
                    teto, sql.strip(),
                )
            return pd.DataFrame([tuple(l) for l in linhas], columns=colunas)
        except Exception as e:
            quebrada = True
            self.last_error = str(e)
            logger.error("erro na consulta: %s\n→ SQL: %.300s", e, sql.strip())
            return pd.DataFrame()
        finally:
            # Conexão que errou não volta ao pool: pode estar em estado sujo.
            self._pool.release(conn, quebrada=quebrada)

    def _validar(self, sql: str) -> None:
        if self.modo_guarda == "off":
            return
        try:
            ensure_readonly(sql, dialeto="sqlite")
        except SqlGuardError:
            if self.modo_guarda == "warn":
                logger.warning("guarda (modo warn) reprovaria: %.200s", sql.strip())
                return
            raise

    def fechar(self) -> None:
        self._pool.close_all()
