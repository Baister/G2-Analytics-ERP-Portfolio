"""Bot fiscal — apuração de ICMS/ST/IPI do mês corrente.

O painel responde ao que a contabilidade pergunta no meio do mês: *quanto de
imposto já se acumulou*, *em que ritmo* e *de onde ele vem* (CFOP, CST, produto).

Convenções que valem para o arquivo inteiro:

* **Documento cancelado não existe aqui.** Nota cancelada não gera débito nem
  entra em livro fiscal, então `cancelado = 0` é filtro de todas as consultas.
* **Devolução entra com sinal negativo e é isso que se quer.** No modelo, item
  e colunas fiscais de um documento de devolução já vêm negativos, então somar
  venda + devolução produz exatamente a apuração líquida do período — o crédito
  da devolução se abate sozinho, sem CASE nenhum.
* **Uma exceção deliberada ao líquido: `icms_st_destacado`.** "Destacado" é o
  que saiu escrito nas notas de saída; o crédito da devolução não é destaque, é
  estorno. Por isso esse KPI olha só `tipo = 'venda'` enquanto `st_outras` traz
  o líquido. A diferença entre os dois é, na prática, o ST devolvido no mês.
* **A alíquota efetiva é `icms / base`, não `icms / faturamento`.** Item isento
  ou com ST não compõe base de cálculo; dividir pelo faturamento inteiro daria
  um número menor e sem significado fiscal.

Duas decisões de leitura que o esquema obriga e merecem registro:

1. **`isentas_ipi` é medida por documento, não por item.** O IPI só existe
   agregado na nota (`documento.valor_ipi`); não há rateio por item. O que dá
   para afirmar com honestidade é *quanto foi faturado em notas que não
   destacaram IPI* — e é isso que o KPI mede.
2. **`isentas_icms` é medida por item**, via CST do produto, porque aí existe a
   granularidade: uma mesma nota mistura item tributado e item com ST.
"""
from __future__ import annotations

import logging
from datetime import date
from typing import Any

import pandas as pd

from bots.base import BaseBot

logger = logging.getLogger(__name__)

#: Ciclo de 10 min. Apuração fiscal é leitura de fechamento, não de operação:
#: ninguém decide nada em cima do ICMS que entrou nos últimos cinco minutos. O
#: custo também pede folga — a evolução varre doze meses de documentos.
INTERVALO_PADRAO = 600

MESES_ABREV = (
    "jan.", "fev.", "mar.", "abr.", "mai.", "jun.",
    "jul.", "ago.", "set.", "out.", "nov.", "dez.",
)

#: Janelas das séries históricas, em meses (inclui o mês corrente).
MESES_EVOLUCAO = 12
MESES_CFOP = 6

#: Tetos de lista — o payload é um resumo navegável, não um livro fiscal.
MAX_NFS = 10
MAX_ITENS = 100

#: CSTs sem débito próprio de ICMS: isenta, não tributada e mercadoria já
#: tributada por substituição na entrada. O valor delas aparece na coluna
#: "isentas/outras" do livro, fora da base de cálculo.
CST_SEM_DEBITO = ("040", "041", "060")

#: Rótulos seguindo a tabela oficial de CST/CSOSN. Vale notar que o gerador do
#: banco de demonstração atribui alíquota de 7% ao código 102 — no mundo real
#: um contribuinte do Simples não destaca ICMS assim. O rótulo segue a tabela
#: de verdade; quem lê o painel reconhece o código.
CST_NOMES: dict[str, str] = {
    "000": "000 - Tributada integralmente",
    "010": "010 - Tributada com cobrança de ST",
    "020": "020 - Com redução de base de cálculo",
    "040": "040 - Isenta",
    "041": "041 - Não tributada",
    "050": "050 - Suspensão",
    "051": "051 - Diferimento",
    "060": "060 - ICMS cobrado anteriormente por ST",
    "070": "070 - Redução de base com cobrança de ST",
    "090": "090 - Outras",
    "102": "102 - Simples Nacional sem permissão de crédito",
}

