"""Testes das consultas sob demanda (perfil, busca, painel e análise cruzada)."""
from __future__ import annotations

import json
from datetime import date, timedelta

import pytest

from consultas import busca_clientes, cliente_marca_produto, painel_pedidos, perfil_cliente


def _serializavel(payload) -> None:
    """Todo payload precisa atravessar json.dumps sem ajuda."""
    json.dumps(payload, ensure_ascii=False)


def test_busca_encontra_por_trecho_do_nome(db):
    algum = db.query("SELECT nome FROM cliente LIMIT 1")["nome"][0]
    termo = algum.split()[0]
    payload = busca_clientes(db, termo)
    _serializavel(payload)
    assert payload["clientes"], f"nenhum cliente para o termo {termo!r}"
    assert all(termo.lower() in c["nome"].lower() or termo.lower() in c["razao"].lower()
               for c in payload["clientes"])


def test_busca_sem_resultado_devolve_lista_vazia(db):
    payload = busca_clientes(db, "zzz-nao-existe-zzz")
    assert payload["clientes"] == []


def test_busca_nao_quebra_com_curinga_de_like(db):
    """`%` e `_` são curingas do LIKE — não podem virar injeção de padrão."""
    payload = busca_clientes(db, "%")
    _serializavel(payload)
    assert isinstance(payload["clientes"], list)


def test_perfil_traz_o_conjunto_completo(db):
    codigo = db.query(
        "SELECT cliente_codigo FROM documento GROUP BY cliente_codigo"
        " ORDER BY COUNT(*) DESC LIMIT 1"
    )["cliente_codigo"][0]

    p = perfil_cliente(db, codigo)
    _serializavel(p)
    assert "erro" not in p
    assert p["cliente"]["codigo"] == codigo
    assert p["cliente"]["situacao"] in ("Ativo", "Atenção", "Em risco", "Inativo")
    for chave in ("evolucao", "top_produtos", "marcas", "compras"):
        assert isinstance(p[chave], list) and p[chave], f"{chave} veio vazio"
    assert p["kpis"]["total_comprado"] > 0
    assert p["kpis"]["pedidos"] > 0
    # Ticket tem de ser coerente com total/pedidos.
    esperado = p["kpis"]["total_comprado"] / p["kpis"]["pedidos"]
    assert abs(p["kpis"]["ticket"] - esperado) < 0.05


def test_perfil_de_cliente_inexistente_devolve_erro_e_nao_explode(db):
    p = perfil_cliente(db, "NAO-EXISTE")
    assert "erro" in p
    _serializavel(p)


def test_painel_classifica_as_tres_filas(db):
    p = painel_pedidos(db)
    _serializavel(p)
    assert [r["status"] for r in p["resumo"]] == [
        "Aguardando Faturamento", "Aguardando Conferência", "Saiu Hoje"]
    total = sum(len(p[c]) for c in
                ("aguardando_faturamento", "aguardando_conferencia", "saiu_hoje"))
    assert total == int(db.query("SELECT COUNT(*) AS n FROM fila_pedido")["n"][0])
    for fila in ("aguardando_faturamento", "aguardando_conferencia", "saiu_hoje"):
        for pedido in p[fila]:
            assert pedido["logistica"]["tipo"] in ("retira", "rota")
            assert pedido["horas_fila"] >= 0
            assert len(pedido["registro_hora"]) == 5  # HH:MM


def test_cmp_sem_filtro_soma_tudo(db):
    p = cliente_marca_produto(db, {})
    _serializavel(p)
    assert p["kpis"]["venda_liquida"] > 0
    assert p["por_cliente"] and p["por_marca"] and p["por_item"]
    assert 0 < p["kpis"]["margem"] < 100


def test_cmp_filtro_por_marca_recorta_todos_os_paineis(db):
    marca = cliente_marca_produto(db, {})["por_marca"][0]["marca"]
    total = cliente_marca_produto(db, {})
    filtrado = cliente_marca_produto(db, {"marcas": [marca]})

    assert {l["marca"] for l in filtrado["por_marca"]} == {marca}
    assert {l["marca"] for l in filtrado["por_item"]} == {marca}
    assert filtrado["kpis"]["venda_liquida"] < total["kpis"]["venda_liquida"]
    # O frete é do documento: filtrar marca não pode mudá-lo.
    assert filtrado["kpis"]["frete"] == total["kpis"]["frete"]


def test_cmp_periodo_invertido_e_corrigido(db):
    hoje = date.today()
    ontem = hoje - timedelta(days=30)
    normal = cliente_marca_produto(db, {"dt_de": ontem.isoformat(), "dt_ate": hoje.isoformat()})
    invertido = cliente_marca_produto(db, {"dt_de": hoje.isoformat(), "dt_ate": ontem.isoformat()})
    assert invertido["janela"] == normal["janela"]


def test_cmp_limita_a_janela_maxima(db):
    p = cliente_marca_produto(db, {"dt_de": "2000-01-01", "dt_ate": date.today().isoformat()})
    de = date.fromisoformat(p["janela"]["de"])
    ate = date.fromisoformat(p["janela"]["ate"])
    assert (ate - de).days <= 366


def test_cmp_indicadores_vem_do_conjunto_inteiro_nao_do_top(db):
    """A soma do top 100 de clientes tem de ser MENOR que o total."""
    p = cliente_marca_produto(db, {})
    soma_top = sum(l["venda_liquida"] for l in p["por_cliente"])
    assert soma_top <= p["kpis"]["venda_liquida"] + 0.01
