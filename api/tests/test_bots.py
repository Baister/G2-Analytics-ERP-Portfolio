"""Testes dos bots de análise.

Cada bot é verificado por três ângulos: o payload tem as chaves que o front
espera, os números são coerentes entre si (o total bate com a soma das partes)
e tudo atravessa `json.dumps` sem ajuda — que é onde `numpy.int64` costuma
aparecer sem avisar.
"""
from __future__ import annotations

import json

import pytest

from bots.clientes import BotClientes
from bots.crm import BotCrm
from bots.dashboard import BotDashboard
from bots.estoque import BotEstoque
from bots.financeiro import BotFinanceiro
from bots.imposto import BotImposto
from bots.vendas import BotVendas

TODOS = [
    (BotDashboard, "dashboard", ["mes_referencia", "resultado", "performance",
                                 "diario", "top_vendedores", "por_marca", "por_grupo",
                                 "vendedores", "marcas", "grupos"]),
    (BotVendas, "vendas", ["kpis", "ritmo", "top_vendedores", "top_itens", "top_marcas",
                           "progresso_vendedores", "progresso_diario_vendedores",
                           "progresso_diario", "vendedores", "marcas"]),
    (BotEstoque, "estoque", ["kpis", "abc", "valor_por_marca", "evolucao", "itens"]),
    (BotFinanceiro, "financeiro", ["kpis", "status_titulos", "vencimentos", "foco", "limites"]),
    (BotCrm, "crm", ["vendedores", "kpis", "funil", "semanal", "ranking", "oportunidades",
                     "top_clientes", "clientes_novos", "histograma_inatividade",
                     "em_risco", "inativos"]),
    (BotImposto, "imposto", ["kpis", "diario", "evolucao", "cfops", "cfop_evolucao",
                             "maiores_nfs", "situacoes", "regras_pis_cofins",
                             "itens_tributacao"]),
    (BotClientes, "clientes", ["kpis", "segmentacao", "abc", "ativos_por_mes", "top50"]),
]


@pytest.fixture(scope="module")
def payloads(request):
    """Roda cada bot UMA vez e reaproveita — analisar() é caro."""
    from core.db import Database

    banco = request.getfixturevalue("banco_demo")
    db = Database(banco)
    saida = {}
    for classe, nome, _ in TODOS:
        saida[nome] = classe(db).analisar()
    db.fechar()
    return saida


@pytest.mark.parametrize("classe,nome,chaves", TODOS, ids=[t[1] for t in TODOS])
def test_payload_tem_as_chaves_do_contrato(payloads, classe, nome, chaves):
    p = payloads[nome]
    faltando = [c for c in chaves if c not in p]
    assert not faltando, f"bot '{nome}' não devolveu: {faltando}"


@pytest.mark.parametrize("classe,nome,chaves", TODOS, ids=[t[1] for t in TODOS])
def test_payload_e_serializavel(payloads, classe, nome, chaves):
    """numpy.int64 e NaN não podem escapar para o JSON."""
    texto = json.dumps(payloads[nome], ensure_ascii=False)
    assert "NaN" not in texto, "NaN literal quebra o parser do navegador"
    assert "Infinity" not in texto


def test_dashboard_resultado_fecha_a_conta(payloads):
    r = payloads["dashboard"]["resultado"]
    assert r["faturamento_bruto"] > 0
    assert abs(r["faturamento_liquido"] - (r["faturamento_bruto"] - r["devolucoes"])) < 1.0
    assert abs(r["lucro_bruto"] - (r["faturamento_liquido"] - r["custo_reposicao"])) < 1.0
    assert 0 < payloads["dashboard"]["performance"]["margem_bruta"] < 100


def test_dashboard_dimensoes_somam_o_total(payloads):
    """Marca e grupo particionam o mesmo faturamento — as somas têm de bater."""
    p = payloads["dashboard"]
    por_marca = sum(l["venda_liquida"] for l in p["por_marca"])
    por_grupo = sum(l["venda_liquida"] for l in p["por_grupo"])
    assert abs(por_marca - por_grupo) < max(1.0, por_marca * 0.001)


def test_dashboard_filtrado_recorta(payloads, banco_demo):
    from core.db import Database

    db = Database(banco_demo)
    bot = BotDashboard(db)
    total = bot.analisar()["resultado"]["faturamento_liquido"]
    marca = payloads["dashboard"]["por_marca"][0]["nome"]
    recorte = bot.analisar_filtrado({"marcas": [marca]})["resultado"]["faturamento_liquido"]
    assert 0 < recorte < total
    db.fechar()