#: CFOP: o primeiro dígito diz o destino (5 = mesmo estado, 6 = outro estado) e
#: o restante, a natureza. Só quatro combinações existem nesta operação.
CFOP_NOMES: dict[str, str] = {
    "5102": "5102 - Venda dentro do estado",
    "6102": "6102 - Venda interestadual",
    "5202": "5202 - Devolução dentro do estado",
    "6202": "6202 - Devolução interestadual",
}


# ── conversões para JSON ───────────────────────────────────────────────────
# pandas devolve numpy.int64/float64 e NaN: o primeiro o json.dumps recusa, o
# segundo ele serializa como literal inválido. Tudo que entra no payload passa
# por um destes.
def _f(valor: Any, casas: int = 2) -> float:
    try:
        n = float(valor)
    except (TypeError, ValueError):
        return 0.0
    if n != n or n in (float("inf"), float("-inf")):   # NaN e infinitos
        return 0.0
    return round(n, casas)


def _i(valor: Any) -> int:
    try:
        n = float(valor)
    except (TypeError, ValueError):
        return 0
    return int(n) if n == n else 0


def _pct(parte: float, todo: float) -> float:
    """Percentual em pontos percentuais (23.7 = 23,7%); denominador zero → 0."""
    return round(parte * 100.0 / todo, 2) if todo else 0.0


