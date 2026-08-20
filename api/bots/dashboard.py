"""Painel executivo do mês corrente.

Responde à pergunta que o dono do negócio faz todo dia de manhã: *quanto já
vendemos no mês, com que margem, e quanto falta por dia para bater a meta*.

Duas entradas para o mesmo payload:

* `analisar()` — mês corrente, sem recorte. É o que a thread do bot publica em
  ciclo e o que vai para o cache.
* `analisar_filtrado(filtros)` — mesmo formato, janela e recorte livres.
  Consulta sob demanda: não escreve em `self.resultado` nem no cache, senão o
  filtro de um usuário contaminaria o painel de todos os outros.

Convenções de cálculo adotadas aqui (valem para o payload inteiro):

* Item de devolução já vem **negativo** do banco. Por isso o líquido é uma soma
  simples sobre documentos não cancelados: venda e devolução se compensam sem
  precisar de subtração explícita.
* Documento cancelado não entra em faturamento, custo, margem nem ticket — sai
  em `documentos_cancelados`, isolado, porque é indicador de processo e não de
  receita.
* Filtro de marca/grupo é recorte de **item**, não de documento: um pedido misto
  contribui só com as linhas da marca escolhida.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Any

import pandas as pd

from bots.base import BaseBot

#: ciclo do bot. O painel é do mês inteiro — cinco minutos de defasagem não
#: mudam decisão nenhuma, e o custo do fan-out não justifica menos que isso.
INTERVALO_PADRAO = 300

TOP_VENDEDORES = 10

#: teto de itens aceitos por filtro. Evita montar um `IN` com a lista inteira
#: caso o front mande "todos selecionados" em vez de mandar nada.
LIMITE_FILTRO = 200

MESES_PT = (
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
)


# ── conversões para JSON ───────────────────────────────────────────────────
# O payload atravessa `json.dumps`. Tudo que vem do pandas (numpy.int64,
# numpy.float64, NaN, None) precisa virar tipo nativo antes de sair daqui.

def _f(valor: Any, casas: int = 2) -> float:
    """Float nativo e arredondado; NaN/None/lixo viram 0.0."""
    try:
        n = float(valor)
    except (TypeError, ValueError):
        return 0.0
    if n != n or n in (float("inf"), float("-inf")):  # NaN e infinito
        return 0.0
    return round(n, casas)


def _i(valor: Any) -> int:
    try:
        n = float(valor)
    except (TypeError, ValueError):
        return 0
    if n != n:
        return 0
    return int(n)


def _div(numerador: float, denominador: float, casas: int = 2) -> float:
    """Divisão protegida — denominador zero devolve 0.0, não explode o painel."""
    if not denominador:
        return 0.0
    return round(numerador / denominador, casas)


def _pct(parte: float, todo: float) -> float:
    """Percentual em pontos percentuais (23.7 = 23,7%)."""
    return _div(parte * 100.0, todo)


def _uma_linha(df: pd.DataFrame) -> dict[str, Any]:
    """Primeira linha de um agregado como dict; DataFrame vazio vira {}."""
    if df is None or df.empty:
        return {}
    return df.iloc[0].to_dict()


# ── datas ──────────────────────────────────────────────────────────────────

def _para_data(valor: Any) -> date | None:
    """Aceita 'YYYY-MM-DD' (com ou sem hora colada). Inválido vira None."""
    if isinstance(valor, date):
        return valor
    if not valor:
        return None
    try:
        return date.fromisoformat(str(valor)[:10])
    except ValueError:
        return None


def _fim_do_mes(d: date) -> date:
    """Último dia do mês de `d` — via primeiro dia do mês seguinte menos um."""
    if d.month == 12:
        seguinte = d.replace(year=d.year + 1, month=1, day=1)
    else:
        seguinte = d.replace(month=d.month + 1, day=1)
    return seguinte - timedelta(days=1)


def _dias_uteis(de: date, ate: date) -> int:
    """Segunda a sexta no intervalo fechado. Intervalo invertido conta zero."""
    if ate < de:
        return 0
    total = 0
    d = de
    while d <= ate:
        if d.weekday() < 5:
            total += 1
        d += timedelta(days=1)
    return total


def _mes_referencia(de: date, ate: date) -> str:
    if (de.year, de.month) == (ate.year, ate.month):
        return f"{MESES_PT[ate.month - 1]} {ate.year}"
    if de.year == ate.year:
        return f"{MESES_PT[de.month - 1]} a {MESES_PT[ate.month - 1]} {ate.year}"
    return (f"{MESES_PT[de.month - 1]} {de.year} a "
            f"{MESES_PT[ate.month - 1]} {ate.year}")


# ── montagem de filtros ────────────────────────────────────────────────────

def _valores(bruto: Any) -> list[str]:
    """Normaliza o que veio do front numa lista de textos não vazios."""
    if bruto is None:
        return []
    if isinstance(bruto, (str, bytes)):
        bruto = [bruto]
    if not isinstance(bruto, (list, tuple, set, frozenset)):
        return []
    limpos = [str(v).strip() for v in bruto if v is not None and str(v).strip()]
    return limpos[:LIMITE_FILTRO]


def _in_nome_ou_id(col_nome: str, col_id: str, valores: list[str]) -> tuple[str, list[str]]:
    """Fragmento `IN` que casa por nome **ou** por id.

    O catálogo do payload manda `{id, nome}` e cada front escolhe o que devolve
    no filtro. Aceitar os dois evita que uma mudança de contrato na interface
    zere o painel silenciosamente — o custo é duplicar os parâmetros.
    """
    marcas = ",".join("?" * len(valores))
    frag = f"({col_nome} IN ({marcas}) OR CAST({col_id} AS TEXT) IN ({marcas}))"
    return frag, valores + valores


# ── consultas ──────────────────────────────────────────────────────────────
# Uma consulta por string, sempre um único SELECT: é o que o guarda de SQL
# aceita. O `{where}` é montado só com fragmentos parametrizados — nenhum valor
# de usuário entra no texto.

_SQL_RESUMO = """
SELECT
    SUM(CASE WHEN d.tipo = 'venda'     AND d.cancelado = 0 THEN i.valor_total ELSE 0 END) AS bruto,
    SUM(CASE WHEN d.tipo = 'devolucao' AND d.cancelado = 0 THEN i.valor_total ELSE 0 END) AS devolucoes,
    SUM(CASE WHEN d.cancelado = 1 THEN i.valor_total ELSE 0 END) AS cancelados,
    SUM(CASE WHEN d.cancelado = 0 THEN i.custo_total  ELSE 0 END) AS custo,
    COUNT(DISTINCT CASE WHEN d.tipo = 'venda'     AND d.cancelado = 0 THEN d.numero END) AS qtd_vendas,
    COUNT(DISTINCT CASE WHEN d.tipo = 'devolucao' AND d.cancelado = 0 THEN d.numero END) AS qtd_devolucoes