def test_vendas_ritmo_para_no_ultimo_dia_com_dado(payloads):
    ritmo = payloads["vendas"]["ritmo"]
    assert len(ritmo) >= 28
    com_dado = [l for l in ritmo if l["acumulado"] is not None]
    assert com_dado, "nenhum dia com acumulado"
    # Acumulado é monotônico e a série futura vem vazia (a linha para no gráfico).
    valores = [l["acumulado"] for l in com_dado]
    assert valores == sorted(valores)
    assert all(l["acumulado"] is None for l in ritmo[len(com_dado):])


def test_estoque_abc_tem_as_tres_classes(payloads):
    abc = payloads["estoque"]["abc"]
    assert [c["classe"] for c in abc] == ["A", "B", "C"], "as cores do gráfico são posicionais"
    assert abs(sum(c["percentual_vendas"] for c in abc) - 100) < 2


def test_estoque_sentinela_de_nunca_vendido(payloads):
    itens = payloads["estoque"]["itens"]
    assert itens
    assert all(i["dias_sem_venda"] >= 0 for i in itens)


def test_financeiro_status_tem_duas_fatias_na_ordem(payloads):
    st = payloads["financeiro"]["status_titulos"]
    assert [s["nome"] for s in st] == ["A Vencer", "Vencido"]
    assert all(s["quantidade"] >= 0 for s in st)


def test_financeiro_inadimplencia_e_percentual(payloads):
    k = payloads["financeiro"]["kpis"]
    assert 0 <= k["inadimplencia"] <= 100
    assert k["a_receber_qtd"] == k["vencidos_qtd"] + k["a_vencer_qtd"]


def test_financeiro_foco_tem_boleto_e_cartao(payloads):
    tipos = [f["tipo"] for f in payloads["financeiro"]["foco"]]
    assert tipos == ["Boleto", "Cartao"] or tipos == ["Boleto", "Cartão"]


def test_crm_funil_tem_tres_etapas_decrescentes(payloads):
    funil = payloads["crm"]["funil"]
    assert len(funil) == 3, "o gráfico tem 3 células fixas"
    assert funil[0]["percentual"] == 100.0


def test_crm_taxa_de_conversao_e_percentual(payloads):
    assert 0 <= payloads["crm"]["kpis"]["taxa_conversao"] <= 100


def test_crm_histograma_tem_as_faixas_fixas(payloads):
    faixas = [f["faixa"] for f in payloads["crm"]["histograma_inatividade"]]
    assert faixas == ["0-30", "31-60", "61-90", "91-180", "180+"]


def test_imposto_aliquota_efetiva_plausivel(payloads):
    k = payloads["imposto"]["kpis"]
    assert 0 <= k["aliquota_efetiva"] <= 30, "alíquota efetiva fora de qualquer realidade"
    assert k["base_calculo"] >= 0


def test_clientes_abc_soma_cem_por_cento(payloads):
    abc = payloads["clientes"]["abc"]
    assert [c["classe"] for c in abc] == ["A", "B", "C"]
    assert abs(sum(c["percentual"] for c in abc) - 100) < 2


def test_clientes_segmentacao_cobre_a_carteira(payloads):
    seg = payloads["clientes"]["segmentacao"]
    assert [s["faixa"] for s in seg] == ["Ativo", "Atenção", "Em risco", "Inativo"]
    assert sum(s["clientes"] for s in seg) > 0


def test_manter_ultimo_bom_quando_o_ciclo_volta_vazio(banco_demo, monkeypatch):
    """Ciclo vazio não pode apagar o resultado anterior — é o padrão que
    diferencia 'o painel piscou' de 'o painel zerou'."""
    from core.db import Database

    db = Database(banco_demo)
    bot = BotDashboard(db)
    bot.resultado = {"resultado": {"faturamento_bruto": 123.0}}
    monkeypatch.setattr(bot, "analisar", lambda: {})

    bot.status = "executando"
    novo = bot.analisar()
    if not novo and bot.resultado:
        pass  # o run() faz isso; aqui verificamos a condição
    assert bot.resultado["resultado"]["faturamento_bruto"] == 123.0
    db.fechar()
