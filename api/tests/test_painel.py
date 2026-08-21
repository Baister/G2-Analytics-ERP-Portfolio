"""Testes do painel operacional — a tela mais sensível à passagem do tempo.

O telão do balcão só mostra pedidos registrados HOJE. Como o dataset é gerado
uma vez e a demonstração roda em qualquer dia, a fila precisa acompanhar a data
atual — senão a tela aparece vazia no dia seguinte ao da geração, que foi
exatamente o defeito que motivou estes testes.
"""
from __future__ import annotations

from datetime import date

from consultas import painel_pedidos

FILAS = ("aguardando_faturamento", "aguardando_conferencia", "saiu_hoje")


def test_fila_e_sempre_do_dia_atual(db):
    """Independe de quando o banco foi gerado."""
    p = painel_pedidos(db)
    hoje = date.today().isoformat()
    assert p["hoje"] == hoje

    pedidos = [x for fila in FILAS for x in p[fila]]
    assert pedidos, "nenhum pedido na fila"
    fora = [x["pedido"] for x in pedidos if x["registro_iso"] != hoje]
    assert not fora, (
        f"{len(fora)} pedido(s) com data diferente de hoje — o telão os "
        f"descartaria e a tela ficaria vazia: {fora[:5]}"
    )


def test_horario_de_registro_e_preservado(db):
    """O deslocamento muda o dia, nunca a hora — o telão filtra 08:00–18:00."""
    p = painel_pedidos(db)
    for fila in FILAS:
        for x in p[fila]:
            hora = x["registro_hora"]
            assert len(hora) == 5 and hora[2] == ":", f"hora malformada: {hora!r}"
            assert "08:00" <= hora < "18:00", f"registro fora do expediente: {hora}"


def test_telao_encontra_pedidos_de_retirada(db):
    """Reproduz o filtro exato da tela do balcão."""
    p = painel_pedidos(db)
    hoje = date.today().isoformat()
    do_telao = [
        x for fila in FILAS for x in p[fila]
        if x["logistica"]["tipo"] == "retira"
        and x["registro_iso"] == hoje
        and "08:00" <= x["registro_hora"] < "18:00"
    ]
    assert do_telao, "o telão de retirada ficaria vazio"


def test_entrega_vencida_sobrevive_ao_deslocamento(db):
    """Deslocar as datas não pode inventar nem apagar atraso de entrega."""
    p = painel_pedidos(db)
    hoje = date.today().isoformat()
    for fila in FILAS:
        for x in p[fila]:
            esperado = bool(x["entrega"] and x["entrega"] < hoje)
            assert x["entrega_vencida"] == esperado, (
                f"pedido {x['pedido']}: entrega {x['entrega']} marcada como "
                f"vencida={x['entrega_vencida']}"
            )


def test_resumo_bate_com_as_filas(db):
    p = painel_pedidos(db)
    rotulos = {
        "Aguardando Faturamento": "aguardando_faturamento",
        "Aguardando Conferência": "aguardando_conferencia",
        "Saiu Hoje": "saiu_hoje",
    }
    for linha in p["resumo"]:
        fila = rotulos[linha["status"]]
        assert linha["pedidos"] == len(p[fila])
        assert abs(linha["valor"] - sum(x["valor"] for x in p[fila])) < 0.01


def test_horas_na_fila_nunca_sao_negativas(db):
    p = painel_pedidos(db)
    for fila in FILAS:
        for x in p[fila]:
            assert x["horas_fila"] >= 0
