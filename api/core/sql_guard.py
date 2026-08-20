"""Guarda de SQL somente-leitura.

Garante que todo texto SQL enviado ao banco é UM ÚNICO comando `SELECT`/`WITH`
sem efeito colateral. É defesa em profundidade: a camada de dados já é
somente-leitura por contrato — isto é o cinto-e-suspensório em tempo de
execução, para o caso de alguém montar SQL dinâmico e escorregar.

Nasceu num sistema que lia o banco de produção de um ERP, sem ambiente de
testes paralelo: um `DELETE` acidental não teria volta. O rollout foi gradual
(`warn` → `enforce`) e só virou obrigatório depois que a varredura de AST sobre
o código real provou zero falso-positivo em mais de cem consultas — ver
`tests/test_sql_guard.py`.

Uso:

    from core.sql_guard import ensure_readonly, SqlGuardError

    ensure_readonly("SELECT 1")                 # ok
    ensure_readonly("DELETE FROM x")            # SqlGuardError

O que ele NÃO faz, declarado de propósito: não é um parser (é um guarda
léxico), não valida os parâmetros da consulta e não substitui as permissões do
usuário de banco. Um identificador não-escapado chamado `update` gera falso
positivo — o preço de errar para o lado seguro.
"""
from __future__ import annotations

import re

# A ordem das remoções importa: comentários primeiro, depois literais de string
# (com '' escapado), depois identificadores entre colchetes e aspas duplas.
# É isso que evita os dois falsos positivos clássicos:
#   WHERE situacao = 'documento cancelado'   → 'cancelado' não vira token
#   SELECT [Update Ts]                       → 'Update' não vira token
_COMENTARIOS = re.compile(r"--[^\n]*|/\*.*?\*/", re.S)
_LITERAIS = re.compile(r"'(?:[^']|'')*'")
_COLCHETES = re.compile(r"\[[^\]]*\]")
_ASPAS_DUPLAS = re.compile(r'"[^"]*"')

# Tokens que alteram dados, estrutura, permissões ou o servidor. `into` entra
# porque `SELECT ... INTO nova_tabela` cria tabela sendo um SELECT.
_DDL_DML = (
    r"insert|update|delete|merge|truncate|drop|alter|create|replace"
    r"|grant|revoke|into"
)

# Extensões por dialeto: cada banco tem seu próprio conjunto de comandos
# perigosos que passariam despercebidos por uma lista genérica.
_DIALETOS: dict[str, str] = {
    # SQL Server: procedures de sistema, execução remota, espera e manutenção.
    "tsql": (
        r"|exec|execute|openrowset|opendatasource|openquery|waitfor|bulk"
        r"|dbcc|backup|restore|kill|shutdown|use"
        r")\b|\b(?:sp|xp)_\w+"
    ),
    # SQLite: anexar outro arquivo de banco é leitura/escrita fora do escopo.
    "sqlite": r"|attach|detach|pragma|vacuum|reindex|analyze)\b",
    # PostgreSQL: COPY lê e escreve arquivos do servidor.
    "postgres": r"|copy|call|do|vacuum|analyze|cluster|listen|notify)\b",
    # Sem extensão de dialeto.
    "generico": r")\b",
}

_CACHE_REGEX: dict[str, re.Pattern[str]] = {}


class SqlGuardError(ValueError):
    """SQL rejeitado pela guarda somente-leitura."""


def _proibidos(dialeto: str) -> re.Pattern[str]:
    if dialeto not in _DIALETOS:
        raise ValueError(f"dialeto desconhecido: {dialeto!r} (use {sorted(_DIALETOS)})")
    if dialeto not in _CACHE_REGEX:
        _CACHE_REGEX[dialeto] = re.compile(
            r"\b(" + _DDL_DML + _DIALETOS[dialeto], re.I
        )
    return _CACHE_REGEX[dialeto]


def _limpar(sql: str) -> str:
    """Remove o que é conteúdo, deixando só a estrutura do comando."""
    corpo = _COMENTARIOS.sub(" ", sql)
    corpo = _LITERAIS.sub("''", corpo)
    corpo = _COLCHETES.sub(" x ", corpo)
    corpo = _ASPAS_DUPLAS.sub(" x ", corpo)
    return corpo


def ensure_readonly(sql: str, dialeto: str = "generico") -> None:
    """Levanta `SqlGuardError` se o SQL não for um único SELECT/WITH inofensivo.

    Três checagens, na ordem: um só comando, primeiro token permitido, nenhum
    token proibido no que sobrou depois da limpeza.
    """
    if not sql or not sql.strip():
        raise SqlGuardError("SQL vazio")

    corpo = _limpar(sql)

    comandos = [c for c in corpo.split(";") if c.strip()]
    if len(comandos) != 1:
        raise SqlGuardError(
            f"{len(comandos)} comandos num só texto (esperado 1) — "
            "possível tentativa de encadear statements"
        )

    primeiro = comandos[0].strip().split(None, 1)[0].lower()
    if primeiro not in ("select", "with"):
        raise SqlGuardError(f"primeiro token {primeiro!r} não permitido (só SELECT/WITH)")

    achado = _proibidos(dialeto).search(comandos[0])
    if achado:
        raise SqlGuardError(f"token proibido: {achado.group(0)!r}")


def e_somente_leitura(sql: str, dialeto: str = "generico") -> bool:
    """Versão booleana, para quando você quer decidir em vez de interromper."""
    try:
        ensure_readonly(sql, dialeto)
        return True
    except SqlGuardError:
        return False