def _primeiro_do_mes(referencia: date, meses_atras: int) -> date:
    """Primeiro dia do mês `meses_atras` antes de `referencia`.

    Aritmética em meses absolutos evita o erro clássico de subtrair 30 dias e
    pular fevereiro — e `meses_atras=-1` devolve o mês seguinte, que é como se
    obtém o fim EXCLUSIVO da janela.
    """
    total = referencia.year * 12 + (referencia.month - 1) - meses_atras
    return date(total // 12, total % 12 + 1, 1)


def _rotulo_mes(chave: str) -> str:
    """'2025-09' → 'set. 25'. Chave fora do formato volta como veio."""
    try:
        ano, mes = int(chave[:4]), int(chave[5:7])
        return f"{MESES_ABREV[mes - 1]} {ano % 100:02d}"
    except (ValueError, IndexError):
        return chave


def _vazio(df: pd.DataFrame | None) -> bool:
    return df is None or df.empty


# ── consultas ──────────────────────────────────────────────────────────────
# Uma consulta por string, sempre um único SELECT/WITH: é o contrato do guarda
# de SQL. Datas vão como parâmetro em texto ISO — comparação lexicográfica em
# coluna TEXT usa o índice e dispensa conversão.
#
# O CTE `faturado` se repete em três consultas de propósito: o valor da nota é a
# soma dos itens, e somar `item.valor_total` no mesmo JOIN que agrega colunas do
# documento multiplicaria ICMS pelo número de itens. Agregar item ANTES de juntar
# ao documento é o que mantém os dois níveis honestos.

# KPIs e tabela de CFOP saem da MESMA consulta: os totais do topo do painel são
# a soma das linhas da tabela abaixo. Duas consultas separadas divergiriam no dia
# em que alguém mexesse no filtro de uma só.
SQL_FISCAL = """
    WITH faturado AS (
        SELECT i.documento_numero AS numero,
               SUM(i.valor_total)  AS valor
          FROM item i
          JOIN documento d ON d.numero = i.documento_numero
         WHERE d.data >= ? AND d.data < ? AND d.cancelado = 0
         GROUP BY i.documento_numero
    )
    SELECT d.cfop                                    AS cfop,
           d.dentro_estado                           AS dentro_estado,
           COUNT(*)                                  AS notas,
           COALESCE(SUM(f.valor), 0.0)               AS valor,
           COALESCE(SUM(d.base_icms), 0.0)           AS base,
           COALESCE(SUM(d.valor_icms), 0.0)          AS icms,
           COALESCE(SUM(d.valor_st), 0.0)            AS st,
           COALESCE(SUM(CASE WHEN d.tipo = 'venda'
                             THEN d.valor_st ELSE 0 END), 0.0)  AS st_destacado,
           COALESCE(SUM(d.valor_ipi), 0.0)           AS ipi,
           COALESCE(SUM(d.frete), 0.0)               AS frete,
           COALESCE(SUM(CASE WHEN ABS(d.valor_ipi) < 0.005
                             THEN f.valor ELSE 0 END), 0.0)     AS sem_ipi
      FROM documento d
      LEFT JOIN faturado f ON f.numero = d.numero
     WHERE d.data >= ? AND d.data < ? AND d.cancelado = 0
     GROUP BY d.cfop, d.dentro_estado
     ORDER BY valor DESC
"""

# `substr(data, 9, 2)` extrai o dia sem converter a coluna inteira para data —
# uma função sobre a coluna no GROUP BY não impede o uso do índice no WHERE.
SQL_DIARIO = """
    SELECT CAST(substr(d.data, 9, 2) AS INTEGER)  AS dia,
           COALESCE(SUM(d.valor_icms), 0.0)       AS icms
      FROM documento d
     WHERE d.data >= ? AND d.data < ? AND d.cancelado = 0
     GROUP BY substr(d.data, 9, 2)
     ORDER BY dia
"""

# A alíquota efetiva de cada mês é calculada no Python, não aqui: dividir dentro
# do SQL exigiria um CASE contra base zero em toda linha.
SQL_EVOLUCAO = """
    SELECT substr(d.data, 1, 7)                 AS mes,
           COALESCE(SUM(d.base_icms), 0.0)      AS base,
           COALESCE(SUM(d.valor_icms), 0.0)     AS icms,
           COALESCE(SUM(d.valor_st), 0.0)       AS st,
           COALESCE(SUM(d.valor_ipi), 0.0)      AS ipi
      FROM documento d
     WHERE d.data >= ? AND d.data < ? AND d.cancelado = 0
     GROUP BY substr(d.data, 1, 7)
     ORDER BY mes
"""

# Dentro × fora do estado em faturamento (não em imposto): é a mudança do MIX
# que explica a alíquota efetiva cair, já que a saída interestadual é tributada
# a 12% no máximo enquanto a interna chega a 18%.
SQL_CFOP_EVOLUCAO = """
    WITH faturado AS (
        SELECT i.documento_numero AS numero,
               SUM(i.valor_total)  AS valor
          FROM item i
          JOIN documento d ON d.numero = i.documento_numero
         WHERE d.data >= ? AND d.data < ? AND d.cancelado = 0
         GROUP BY i.documento_numero
    )
    SELECT substr(d.data, 1, 7)  AS mes,
           COALESCE(SUM(CASE WHEN d.dentro_estado = 1
                             THEN f.valor ELSE 0 END), 0.0) AS dentro,
           COALESCE(SUM(CASE WHEN d.dentro_estado = 0
                             THEN f.valor ELSE 0 END), 0.0) AS fora
      FROM documento d
      LEFT JOIN faturado f ON f.numero = d.numero
     WHERE d.data >= ? AND d.data < ? AND d.cancelado = 0
     GROUP BY substr(d.data, 1, 7)
     ORDER BY mes
"""

SQL_MAIORES = """
    WITH faturado AS (
        SELECT i.documento_numero AS numero,
               SUM(i.valor_total)  AS valor
          FROM item i
          JOIN documento d ON d.numero = i.documento_numero
         WHERE d.data >= ? AND d.data < ? AND d.cancelado = 0
         GROUP BY i.documento_numero
    )
    SELECT d.numero              AS nf,
           c.nome                AS cliente,
           d.data                AS data,
           COALESCE(f.valor, 0.0) AS valor,
           d.valor_icms          AS icms
      FROM documento d
      JOIN cliente c ON c.codigo = d.cliente_codigo
      LEFT JOIN faturado f ON f.numero = d.numero
     WHERE d.data >= ? AND d.data < ? AND d.cancelado = 0
     ORDER BY COALESCE(f.valor, 0.0) DESC
     LIMIT ?
"""

# Uma varredura dos itens do mês, agrupada por PRODUTO, alimenta três blocos do
# payload (situações por CST, regras de PIS/COFINS e a lista de tributação) mais
# o KPI de isentas. São ~240 linhas — cabe agregar o resto no pandas, e assim os
# três blocos não podem divergir entre si por causa de três GROUP BY diferentes.
SQL_TRIBUTACAO = """
    SELECT p.codigo                          AS codigo,
           p.descricao                       AS descricao,
           p.cst                             AS cst,
           p.ncm                             AS ncm,
           p.aliquota_icms                   AS aliquota,
           p.regra_pis_cofins                AS regra,
           COUNT(*)                          AS itens,
           COALESCE(SUM(i.valor_total), 0.0) AS valor
      FROM documento d
      JOIN item i ON i.documento_numero = d.numero
      JOIN produto p ON p.codigo = i.produto_codigo
     WHERE d.data >= ? AND d.data < ? AND d.cancelado = 0
     GROUP BY p.codigo, p.descricao, p.cst, p.ncm, p.aliquota_icms, p.regra_pis_cofins
     ORDER BY valor DESC
"""


class BotImposto(BaseBot):
    """Fecha a posição fiscal do mês: KPIs, séries, CFOP, CST e tributação."""

    def __init__(self, db, cache=None, intervalo: int = INTERVALO_PADRAO):
        super().__init__("imposto", db, cache, intervalo=intervalo)

    # ── ciclo ──────────────────────────────────────────────────────────────
    def analisar(self) -> dict[str, Any]:
        hoje = date.today()
        mes_ini = hoje.replace(day=1)
        # Fim EXCLUSIVO no primeiro dia do mês seguinte: dispensa saber quantos
        # dias o mês tem e não perde o movimento do último dia.
        mes_fim = _primeiro_do_mes(hoje, -1)
        janela = (mes_ini.isoformat(), mes_fim.isoformat())
        janela_dupla = janela + janela          # CTE e consulta externa filtram igual

        evo = (_primeiro_do_mes(hoje, MESES_EVOLUCAO - 1).isoformat(), mes_fim.isoformat())
        cfop_evo = (_primeiro_do_mes(hoje, MESES_CFOP - 1).isoformat(), mes_fim.isoformat())

        dfs = self.paralelo({
            "fiscal": (SQL_FISCAL, janela_dupla),
            "diario": (SQL_DIARIO, janela),
            "evolucao": (SQL_EVOLUCAO, evo),
            "cfop_evolucao": (SQL_CFOP_EVOLUCAO, cfop_evo + cfop_evo),
            "maiores": (SQL_MAIORES, janela_dupla + (MAX_NFS,)),
            "tributacao": (SQL_TRIBUTACAO, janela),
        })

        if all(_vazio(df) for df in dfs.values()):
            # Treze meses de operação não ficam vazios: isto é banco fora do ar,
            # não mês sem movimento. Devolver {} faz a base manter o último ciclo
            # bom em vez de apagar painel e cache com zeros.
            logger.warning("[imposto] todas as consultas voltaram vazias — "
                           "mantendo o ciclo anterior")
            return {}

        fiscal = dfs.get("fiscal", pd.DataFrame())
        tributacao = dfs.get("tributacao", pd.DataFrame())

        return {
            "kpis": self._kpis(fiscal, tributacao, hoje, mes_ini, mes_fim),
            "diario": self._diario(dfs.get("diario"), hoje),
            "evolucao": self._evolucao(dfs.get("evolucao"), hoje),
            "cfops": self._cfops(fiscal),
            "cfop_evolucao": self._cfop_evolucao(dfs.get("cfop_evolucao"), hoje),
            "maiores_nfs": self._maiores_nfs(dfs.get("maiores")),
            "situacoes": self._situacoes(tributacao),
            "regras_pis_cofins": self._regras(tributacao),
            "itens_tributacao": self._itens_tributacao(tributacao),
        }

    # ── blocos do payload ──────────────────────────────────────────────────
    def _kpis(self, fiscal: pd.DataFrame | None, tributacao: pd.DataFrame | None,
              hoje: date, mes_ini: date, mes_fim: date) -> dict[str, Any]:
        """Totais do mês. Somam as linhas da tabela de CFOP, por construção."""
        def total(coluna: str) -> float:
            if _vazio(fiscal) or coluna not in fiscal.columns:
                return 0.0
            return _f(fiscal[coluna].sum())

        icms = total("icms")
        base = total("base")

        # Projeção linear pro rata dia: o mês da distribuidora não é uniforme
        # (fim de mês aquece, sexta cai), então isto é uma reta, não previsão. O
        # divisor é dia corrido, não dia útil — é a régua que o financeiro usa
        # para comparar com a guia do mês anterior.
        dias_mes = (mes_fim - mes_ini).days
        decorridos = max(1, hoje.day)
        projecao = icms / decorridos * dias_mes if icms else 0.0

        isentas_icms = 0.0
        if not _vazio(tributacao) and {"cst", "valor"} <= set(tributacao.columns):
            marca = tributacao["cst"].astype(str).isin(CST_SEM_DEBITO)
            isentas_icms = _f(tributacao.loc[marca, "valor"].sum())

        return {
            "icms_mes": icms,
            "aliquota_efetiva": _pct(icms, base),
            "projecao_icms": _f(projecao),
            "base_calculo": base,
            "faturamento_nfs": total("valor"),
            "qtde_nfs": _i(fiscal["notas"].sum()) if not _vazio(fiscal) else 0,
            "st_outras": total("st"),
            "isentas_icms": isentas_icms,
            # Destacado nas saídas × líquido: a diferença é o ST das devoluções.
            "icms_st_destacado": total("st_destacado"),
            "ipi_debitado": total("ipi"),
            "isentas_ipi": total("sem_ipi"),
            "frete": total("frete"),
        }

    @staticmethod
    def _diario(df: pd.DataFrame | None, hoje: date) -> list[dict[str, Any]]:
        """ICMS dia a dia, do 1º até hoje — com os zeros.

        Sábado e domingo não têm movimento, e é isso que a série precisa mostrar:
        omitir o dia vazio encostaria segunda em sexta e inventaria um platô que
        não existe.
        """
        por_dia: dict[int, float] = {}
        if not _vazio(df):
            for r in df.itertuples(index=False):
                por_dia[_i(r.dia)] = _f(r.icms)
        return [{"dia": dia, "icms": por_dia.get(dia, 0.0)}
                for dia in range(1, hoje.day + 1)]

    @staticmethod
    def _evolucao(df: pd.DataFrame | None, hoje: date) -> list[dict[str, Any]]:
        """Doze meses de ICMS/ST/IPI, sempre com os doze pontos.

        O mês sem linha no banco entra zerado: buraco na série faria o gráfico
        ligar dois meses não adjacentes.
        """
        linhas = {str(r.mes): r for r in df.itertuples(index=False)} \
            if not _vazio(df) else {}

        saida: list[dict[str, Any]] = []
        for atras in range(MESES_EVOLUCAO - 1, -1, -1):
            chave = _primeiro_do_mes(hoje, atras).isoformat()[:7]
            linha = linhas.get(chave)
            icms = _f(getattr(linha, "icms", 0.0))
            base = _f(getattr(linha, "base", 0.0))
            saida.append({
                "mes": _rotulo_mes(chave),
                "icms": icms,
                "st": _f(getattr(linha, "st", 0.0)),
                "ipi": _f(getattr(linha, "ipi", 0.0)),
                "aliquota": _pct(icms, base),
            })
        return saida

    @staticmethod
    def _cfops(df: pd.DataFrame | None) -> list[dict[str, Any]]:
        """Faturamento e ICMS por natureza da operação, do maior para o menor."""
        if _vazio(df):
            return []
        saida: list[dict[str, Any]] = []
        for r in df.itertuples(index=False):
            cfop = str(r.cfop)
            saida.append({
                "cfop": cfop,
                "descricao": CFOP_NOMES.get(cfop, f"{cfop} - Operação não classificada"),
                "valor": _f(r.valor),
                "icms": _f(r.icms),
                "dentro_estado": bool(_i(r.dentro_estado)),
            })
        return saida

    @staticmethod
    def _cfop_evolucao(df: pd.DataFrame | None, hoje: date) -> list[dict[str, Any]]:
        linhas = {str(r.mes): r for r in df.itertuples(index=False)} \
            if not _vazio(df) else {}
        saida: list[dict[str, Any]] = []
        for atras in range(MESES_CFOP - 1, -1, -1):
            chave = _primeiro_do_mes(hoje, atras).isoformat()[:7]
            linha = linhas.get(chave)
            saida.append({
                "mes": _rotulo_mes(chave),
                "dentro": _f(getattr(linha, "dentro", 0.0)),
                "fora": _f(getattr(linha, "fora", 0.0)),
            })
        return saida

    @staticmethod
    def _maiores_nfs(df: pd.DataFrame | None) -> list[dict[str, Any]]:
        """As maiores notas do mês — onde uma glosa doeria mais."""
        if _vazio(df):
            return []
        return [{
            "nf": str(r.nf),
            "cliente": str(r.cliente),
            "data": str(r.data)[:10],
            "valor": _f(r.valor),
            "icms": _f(r.icms),
        } for r in df.itertuples(index=False)]

    @staticmethod
    def _situacoes(df: pd.DataFrame | None) -> list[dict[str, Any]]:
        """Participação do faturamento por CST.

        `valor` sai em reais e `percentual` em pontos percentuais: o gráfico de
        rosca usa o primeiro para o ângulo e o segundo para o rótulo, sem ter de
        refazer a divisão no front.

        O denominador é a soma dos valores POSITIVOS. Um CST cujo mês fechou
        negativo (devolução maior que venda) tem participação zero em vez de uma
        fatia negativa, que nenhuma rosca sabe desenhar.
        """
        if _vazio(df) or "cst" not in df.columns:
            return []
        por_cst = df.groupby(df["cst"].astype(str))["valor"].sum()
        total = float(por_cst[por_cst > 0].sum())

        saida: list[dict[str, Any]] = []
        for cst, valor in por_cst.sort_values(ascending=False).items():
            bruto = _f(valor)
            saida.append({
                "nome": CST_NOMES.get(str(cst), f"{cst} - Outras"),
                "valor": bruto,
                "percentual": _pct(bruto, total) if bruto > 0 else 0.0,
            })
        return saida

    @staticmethod
    def _regras(df: pd.DataFrame | None) -> list[dict[str, Any]]:
        """Faturamento e nº de linhas de item por regime de PIS/COFINS."""
        if _vazio(df) or "regra" not in df.columns:
            return []
        agrupado = df.groupby(df["regra"].astype(str)).agg(
            itens=("itens", "sum"), valor=("valor", "sum"),
        ).sort_values("valor", ascending=False)
        return [{"regra": str(regra), "itens": _i(linha.itens), "valor": _f(linha.valor)}
                for regra, linha in agrupado.iterrows()]

    @staticmethod
    def _itens_tributacao(df: pd.DataFrame | None) -> list[dict[str, Any]]:
        """Os produtos que mais faturaram, com a ficha fiscal de cada um.

        É a lista de conferência: NCM e CST errados no cadastro custam caro, e
        custam na proporção do que o produto vende — por isso o corte é por
        valor, não alfabético.
        """
        if _vazio(df):
            return []
        return [{
            "codigo": str(r.codigo),
            "descricao": str(r.descricao),
            "cst": str(r.cst),
            "ncm": str(r.ncm),
            "aliquota": _f(r.aliquota),
            "valor": _f(r.valor),
        } for r in df.head(MAX_ITENS).itertuples(index=False)]
