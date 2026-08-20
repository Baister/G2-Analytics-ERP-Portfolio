"""Bot de vendas — desempenho comercial do mês corrente e progresso de metas.

Duas convenções deste painel valem ser explicitadas, porque mudam todo número
que sai daqui:

1. **Faturamento vem do item, não do documento.** O documento não guarda total;
   guarda frete e a camada fiscal. Somar item é a única forma de chegar ao
   valor de mercadoria — e frete fica de fora de propósito, senão a margem
   apareceria inflada por uma receita que não tem custo de produto.
2. **Devolução é negativa na origem.** Quantidade, valor e custo já vêm com
   sinal invertido, então "líquido" é simplesmente a soma sem filtro de tipo.
   Só o KPI `faturamento_bruto` isola `tipo='venda'`; todo ranking (vendedor,
   item, marca) e o acumulado do ritmo usam o líquido, para que a soma das
   listas feche com a base do progresso de metas em vez de divergir dela.

Documento cancelado é excluído em toda consulta: ele existe na base como
registro, não como venda.
"""
from __future__ import annotations

import calendar
import logging
from datetime import date, timedelta
from typing import Any

import pandas as pd

from bots.base import BaseBot

logger = logging.getLogger(__name__)

#: Ciclo de 5 min: são nove agregações sobre o mês corrente (dezenas de
#: milhares de itens). Barato o bastante para não precisar de meia hora,
#: pesado o bastante para não valer a cada minuto — e o painel comercial é
#: lido em escala de "como estamos hoje", não de segundo a segundo.
INTERVALO_PADRAO = 300

MESES_PT = (
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
)

# Recorte comum a quase todas as consultas do mês. Fim EXCLUSIVO: comparar
# `data < primeiro-dia-do-mês-seguinte` dispensa saber quantos dias o mês tem
# e continua usando o índice de `documento(data)`.
_MES = "d.data >= ? AND d.data < ? AND d.cancelado = 0"

SQL_KPI_VENDA = f"""
    SELECT COALESCE(SUM(i.valor_total), 0.0)   AS bruto,
           COALESCE(SUM(i.custo_total), 0.0)   AS custo,
           COUNT(DISTINCT d.numero)            AS documentos,
           COUNT(DISTINCT d.cliente_codigo)    AS clientes
      FROM documento d
      JOIN item i ON i.documento_numero = d.numero
     WHERE {_MES} AND d.tipo = 'venda'
"""

SQL_KPI_DEVOLUCAO = f"""
    SELECT COALESCE(SUM(i.valor_total), 0.0) AS valor,
           COALESCE(SUM(i.custo_total), 0.0) AS custo,
           COUNT(DISTINCT d.numero)          AS documentos
      FROM documento d
      JOIN item i ON i.documento_numero = d.numero
     WHERE {_MES} AND d.tipo = 'devolucao'
"""

# Um ponto por dia com movimento. O acumulado e os buracos (fim de semana,
# feriado) são resolvidos em Python: preencher dia a dia no SQL exigiria uma
# CTE recursiva de calendário para ganhar nada.
SQL_RITMO = f"""
    SELECT d.data                            AS data,
           COALESCE(SUM(i.valor_total), 0.0) AS valor
      FROM documento d
      JOIN item i ON i.documento_numero = d.numero
     WHERE {_MES}
     GROUP BY d.data
     ORDER BY d.data
"""

# Sem LIMIT: a mesma agregação serve o top 10 e o progresso de metas, que
# precisa de todo mundo com meta. Cortar aqui obrigaria uma segunda consulta.
SQL_POR_VENDEDOR = f"""
    SELECT v.id                                AS vendedor_id,
           v.nome                              AS vendedor,
           v.meta_mensal                       AS meta,
           COALESCE(SUM(i.valor_total), 0.0)   AS valor,
           COUNT(DISTINCT CASE WHEN d.tipo = 'venda' THEN d.numero END) AS documentos
      FROM documento d
      JOIN item i ON i.documento_numero = d.numero
      JOIN vendedor v ON v.id = d.vendedor_id
     WHERE {_MES}
     GROUP BY v.id, v.nome, v.meta_mensal
     ORDER BY valor DESC
"""

