"""Testes da camada de dados: guarda integrado, teto de linhas, erro por thread."""
from __future__ import annotations

import threading

import pytest

from core.db import Database


def test_consulta_devolve_dataframe(db):
    df = db.query("SELECT nome FROM vendedor ORDER BY id")
    assert len(df) == 15
    assert list(df.columns) == ["nome"]
    assert db.last_error == "", "sucesso tem de limpar o last_error"


def test_parametros_sao_vinculados(db):
    df = db.query("SELECT COUNT(*) AS n FROM cliente WHERE uf = ?", ("SP",))
    assert int(df["n"][0]) > 0
    # A mesma consulta com um valor inexistente devolve zero, provando que o
    # parâmetro chegou ao banco em vez de ser interpolado no texto.
    df2 = db.query("SELECT COUNT(*) AS n FROM cliente WHERE uf = ?", ("ZZ",))
    assert int(df2["n"][0]) == 0


def test_guarda_bloqueia_escrita_sem_derrubar_o_processo(db):
    df = db.query("DELETE FROM cliente")
    assert df.empty, "consulta bloqueada tem de devolver DataFrame vazio"
    assert "guarda de SQL" in db.last_error
    # E o banco continua intacto:
    assert int(db.query("SELECT COUNT(*) AS n FROM cliente")["n"][0]) == 520


def test_guarda_bloqueia_encadeamento(db):
    df = db.query("SELECT 1; DROP TABLE item")
    assert df.empty
    assert "guarda de SQL" in db.last_error


def test_modo_warn_deixa_passar_e_o_driver_barra(banco_demo):
    """Em 'warn' o guarda só avisa — a última linha de defesa é o driver."""
    banco = Database(banco_demo, modo_guarda="warn")
    df = banco.query("DELETE FROM cliente")
    assert df.empty
    # Não foi o guarda que barrou; foi o SQLite aberto em modo somente-leitura.
    assert "guarda de SQL" not in banco.last_error
    assert banco.last_error != ""
    assert int(banco.query("SELECT COUNT(*) AS n FROM cliente")["n"][0]) == 520
    banco.fechar()


def test_teto_de_linhas_trunca(db, caplog):
    df = db.query("SELECT numero FROM documento", max_linhas=10)
    assert len(df) == 10
    assert "truncada" in caplog.text.lower()


def test_erro_de_sintaxe_vira_last_error(db):
    df = db.query("SELECT * FROM tabela_que_nao_existe")
    assert df.empty
    assert "tabela_que_nao_existe" in db.last_error


def test_last_error_e_por_thread(db):
    """O erro de uma thread não pode contaminar o que a outra lê."""
    db.query("SELECT 1")  # thread principal: sucesso
    visto: dict[str, str] = {}

    def worker():
        db.query("SELECT * FROM inexistente")
        visto["worker"] = db.last_error

    t = threading.Thread(target=worker)
    t.start()
    t.join()

    assert visto["worker"] != "", "a worker devia ter registrado o próprio erro"
    assert db.last_error == "", "o erro da worker vazou para a thread principal"


def test_banco_ausente_falha_com_mensagem_util(tmp_path):
    banco = Database(tmp_path / "nao_existe.db")
    df = banco.query("SELECT 1")
    assert df.empty
    assert "dados.gerar" in banco.last_error, "a mensagem deve dizer como resolver"