FROM item i
JOIN documento d ON d.numero = i.documento_numero
WHERE {where}
"""

_SQL_DIARIO = """
SELECT d.data AS data, SUM(i.valor_total) AS valor
FROM item i
JOIN documento d ON d.numero = i.documento_numero
WHERE d.cancelado = 0 AND {where}
GROUP BY d.data
ORDER BY d.data
"""

_SQL_TOP_VENDEDORES = """
SELECT
    v.nome AS vendedor,
    SUM(i.valor_total) AS valor,
    COUNT(DISTINCT CASE WHEN d.tipo = 'venda' THEN d.numero END) AS documentos
FROM item i
JOIN documento d ON d.numero = i.documento_numero
JOIN vendedor v  ON v.id = d.vendedor_id
WHERE d.cancelado = 0 AND {where}
GROUP BY v.nome
ORDER BY valor DESC
LIMIT {limite}
"""

# Marca e grupo compartilham a forma: muda a dimensão do join e o rótulo.
_SQL_POR_DIMENSAO = """
SELECT
    x.nome AS nome,
    SUM(i.valor_total) AS venda_liquida,
    SUM(i.custo_total) AS custo_reposicao,
    SUM(i.quantidade)  AS quantidade
FROM item i
JOIN documento d ON d.numero = i.documento_numero
JOIN produto p   ON p.codigo = i.produto_codigo
JOIN {tabela} x  ON x.id = p.{coluna}
WHERE d.cancelado = 0 AND {where}
GROUP BY x.nome
ORDER BY venda_liquida DESC
"""

_SQL_FRETE = """
SELECT SUM(d.frete) AS frete
FROM documento d
WHERE d.cancelado = 0 AND d.tipo = 'venda' AND {where}
"""


class BotDashboard(BaseBot):
    """Agrega o resultado do mês: faturamento, margem, meta e quebras."""

    def __init__(self, db, cache=None, intervalo: int = INTERVALO_PADRAO):
        super().__init__("dashboard", db, cache, intervalo=intervalo)

    # ── entradas ───────────────────────────────────────────────────────────
    def analisar(self) -> dict:
        hoje = date.today()
        return self._montar(hoje.replace(day=1), hoje, {})

    def analisar_filtrado(self, filtros: dict[str, Any] | None = None) -> dict:
        """Mesmo payload, com recorte de data/vendedor/marca/grupo.

        Sob demanda: não publica resultado nem grava cache.
        """
        filtros = filtros or {}
        hoje = date.today()
        de = _para_data(filtros.get("dt_de")) or hoje.replace(day=1)
        ate = _para_data(filtros.get("dt_ate")) or hoje
        if ate < de:
            # Janela invertida é erro de digitação no front, não motivo para o
            # painel voltar vazio.
            de, ate = ate, de
        return self._montar(de, ate, filtros)

    # ── recorte ────────────────────────────────────────────────────────────
    def _recorte(self, de: date, ate: date, filtros: dict[str, Any]) -> tuple[
        list[str], list[Any], list[str], list[Any]
    ]:
        """Devolve (cond_documento, params_doc, cond_item, params_item).

        As condições de documento valem para qualquer consulta; as de item só
        existem quando há filtro de marca/grupo, e viram `EXISTS` nas consultas
        que não passam pela tabela de itens.
        """
        cond_doc: list[str] = ["d.data >= ?", "d.data <= ?"]
        par_doc: list[Any] = [de.isoformat(), ate.isoformat()]

        vendedores = _valores(filtros.get("vendedores"))
        if vendedores:
            frag, par = _in_nome_ou_id("v.nome", "v.id", vendedores)
            cond_doc.append(
                f"d.vendedor_id IN (SELECT v.id FROM vendedor v WHERE {frag})"
            )
            par_doc += par

        cond_item: list[str] = []
        par_item: list[Any] = []
        for chave, tabela, coluna in (
            ("marcas", "marca", "marca_id"),
            ("grupos", "grupo", "grupo_id"),
        ):
            valores = _valores(filtros.get(chave))
            if not valores:
                continue
            frag, par = _in_nome_ou_id("x.nome", "x.id", valores)
            cond_item.append(
                f"i.produto_codigo IN ("
                f"SELECT p.codigo FROM produto p "
                f"JOIN {tabela} x ON x.id = p.{coluna} WHERE {frag})"
            )
            par_item += par

        return cond_doc, par_doc, cond_item, par_item

    # ── ciclo ──────────────────────────────────────────────────────────────
    def _montar(self, de: date, ate: date, filtros: dict[str, Any]) -> dict:
        cond_doc, par_doc, cond_item, par_item = self._recorte(de, ate, filtros)

        where_item = " AND ".join(cond_doc + cond_item)
        par_full = par_doc + par_item

        # No nível de documento o recorte de item vira EXISTS: o frete é do
        # documento inteiro, não rateável por linha. O EXISTS carrega os
        # parâmetros de item junto — daí `par_frete` e não `par_doc`.
        cond_frete = list(cond_doc)
        par_frete = list(par_doc)
        if cond_item:
            cond_frete.append(
                "EXISTS (SELECT 1 FROM item i WHERE i.documento_numero = d.numero"
                f" AND {' AND '.join(cond_item)})"
            )
            par_frete += par_item
        where_frete = " AND ".join(cond_frete)

        # A meta acompanha o recorte de vendedor: comparar o realizado de três
        # vendedores contra a meta da empresa inteira não diria nada.
        cond_meta, par_meta = "", []
        vendedores = _valores(filtros.get("vendedores"))
        if vendedores:
            frag, par = _in_nome_ou_id("v.nome", "v.id", vendedores)
            cond_meta, par_meta = f" WHERE {frag}", par

        consultas: dict[str, tuple[str, tuple]] = {
            "resumo": (_SQL_RESUMO.format(where=where_item), tuple(par_full)),
            "diario": (_SQL_DIARIO.format(where=where_item), tuple(par_full)),
            "vendedores": (
                _SQL_TOP_VENDEDORES.format(where=where_item, limite=TOP_VENDEDORES),
                tuple(par_full),
            ),
            "por_marca": (
                _SQL_POR_DIMENSAO.format(tabela="marca", coluna="marca_id", where=where_item),
                tuple(par_full),
            ),
            "por_grupo": (
                _SQL_POR_DIMENSAO.format(tabela="grupo", coluna="grupo_id", where=where_item),
                tuple(par_full),
            ),
            "frete": (_SQL_FRETE.format(where=where_frete), tuple(par_frete)),
            "meta": (
                f"SELECT SUM(v.meta_mensal) AS meta FROM vendedor v{cond_meta}",
                tuple(par_meta),
            ),
            # Catálogos saem sempre completos: eles alimentam os seletores da
            # tela, e um seletor filtrado por ele mesmo não teria como voltar.
            "cat_vendedores": ("SELECT id, nome FROM vendedor ORDER BY nome", ()),
            "cat_marcas": ("SELECT id, nome FROM marca ORDER BY nome", ()),
            "cat_grupos": ("SELECT id, nome FROM grupo ORDER BY nome", ()),
        }
        dfs = self.paralelo(consultas)

        resumo = _uma_linha(dfs.get("resumo", pd.DataFrame()))
        bruto = _f(resumo.get("bruto"))
        devolucoes = abs(_f(resumo.get("devolucoes")))
        liquido = round(bruto - devolucoes, 2)
        custo = _f(resumo.get("custo"))
        lucro = round(liquido - custo, 2)
        qtd_vendas = _i(resumo.get("qtd_vendas"))

        meta = _f(_uma_linha(dfs.get("meta", pd.DataFrame())).get("meta"))
        frete = _f(_uma_linha(dfs.get("frete", pd.DataFrame())).get("frete"))

        return {
            "mes_referencia": _mes_referencia(de, ate),
            "janela": {"de": de.isoformat(), "ate": ate.isoformat()},
            "vendedores": self._catalogo(dfs.get("cat_vendedores")),
            "marcas": self._catalogo(dfs.get("cat_marcas")),
            "grupos": self._catalogo(dfs.get("cat_grupos")),
            "resultado": {
                "faturamento_bruto": bruto,
                "devolucoes": devolucoes,
                "documentos_cancelados": _f(resumo.get("cancelados")),
                "faturamento_liquido": liquido,
                "qtd_vendas": qtd_vendas,
                "qtd_devolucoes": _i(resumo.get("qtd_devolucoes")),
                "lucro_bruto": lucro,
                "custo_reposicao": custo,
            },
            "performance": {
                "percentual_meta": _pct(liquido, meta),
                "meta_do_dia": self._meta_do_dia(meta, liquido, de, ate),
                "margem_bruta": _pct(lucro, liquido),
                "ticket_medio": _div(liquido, qtd_vendas),
                "frete": frete,
            },
            "diario": self._diario(dfs.get("diario")),
            "top_vendedores": self._top_vendedores(dfs.get("vendedores")),
            "por_marca": self._por_dimensao(dfs.get("por_marca")),
            "por_grupo": self._por_dimensao(dfs.get("por_grupo")),
        }

    # ── blocos do payload ──────────────────────────────────────────────────
    @staticmethod
    def _catalogo(df: pd.DataFrame | None) -> list[dict[str, str]]:
        if df is None or df.empty:
            return []
        return [{"id": str(_i(r.id)), "nome": str(r.nome)}
                for r in df.itertuples(index=False)]

    @staticmethod
    def _meta_do_dia(meta: float, liquido: float, de: date, ate: date) -> float:
        """Quanto falta por dia útil até o fim do mês para fechar a meta.

        O divisor conta até o fim do **mês** da janela, não até o fim da janela:
        a pergunta é sempre "quanto por dia até o mês fechar". Janela já
        encerrada (ou meta batida) devolve 0.0 — não há mais dia para recuperar.
        """
        falta = meta - liquido
        if falta <= 0:
            return 0.0
        hoje = date.today()
        inicio = max(hoje, de)
        dias = _dias_uteis(inicio, _fim_do_mes(ate))
        return _div(falta, dias)

    @staticmethod
    def _diario(df: pd.DataFrame | None) -> list[dict[str, Any]]:
        """Faturamento líquido por dia. Só dias com movimento — dia sem venda
        não vira linha zerada para não inventar ponto no gráfico."""
        if df is None or df.empty:
            return []
        linhas: list[dict[str, Any]] = []
        for r in df.itertuples(index=False):
            data = str(r.data)[:10]
            dia = _para_data(data)
            if dia is None:
                continue
            linhas.append({"dia": dia.day, "data": data, "valor": _f(r.valor)})
        return linhas

    @staticmethod
    def _top_vendedores(df: pd.DataFrame | None) -> list[dict[str, Any]]:
        if df is None or df.empty:
            return []
        saida: list[dict[str, Any]] = []
        for r in df.itertuples(index=False):
            valor = _f(r.valor)
            docs = _i(r.documentos)
            saida.append({
                "vendedor": str(r.vendedor),
                "valor": valor,
                "ticket": _div(valor, docs),
                "documentos": docs,
            })
        return saida

    @staticmethod
    def _por_dimensao(df: pd.DataFrame | None) -> list[dict[str, Any]]:
        if df is None or df.empty:
            return []
        saida: list[dict[str, Any]] = []
        for r in df.itertuples(index=False):
            venda = _f(r.venda_liquida)
            custo = _f(r.custo_reposicao)
            lucro = round(venda - custo, 2)
            saida.append({
                "nome": str(r.nome),
                "venda_liquida": venda,
                "custo_reposicao": custo,
                "lucro_bruto": lucro,
                "margem": _pct(lucro, venda),
                "quantidade": _f(r.quantidade, 3),
            })
        return saida
