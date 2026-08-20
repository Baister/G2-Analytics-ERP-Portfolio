"""Testes do guarda de SQL.

A parte interessante não são os exemplos escritos à mão — é a varredura de AST
no fim do arquivo, que pega TODA string SQL do código-fonte real e a submete ao
guarda. Foi esse teste que autorizou virar a chave de "avisar" para "recusar"
em produção: ele prova que nenhuma consulta legítima do projeto é rejeitada.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

from core.sql_guard import SqlGuardError, e_somente_leitura, ensure_readonly

API = Path(__file__).resolve().parent.parent

ACEITOS = [
    "SELECT 1",
    "SELECT * FROM cliente WHERE uf = 'SP'",
    "  select nome from vendedor  ",
    "WITH base AS (SELECT 1 AS n) SELECT n FROM base",
    "SELECT * FROM item -- comentário com a palavra delete\n",
    "SELECT * FROM doc /* update aqui é só comentário */",
    # Literais e identificadores escapados não podem virar token proibido:
    "SELECT * FROM documento WHERE situacao = 'pedido cancelado, sem update'",
    'SELECT "update" FROM tabela',
    "SELECT [Update Ts] FROM tabela",
    "SELECT COUNT(*) FROM titulo WHERE recebido_em IS NULL",
]

RECUSADOS = [
    ("", "vazio"),
    ("   ", "vazio"),
    ("DELETE FROM cliente", "primeiro token"),
    ("UPDATE cliente SET nome = 'x'", "primeiro token"),
    ("INSERT INTO cliente VALUES (1)", "primeiro token"),
    ("DROP TABLE item", "primeiro token"),
    ("TRUNCATE TABLE item", "primeiro token"),
    ("ALTER TABLE item ADD COLUNA x", "primeiro token"),
    ("CREATE TABLE x (a int)", "primeiro token"),
    ("SELECT 1; DROP TABLE item", "comandos"),
    ("SELECT 1;SELECT 2", "comandos"),
    ("SELECT * INTO nova FROM item", "token proibido"),
    ("SELECT * FROM item WHERE 1=1; DELETE FROM item", "comandos"),
]


@pytest.mark.parametrize("sql", ACEITOS)
def test_aceita_consultas_legitimas(sql):
    ensure_readonly(sql, dialeto="sqlite")
    assert e_somente_leitura(sql, dialeto="sqlite")


@pytest.mark.parametrize("sql,motivo", RECUSADOS)
def test_recusa_comandos_perigosos(sql, motivo):
    with pytest.raises(SqlGuardError) as exc:
        ensure_readonly(sql, dialeto="sqlite")
    assert motivo in str(exc.value)
    assert not e_somente_leitura(sql, dialeto="sqlite")


def test_dialeto_muda_o_que_e_proibido():
    """Cada banco tem seus próprios comandos perigosos."""
    ensure_readonly("SELECT * FROM t WHERE x = 1", dialeto="generico")

    # ATTACH é específico do SQLite; o dialeto genérico não o conhece.
    ensure_readonly("SELECT 1 FROM attach_log", dialeto="generico")
    with pytest.raises(SqlGuardError):
        ensure_readonly("SELECT 1 FROM t WHERE attach IS NULL", dialeto="sqlite")

    # Procedures de sistema só existem no SQL Server.
    with pytest.raises(SqlGuardError):
        ensure_readonly("SELECT * FROM sp_who", dialeto="tsql")


def test_dialeto_desconhecido_falha_alto():
    with pytest.raises(ValueError, match="dialeto desconhecido"):
        ensure_readonly("SELECT 1", dialeto="oracle")


# ── Varredura de AST sobre o código real ─────────────────────────────────
def _strings_sql_do_fonte(caminho: Path) -> list[str]:
    """Extrai toda string com cara de SQL de um arquivo Python.

    Reconstrói f-strings trocando cada expressão interpolada por `1`, que é
    exatamente o que o guarda veria depois da montagem em runtime. Sem isso,
    uma consulta montada com f-string escaparia da varredura.
    """
    arvore = ast.parse(caminho.read_text(encoding="utf-8"))
    encontradas: list[str] = []
    dentro_de_fstring: set[int] = set()

    for no in ast.walk(arvore):
        if isinstance(no, ast.JoinedStr):
            partes = []
            for pedaco in no.values:
                if isinstance(pedaco, ast.Constant) and isinstance(pedaco.value, str):
                    dentro_de_fstring.add(id(pedaco))
                    partes.append(pedaco.value)
                else:
                    partes.append("1")
            encontradas.append("".join(partes))

    for no in ast.walk(arvore):
        if isinstance(no, ast.Constant) and isinstance(no.value, str):
            if id(no) not in dentro_de_fstring:
                encontradas.append(no.value)

    return [s for s in encontradas if "select" in s.lower() and "from" in s.lower()]


def _fontes() -> list[Path]:
    return sorted(
        p for p in API.rglob("*.py")
        if "tests" not in p.parts and "__pycache__" not in p.parts
    )


def test_toda_consulta_do_projeto_passa_no_guarda():
    """Nenhuma consulta escrita no projeto pode ser rejeitada pelo guarda.

    Duas categorias, com critérios diferentes:
      - consulta completa (começa em SELECT/WITH) → tem de passar inteira;
      - fragmento (`AND EXISTS (SELECT ...)`) → nunca chega sozinho ao guarda,
        então só se exige que não carregue token proibido nem `;`.
    """
    completas = 0
    problemas: list[str] = []

    for arquivo in _fontes():
        for sql in _strings_sql_do_fonte(arquivo):
            texto = sql.strip()
            primeiro = texto.split(None, 1)[0].lower() if texto else ""
            rel = arquivo.relative_to(API)
            if primeiro in ("select", "with"):
                completas += 1
                try:
                    ensure_readonly(texto, dialeto="sqlite")
                except SqlGuardError as e:
                    problemas.append(f"{rel}: {e}\n    {texto[:160]}")
            else:
                if ";" in texto:
                    problemas.append(f"{rel}: fragmento com ';' contaminaria a consulta montada")

    assert not problemas, (
        "consultas do projeto reprovadas pelo guarda — NÃO ative o modo "
        "'enforce' antes de resolver:\n  " + "\n  ".join(problemas)
    )
    # Sanidade do próprio coletor: se ele parar de achar consultas, o teste
    # acima passaria vazio e ninguém perceberia.
    assert completas >= 10, f"coletor achou só {completas} consultas — regressão na varredura"