SQL_POR_ITEM = f"""
    SELECT p.codigo                            AS codigo,
           p.descricao                         AS descricao,
           m.nome                              AS marca,
           COALESCE(SUM(i.quantidade), 0.0)    AS quantidade,
           COALESCE(SUM(i.valor_total), 0.0)   AS valor
      FROM documento d
      JOIN item i ON i.documento_numero = d.numero
      JOIN produto p ON p.codigo = i.produto_codigo
      JOIN marca m ON m.id = p.marca_id
     WHERE {_MES}
     GROUP BY p.codigo, p.descricao, m.nome
     ORDER BY valor DESC
     LIMIT 10
"""

# Também sem LIMIT: `total_marcas` é a contagem de linhas desta consulta
# (marcas com movimento no mês), e o top 20 sai do começo dela.
SQL_POR_MARCA = f"""
    SELECT m.nome                              AS marca,
           COALESCE(SUM(i.valor_total), 0.0)   AS valor,
           COUNT(DISTINCT d.numero)            AS documentos
      FROM documento d
      JOIN item i ON i.documento_numero = d.numero
      JOIN produto p ON p.codigo = i.produto_codigo
      JOIN marca m ON m.id = p.marca_id
     WHERE {_MES}
     GROUP BY m.nome
     ORDER BY valor DESC
"""

SQL_HOJE_POR_VENDEDOR = """
    SELECT d.vendedor_id                       AS vendedor_id,
           COALESCE(SUM(i.valor_total), 0.0)   AS valor
      FROM documento d
      JOIN item i ON i.documento_numero = d.numero
     WHERE d.data = ? AND d.cancelado = 0
     GROUP BY d.vendedor_id
"""

# Dimensões completas: alimentam os seletores da tela, não os números.
SQL_VENDEDORES = "SELECT id, nome, meta_mensal FROM vendedor ORDER BY nome"
SQL_MARCAS = "SELECT id, nome FROM marca ORDER BY nome"


# ── conversões defensivas ──────────────────────────────────────────────────
# O payload vai para JSON. pandas devolve numpy.int64/float64 e NaN, que o
# `json.dumps` padrão ou recusa (int64) ou serializa como literal inválido
# (NaN). Tudo que entra no retorno passa por um destes.
def _f(valor: Any, casas: int = 2) -> float:
    try:
        n = float(valor)
    except (TypeError, ValueError):
        return 0.0
    return round(n, casas) if n == n else 0.0  # n != n captura NaN


def _i(valor: Any) -> int:
    try:
        n = float(valor)
    except (TypeError, ValueError):
        return 0
    return int(n) if n == n else 0


def _pct(parte: float, total: float) -> float:
    """Percentual em pontos percentuais, com denominador zero devolvendo 0."""
    return round(parte / total * 100.0, 2) if total else 0.0


def _registros(df: pd.DataFrame) -> list[dict]:
    """DataFrame -> list[dict] com tipos nativos (NaN vira None)."""
    if df is None or df.empty:
        return []
    return df.astype(object).where(pd.notna(df), None).to_dict("records")


def _escalar(df: pd.DataFrame, coluna: str) -> Any:
    """Primeira célula de uma agregação — 0 se a consulta falhou (df vazio)."""
    if df is None or df.empty or coluna not in df.columns:
        return 0
    return df.iloc[0][coluna]


def _dias_uteis(inicio: date, fim: date) -> int:
    """Dias úteis no intervalo fechado [inicio, fim]. Sábado/domingo fora.

    Feriado não entra: o banco não tem calendário e chutar feriado nacional
    distorceria a meta diária mais do que ignorá-lo.
    """
    if fim < inicio:
        return 0
    return sum(
        1 for n in range((fim - inicio).days + 1)
        if (inicio + timedelta(days=n)).weekday() < 5
    )


class BotVendas(BaseBot):
    """Fecha o mês corrente em números: KPIs, rankings, ritmo e metas."""

    def __init__(self, db, cache=None, intervalo: int = INTERVALO_PADRAO):
        super().__init__("vendas", db, cache, intervalo=intervalo)

    def analisar(self) -> dict[str, Any]:
        hoje = date.today()
        primeiro = hoje.replace(day=1)
        ultimo_dia = calendar.monthrange(hoje.year, hoje.month)[1]
        fim_exclusivo = (primeiro + timedelta(days=ultimo_dia)).isoformat()
        janela = (primeiro.isoformat(), fim_exclusivo)

        # Fan-out: cada consulta que falhar vira DataFrame vazio e some do
        # payload como lista vazia/zero. Nada aqui levanta por dado ausente.
        # (o motivo da falha fica no log da base — `db.last_error` é por
        # thread e não sobrevive ao worker que a executou.)
        dfs = self.paralelo({
            "kpi_venda": (SQL_KPI_VENDA, janela),
            "kpi_devolucao": (SQL_KPI_DEVOLUCAO, janela),
            "ritmo": (SQL_RITMO, janela),
            "por_vendedor": (SQL_POR_VENDEDOR, janela),
            "por_item": (SQL_POR_ITEM, janela),
            "por_marca": (SQL_POR_MARCA, janela),
            "hoje_vendedor": (SQL_HOJE_POR_VENDEDOR, (hoje.isoformat(),)),
            "vendedores": (SQL_VENDEDORES, ()),
            "marcas": (SQL_MARCAS, ()),
        })

        # Banco fora do ar ≠ mês sem venda, e a diferença importa: a base
        # devolve o último resultado bom quando `analisar()` volta vazio, mas
        # engoliria um payload zerado como se fosse verdade — apagando o
        # painel e o cache. Sentinela: agregação sem GROUP BY sempre traz uma
        # linha, e a tabela de vendedores nunca está vazia. As duas mudas ao
        # mesmo tempo só acontece se as consultas falharam.
        if dfs.get("kpi_venda", pd.DataFrame()).empty and \
                dfs.get("vendedores", pd.DataFrame()).empty:
            logger.warning("[vendas] consultas do mês não retornaram — "
                           "mantendo o ciclo anterior")
            return {}

        kpis = self._kpis(dfs)
        marcas_mes = _registros(dfs.get("por_marca", pd.DataFrame()))
        kpis["total_marcas"] = len(marcas_mes)

        vendedores_mes = _registros(dfs.get("por_vendedor", pd.DataFrame()))
        dia_por_valor = self._valor_por_dia(dfs.get("ritmo", pd.DataFrame()))

        # Meta da empresa = soma das metas individuais. Não existe meta
        # corporativa própria na base, e somar é o único agregado que mantém
        # o ritmo coerente com o progresso por vendedor.
        metas = dfs.get("vendedores", pd.DataFrame())
        meta_empresa = _f(metas["meta_mensal"].sum()) if not metas.empty else 0.0

        uteis_total = _dias_uteis(primeiro, primeiro.replace(day=ultimo_dia))
        meta_dia_empresa = meta_empresa / uteis_total if uteis_total else 0.0

        return {
            "mes_referencia": f"{MESES_PT[hoje.month - 1]} {hoje.year}",
            "kpis": kpis,
            "vendedores": [
                {"id": _i(r["id"]), "nome": str(r["nome"])}
                for r in _registros(dfs.get("vendedores", pd.DataFrame()))
            ],
            "marcas": [
                {"id": _i(r["id"]), "nome": str(r["nome"])}
                for r in _registros(dfs.get("marcas", pd.DataFrame()))
            ],
            "ritmo": self._ritmo(
                hoje, primeiro, ultimo_dia, dia_por_valor, meta_empresa, uteis_total
            ),
            "top_vendedores": [
                {
                    "vendedor": str(r["vendedor"]),
                    "valor": _f(r["valor"]),
                    "ticket": _f(_f(r["valor"]) / _i(r["documentos"]))
                    if _i(r["documentos"]) else 0.0,
                    "documentos": _i(r["documentos"]),
                }
                for r in vendedores_mes[:10]
            ],
            "top_itens": [
                {
                    "codigo": str(r["codigo"]),
                    "descricao": str(r["descricao"]),
                    "marca": str(r["marca"]),
                    "quantidade": _f(r["quantidade"]),
                    "valor": _f(r["valor"]),
                }
                for r in _registros(dfs.get("por_item", pd.DataFrame()))
            ],
            "top_marcas": [
                {
                    "marca": str(r["marca"]),
                    "valor": _f(r["valor"]),
                    "documentos": _i(r["documentos"]),
                }
                for r in marcas_mes[:20]
            ],
            "progresso_vendedores": self._progresso_mensal(vendedores_mes),
            "progresso_diario_vendedores": self._progresso_diario_vendedores(
                hoje, primeiro.replace(day=ultimo_dia), vendedores_mes,
                dfs.get("hoje_vendedor", pd.DataFrame()),
            ),
            "progresso_diario": self._progresso_diario(
                hoje, primeiro, dia_por_valor, meta_dia_empresa
            ),
        }

    # ── blocos ─────────────────────────────────────────────────────────────
    def _kpis(self, dfs: dict[str, pd.DataFrame]) -> dict[str, Any]:
        venda = dfs.get("kpi_venda", pd.DataFrame())
        devol = dfs.get("kpi_devolucao", pd.DataFrame())

        bruto = _f(_escalar(venda, "bruto"))
        custo_venda = _f(_escalar(venda, "custo"))
        documentos = _i(_escalar(venda, "documentos"))

        # Devolução chega negativa do banco; o KPI expõe o módulo, porque a
        # tela mostra "devoluções: R$ X", não "menos X".
        devolucao = abs(_f(_escalar(devol, "valor")))
        custo_devol = abs(_f(_escalar(devol, "custo")))

        liquido = bruto - devolucao
        custo_liquido = custo_venda - custo_devol

        return {
            "faturamento_bruto": bruto,
            "devolucao_valor": devolucao,
            # Margem sobre o LÍQUIDO: devolução devolve receita e custo juntos,
            # então medir sobre o bruto premiaria quem vende e recebe de volta.
            "margem_bruta": _pct(liquido - custo_liquido, liquido),
            "ticket_medio": _f(bruto / documentos) if documentos else 0.0,
            "documentos": documentos,
            "devolucoes": _i(_escalar(devol, "documentos")),
            "clientes_ativos": _i(_escalar(venda, "clientes")),
            "total_marcas": 0,  # preenchido pelo agregado de marcas do mês
        }

    def _valor_por_dia(self, df: pd.DataFrame) -> dict[int, float]:
        """{dia do mês: faturamento líquido do dia}."""
        if df.empty or "data" not in df.columns:
            return {}
        valores: dict[int, float] = {}
        for r in _registros(df):
            texto = str(r.get("data") or "")
            if len(texto) >= 10 and texto[8:10].isdigit():
                valores[int(texto[8:10])] = _f(r.get("valor"))
        return valores

    def _ritmo(self, hoje: date, primeiro: date, ultimo_dia: int,
               por_dia: dict[int, float], meta_empresa: float,
               uteis_total: int) -> list[dict]:
        """Curva acumulada do mês contra a meta distribuída por dia útil.

        Dia futuro entra com `acumulado: None` — se entrasse com 0 ou com o
        último acumulado, a linha do gráfico ou despencaria ou viraria um
        platô horizontal falso até o fim do mês.
        """
        linhas: list[dict] = []
        acumulado = 0.0
        uteis_ate_aqui = 0
        for dia in range(1, ultimo_dia + 1):
            data = primeiro.replace(day=dia)
            if data.weekday() < 5:
                uteis_ate_aqui += 1
            meta = meta_empresa * uteis_ate_aqui / uteis_total if uteis_total else 0.0
            if dia <= hoje.day:
                acumulado += por_dia.get(dia, 0.0)
                valor: float | None = _f(acumulado)
            else:
                valor = None
            linhas.append({"dia": dia, "acumulado": valor, "meta": _f(meta)})
        return linhas

    def _progresso_mensal(self, vendedores_mes: list[dict]) -> list[dict]:
        """Realizado do mês x meta mensal. Sem meta, sem linha."""
        linhas = []
        for r in vendedores_mes:
            meta = _f(r.get("meta"))
            if meta <= 0:
                continue
            realizado = _f(r.get("valor"))
            linhas.append({
                "vendedor": str(r["vendedor"]),
                "realizado": realizado,
                "meta": meta,
                "percentual": _pct(realizado, meta),
            })
        return sorted(linhas, key=lambda l: l["percentual"], reverse=True)

    def _progresso_diario_vendedores(self, hoje: date, ultimo: date,
                                     vendedores_mes: list[dict],
                                     df_hoje: pd.DataFrame) -> list[dict]:
        """Vendido hoje x quanto o vendedor precisa fazer por dia daqui pra frente.

        A meta do dia é recalculada todo ciclo — (meta mensal − realizado) /
        dias úteis restantes — em vez de fixar meta_mensal/dias_úteis. É o
        número que muda o comportamento: quem atrasou vê a barra subir.
        """
        # Dias úteis restantes inclui HOJE: ainda dá para vender hoje. Piso 1
        # evita divisão por zero no último dia do mês (e no fim de semana).
        restantes = max(1, _dias_uteis(hoje, ultimo))

        vendido_hoje: dict[int, float] = {}
        for r in _registros(df_hoje):
            vendido_hoje[_i(r.get("vendedor_id"))] = _f(r.get("valor"))

        linhas = []
        for r in vendedores_mes:
            meta_mensal = _f(r.get("meta"))
            if meta_mensal <= 0:
                continue
            falta = meta_mensal - _f(r.get("valor"))
            # Meta batida: a meta do dia zera em vez de virar negativa, e o
            # percentual vai a 100 — a barra fica cheia, que é o que o dado diz.
            meta_dia = _f(max(0.0, falta) / restantes)
            realizado = _f(vendido_hoje.get(_i(r.get("vendedor_id")), 0.0))
            linhas.append({
                "vendedor": str(r["vendedor"]),
                "realizado": realizado,
                "meta": meta_dia,
                "percentual": _pct(realizado, meta_dia) if meta_dia > 0 else 100.0,
            })
        return sorted(linhas, key=lambda l: l["percentual"], reverse=True)

    def _progresso_diario(self, hoje: date, primeiro: date,
                          por_dia: dict[int, float],
                          meta_dia_empresa: float) -> list[dict]:
        """Dia a dia do mês até hoje. Fim de semana entra com meta zero.

        Manter sábado e domingo na série (em vez de omitir) preserva o
        espaçamento real do eixo; a meta zerada mostra que ali não se cobrava
        nada, e não que o dia foi ruim.
        """
        linhas = []
        for dia in range(1, hoje.day + 1):
            data = primeiro.replace(day=dia)
            meta = _f(meta_dia_empresa) if data.weekday() < 5 else 0.0
            realizado = _f(por_dia.get(dia, 0.0))
            linhas.append({
                "dia": dia,
                "data": data.isoformat(),
                "meta_dia": meta,
                "realizado": realizado,
                "percentual": _pct(realizado, meta),
            })
        return linhas
