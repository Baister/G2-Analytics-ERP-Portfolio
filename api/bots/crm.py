"""Bot de CRM — funil comercial do mês e saúde da carteira de clientes.

Duas famílias de número convivem aqui e é importante não confundi-las:

1. **Funil** — vive na tabela `orcamento`. Mede intenção: quanto foi proposto,
   quanto fechou, quanto já se materializou.
2. **Carteira** — vive em `documento`/`item`. Mede realização: quem comprou,
   quanto, e há quantos dias parou de comprar.

Três decisões de interpretação valem ser explicitadas, porque mudam o que a
tela mostra:

- **O funil é decrescente por construção.** As três etapas são subconjuntos
  encaixados da MESMA população — os orçamentos do mês. Cruzar "propostas" com
  o faturamento contábil do mês (`faturado_mes`) daria uma etapa final várias
  vezes maior que a primeira: são universos diferentes, e o desenho deixaria de
  ser um funil. `faturado_mes` continua no payload como KPI, ao lado do funil,
  não dentro dele.
- **Pipeline só conta proposta viva.** Orçamento aberto há mais de 90 dias não
  é pipeline, é perda que ninguém registrou. O KPI usa a mesma janela da lista
  de oportunidades logo abaixo dele, para que o total da tela feche com a soma
  das linhas em vez de divergir dela sem explicação.
- **Recência conta venda, não devolução.** Devolução não é compra: se entrasse
  no `MAX(data)`, um cliente que só devolveu mercadoria apareceria como ativo.
  O histórico de faturamento segue a mesma base — assim as duas colunas da
  tabela de inativos falam do mesmo conjunto de documentos.

Documento cancelado fica fora de tudo: existe na base como registro, não como
venda.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

import pandas as pd

from bots.base import BaseBot, registros

logger = logging.getLogger(__name__)

#: Ciclo de 6 min: o bloco pesado é a varredura da carteira inteira (13 meses de
#: itens agregados por cliente). Carteira se move em escala de dias — reprocessar
#: a cada minuto gastaria conexão do pool para devolver o mesmo número.
INTERVALO_PADRAO = 360

#: Dias sem comprar que separam as faixas de atenção. 60 é o ponto em que o
#: vendedor ainda recupera o cliente com um telefonema; 90 é quando ele já
#: comprou de outro fornecedor.
DIAS_RISCO = 60
DIAS_INATIVO = 90

#: Janela de proposta viva — ver nota sobre pipeline no topo.
DIAS_PIPELINE = 90

#: Tetos das listas de atenção: a tela pagina, mas o payload não precisa
#: carregar a carteira inteira até o navegador.
LIMITE_RISCO = 60
LIMITE_INATIVOS = 100

#: Faixas do histograma de inatividade. Rótulos são contrato com o gráfico
#: (posicionais e fixos); o limite é o teto INCLUSIVO de dias de cada faixa.
FAIXAS: tuple[tuple[str, int], ...] = (
    ("0-30", 30), ("31-60", 60), ("61-90", 90), ("91-180", 180),
)
FAIXA_FINAL = "180+"


SQL_VENDEDORES = "SELECT id, nome FROM vendedor ORDER BY nome"

# Uma varredura resolve funil, taxa de conversão e propostas no caixa: são
# recortes da mesma população (orçamentos do mês), e três consultas separadas
# só criariam a chance de divergirem entre si.
#
# `valor_faturado` é a parcela dos convertidos cuja conversão JÁ ocorreu
# (`convertido_em` no passado). Proposta fechada ontem com conversão marcada
# para semana que vem está ganha, mas ainda não virou nota — é exatamente esse
# vão que a terceira etapa do funil mostra.
SQL_FUNIL_MES = """
    SELECT COUNT(*)                                     AS propostas,
           COALESCE(SUM(o.valor), 0.0)                   AS valor_total,
           SUM(CASE WHEN o.situacao = 'convertido' THEN 1 ELSE 0 END) AS convertidos,
           COALESCE(SUM(CASE WHEN o.situacao = 'convertido'
                             THEN o.valor ELSE 0.0 END), 0.0)         AS valor_convertido,
           COALESCE(SUM(CASE WHEN o.situacao = 'convertido' AND o.convertido_em <= ?
                             THEN o.valor ELSE 0.0 END), 0.0)         AS valor_faturado
      FROM orcamento o
     WHERE o.data >= ? AND o.data < ?
"""

SQL_PIPELINE = """
    SELECT COUNT(*)                       AS quantidade,
           COALESCE(SUM(o.valor), 0.0)    AS valor
      FROM orcamento o
     WHERE o.situacao = 'aberto' AND o.data >= ?
"""

# Faturamento LÍQUIDO: devolução já chega com valor negativo da origem, então a
# soma sem filtro de tipo é o líquido. Frete fica de fora — é receita sem custo
# de produto e inflaria qualquer comparação com o funil.
SQL_FATURADO_MES = """
    SELECT COALESCE(SUM(i.valor_total), 0.0) AS valor
      FROM documento d
      JOIN item i ON i.documento_numero = d.numero
     WHERE d.data >= ? AND d.data < ? AND d.cancelado = 0
"""

# `date(x, 'weekday 0', '-6 days')` = segunda-feira da semana de x: avança para
# o próximo domingo (ou fica, se já for domingo) e volta seis dias. Agrupar pelo
# início da semana é o que mantém o rótulo estável quando a semana corrente
# ainda está incompleta.
SQL_SEMANAL = """
    SELECT date(o.data, 'weekday 0', '-6 days')                        AS semana,
           COUNT(*)                                                    AS propostas,
           SUM(CASE WHEN o.situacao = 'convertido' THEN 1 ELSE 0 END)   AS convertidos
      FROM orcamento o
     WHERE o.data >= ? AND o.data < ?
     GROUP BY semana
     ORDER BY semana
"""

SQL_RANKING = """
    SELECT v.nome                                                       AS vendedor,
           v.meta_mensal                                                AS meta,
           COUNT(*)                                                     AS propostas,
           SUM(CASE WHEN o.situacao = 'convertido' THEN 1 ELSE 0 END)    AS conversoes,
           SUM(CASE WHEN o.situacao = 'cancelado' THEN 1 ELSE 0 END)     AS cancelados,
           COALESCE(SUM(CASE WHEN o.situacao = 'convertido'
                             THEN o.valor ELSE 0.0 END), 0.0)           AS valor
      FROM orcamento o
      JOIN vendedor v ON v.id = o.vendedor_id
     WHERE o.data >= ? AND o.data < ?
     GROUP BY v.id, v.nome, v.meta_mensal
     ORDER BY valor DESC
"""

SQL_OPORTUNIDADES = """
    SELECT o.numero                                          AS numero,
           c.nome                                            AS cliente,
           v.nome                                            AS vendedor,
           o.data                                            AS data,
           CAST(julianday(?) - julianday(o.data) AS INTEGER) AS dias_aberto,
           o.valor                                           AS valor
      FROM orcamento o
      JOIN cliente c ON c.codigo = o.cliente_codigo
      JOIN vendedor v ON v.id = o.vendedor_id
     WHERE o.situacao = 'aberto' AND o.data >= ?
     ORDER BY o.valor DESC
     LIMIT 50
"""

# Uma linha por cliente que comprou no mês. Alimenta três saídas: a contagem de
# ativos, o top 10 e o valor do mês dos clientes novos. Sem LIMIT porque a
# contagem de ativos é a contagem de linhas — cortar aqui mentiria no KPI.
SQL_CLIENTES_MES = """
    SELECT d.cliente_codigo                    AS codigo,
           c.nome                              AS cliente,
           MIN(d.data)                         AS primeira_compra_mes,
           COALESCE(SUM(i.valor_total), 0.0)   AS valor
      FROM documento d
      JOIN item i ON i.documento_numero = d.numero
      JOIN cliente c ON c.codigo = d.cliente_codigo
     WHERE d.data >= ? AND d.data < ? AND d.cancelado = 0 AND d.tipo = 'venda'
     GROUP BY d.cliente_codigo, c.nome
     ORDER BY valor DESC
"""

# Candidatos a "cliente novo", por dois sinais independentes de aquisição:
#   MIN(data) no mês  → primeira compra registrada é deste mês;
#   cadastro recente  → entrou na base há pouco e já está comprando.
# O segundo existe porque o primeiro sozinho depende do tamanho do histórico:
# numa base com anos de movimento, quase ninguém tem a primeira compra no mês
# corrente e o painel viveria zerado — o que diria mais sobre a janela de dados
# do que sobre a operação comercial.
SQL_CLIENTES_NOVOS = """
    SELECT c.codigo        AS codigo,
           c.nome          AS cliente,
           c.cadastro      AS cadastro,
           MIN(d.data)     AS primeira_compra
      FROM cliente c
      JOIN documento d ON d.cliente_codigo = c.codigo
     WHERE d.cancelado = 0 AND d.tipo = 'venda'
     GROUP BY c.codigo, c.nome, c.cadastro
    HAVING MIN(d.data) >= ? OR c.cadastro >= ?
"""

# Carteira inteira: recência, histórico e os DOIS vendedores do cliente.
# `vendedor` é o dono da carteira (quem deve agir); `ultimo_vendedor` é quem de
# fato atendeu na última compra. Eles divergem quando alguém cobre o
# atendimento, e a tabela de inativos pergunta pelo segundo — é quem tem o
# contexto do último contato.
SQL_CARTEIRA = """
    SELECT c.codigo                                              AS codigo,
           c.nome                                                AS cliente,
           v.nome                                                AS vendedor,
           CAST(julianday(?) - julianday(MAX(d.data)) AS INTEGER) AS dias,
           COALESCE(SUM(i.valor_total), 0.0)                     AS historico,
           (SELECT uv.nome
              FROM documento u
              JOIN vendedor uv ON uv.id = u.vendedor_id
             WHERE u.cliente_codigo = c.codigo
               AND u.cancelado = 0 AND u.tipo = 'venda'
             ORDER BY u.data DESC
             LIMIT 1)                                            AS ultimo_vendedor
      FROM cliente c
      JOIN documento d ON d.cliente_codigo = c.codigo
                      AND d.cancelado = 0 AND d.tipo = 'venda'
      JOIN item i ON i.documento_numero = d.numero
      JOIN vendedor v ON v.id = c.vendedor_id
     GROUP BY c.codigo, c.nome, v.nome
     ORDER BY dias DESC
"""


# ── conversões defensivas ──────────────────────────────────────────────────
# Tudo que entra no retorno passa por um destes: o payload vira JSON, e pandas
# entrega numpy.int64 (que `json.dumps` recusa) e NaN (que ele serializa como
# literal inválido, quebrando o parser do navegador sem erro do lado do servidor).
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


def _t(valor: Any) -> str:
    return "" if valor is None else str(valor)


def _pct(parte: float, total: float) -> float:
    """Percentual em pontos percentuais; denominador zero devolve 0."""
    return round(parte / total * 100.0, 2) if total else 0.0


def _escalar(df: pd.DataFrame, coluna: str) -> Any:
    """Primeira célula de uma agregação — 0 se a consulta falhou (df vazio)."""
    if df is None or df.empty or coluna not in df.columns:
        return 0
    return df.iloc[0][coluna]


def _rotulo_semana(iso: str) -> str:
    """'2026-08-17' -> '17/08'. Entrada estranha vira o texto original."""
    return f"{iso[8:10]}/{iso[5:7]}" if len(iso) >= 10 else iso


class BotCrm(BaseBot):
    """Funil comercial do mês e segmentação da carteira por recência."""

    def __init__(self, db, cache=None, intervalo: int = INTERVALO_PADRAO):
        super().__init__("crm", db, cache, intervalo=intervalo)

    def analisar(self) -> dict[str, Any]:
        hoje = date.today()
        hoje_iso = hoje.isoformat()
        primeiro = hoje.replace(day=1)
        # Fim EXCLUSIVO: comparar com o primeiro dia do mês seguinte dispensa
        # saber quantos dias o mês tem e continua usando o índice de data.
        mes_fim = (primeiro + timedelta(days=32)).replace(day=1).isoformat()
        mes = (primeiro.isoformat(), mes_fim)

        limite_pipeline = (hoje - timedelta(days=DIAS_PIPELINE)).isoformat()
        # Quatro semanas fechadas + a corrente: ancorar na segunda-feira evita
        # que a primeira barra apareça truncada pelo dia em que o ciclo rodou.
        semana_ini = (hoje - timedelta(days=hoje.weekday() + 21)).isoformat()
        semana_fim = (hoje + timedelta(days=1)).isoformat()

        dfs = self.paralelo({
            "vendedores": (SQL_VENDEDORES, ()),
            "funil": (SQL_FUNIL_MES, (hoje_iso, *mes)),
            "pipeline": (SQL_PIPELINE, (limite_pipeline,)),
            "faturado": (SQL_FATURADO_MES, mes),
            "semanal": (SQL_SEMANAL, (semana_ini, semana_fim)),
            "ranking": (SQL_RANKING, mes),
            "oportunidades": (SQL_OPORTUNIDADES, (hoje_iso, limite_pipeline)),
            "clientes_mes": (SQL_CLIENTES_MES, mes),
            "novos": (SQL_CLIENTES_NOVOS, (primeiro.isoformat(), limite_pipeline)),
            "carteira": (SQL_CARTEIRA, (hoje_iso,)),
        })

        # Banco fora do ar ≠ mês sem movimento. A base devolve o último ciclo
        # bom quando `analisar()` volta vazio, mas engoliria um payload zerado
        # como verdade — apagando painel e cache. Sentinela: a tabela de
        # vendedores nunca está vazia e a carteira tem 13 meses de histórico;
        # as duas mudas ao mesmo tempo só acontece se as consultas falharam.
        if dfs.get("vendedores", pd.DataFrame()).empty and \
                dfs.get("carteira", pd.DataFrame()).empty:
            logger.warning("[crm] consultas não retornaram — mantendo o ciclo anterior")
            return {}

        carteira = registros(dfs.get("carteira", pd.DataFrame()))
        clientes_mes = registros(dfs.get("clientes_mes", pd.DataFrame()))

        em_risco = [c for c in carteira
                    if DIAS_RISCO <= _i(c.get("dias")) < DIAS_INATIVO]
        inativos = [c for c in carteira if _i(c.get("dias")) >= DIAS_INATIVO]
        novos = self._clientes_novos(dfs.get("novos", pd.DataFrame()), clientes_mes)

        return {
            "vendedores": [
                {"id": _i(r.get("id")), "nome": _t(r.get("nome"))}
                for r in registros(dfs.get("vendedores", pd.DataFrame()))
            ],
            "kpis": self._kpis(dfs, clientes_mes, novos, em_risco, inativos),
            "funil": self._funil(dfs.get("funil", pd.DataFrame())),
            "semanal": [
                {
                    "semana": _rotulo_semana(_t(r.get("semana"))),
                    "propostas": _i(r.get("propostas")),
                    "convertidos": _i(r.get("convertidos")),
                }
                for r in registros(dfs.get("semanal", pd.DataFrame()))
            ],
            "ranking": self._ranking(dfs.get("ranking", pd.DataFrame())),
            "oportunidades": [
                {
                    "numero": _t(r.get("numero")),
                    "cliente": _t(r.get("cliente")),
                    "vendedor": _t(r.get("vendedor")),
                    "data": _t(r.get("data")),
                    # Piso 0: orçamento lançado hoje é "0 dias aberto", nunca
                    # negativo — o relógio do banco pode estar à frente do app.
                    "dias_aberto": max(0, _i(r.get("dias_aberto"))),
                    "valor": _f(r.get("valor")),
                }
                for r in registros(dfs.get("oportunidades", pd.DataFrame()))
            ],
            "top_clientes": [
                {
                    "codigo": _t(r.get("codigo")),
                    "cliente": _t(r.get("cliente")),
                    "valor": _f(r.get("valor")),
                }
                for r in clientes_mes[:10]
            ],
            "clientes_novos": novos,
            "histograma_inatividade": self._histograma(carteira),
            "em_risco": [
                {
                    "cliente": _t(c.get("cliente")),
                    # Dono da carteira: é dele a tarefa de recuperar o cliente
                    # antes que ele cruze os 90 dias.
                    "vendedor": _t(c.get("vendedor")),
                    "dias": _i(c.get("dias")),
                    "valor": _f(c.get("historico")),
                }
                for c in self._por_valor(em_risco)[:LIMITE_RISCO]
            ],
            "inativos": [
                {
                    "cliente": _t(c.get("cliente")),
                    "ultimo_vendedor": _t(c.get("ultimo_vendedor")),
                    "dias": _i(c.get("dias")),
                    "historico": _f(c.get("historico")),
                }
                for c in self._por_valor(inativos)[:LIMITE_INATIVOS]
            ],
        }

    # ── blocos ─────────────────────────────────────────────────────────────
    def _kpis(self, dfs: dict[str, pd.DataFrame], clientes_mes: list[dict],
              novos: list[dict], em_risco: list[dict],
              inativos: list[dict]) -> dict[str, Any]:
        funil = dfs.get("funil", pd.DataFrame())
        propostas = _i(_escalar(funil, "propostas"))
        convertidos = _i(_escalar(funil, "convertidos"))

        return {
            "taxa_conversao": _pct(convertidos, propostas),
            "pipeline": _f(_escalar(dfs.get("pipeline", pd.DataFrame()), "valor")),
            "faturado_mes": _f(_escalar(dfs.get("faturado", pd.DataFrame()), "valor")),
            "propostas_caixa": _f(_escalar(funil, "valor_convertido")),
            # Contagem de linhas, não de documentos: a consulta já agrupa por
            # cliente, então len() é o COUNT(DISTINCT) sem uma segunda ida ao banco.
            "clientes_ativos": len(clientes_mes),
            "clientes_novos": len(novos),
            # Contagens completas, e não o tamanho das listas — as listas do
            # payload são truncadas para não pesar no navegador, mas o KPI tem
            # de dizer o tamanho real do problema.
            "em_risco": len(em_risco),
            "inativos": len(inativos),
        }

    def _funil(self, df: pd.DataFrame) -> list[dict]:
        """Três etapas encaixadas sobre os orçamentos do mês.

        Etapa 1 é sempre 100%: é a base de comparação do gráfico, não um número
        medido. Com o mês zerado as etapas seguintes ficam em 0 e o desenho
        continua válido (funil vazio), em vez de sumir da tela.
        """
        total = _f(_escalar(df, "valor_total"))
        etapas = (
            ("Em Negociacao", total),
            ("Fechadas", _f(_escalar(df, "valor_convertido"))),
            ("Faturadas", _f(_escalar(df, "valor_faturado"))),
        )
        return [
            {"etapa": nome, "valor": valor,
             "percentual": 100.0 if i == 0 else _pct(valor, total)}
            for i, (nome, valor) in enumerate(etapas)
        ]

    def _ranking(self, df: pd.DataFrame) -> list[dict]:
        linhas = []
        for r in registros(df):
            propostas = _i(r.get("propostas"))
            conversoes = _i(r.get("conversoes"))
            valor = _f(r.get("valor"))
            meta = _f(r.get("meta"))
            linhas.append({
                "vendedor": _t(r.get("vendedor")),
                "propostas": propostas,
                "conversoes": conversoes,
                "taxa": _pct(conversoes, propostas),
                "valor": valor,
                # Ticket sobre CONVERSÕES, não sobre propostas: é o tamanho do
                # negócio que o vendedor fecha, não a média do que ele orça.
                "ticket": _f(valor / conversoes) if conversoes else 0.0,
                "cancelados": _i(r.get("cancelados")),
                "percentual_meta": _pct(valor, meta),
            })
        return linhas

    def _clientes_novos(self, df_novos: pd.DataFrame,
                        clientes_mes: list[dict]) -> list[dict]:
        """Candidatos a novo ∩ quem comprou no mês.

        O cruzamento é feito aqui e não no SQL porque a consulta de candidatos
        varre todo o histórico e a do mês já está na memória: unir em Python
        troca um JOIN sobre a base inteira por um lookup em dicionário.
        """
        do_mes = {_t(c.get("codigo")): c for c in clientes_mes}
        linhas = []
        for r in registros(df_novos):
            codigo = _t(r.get("codigo"))
            no_mes = do_mes.get(codigo)
            if no_mes is None:
                continue        # entrou na base, mas ainda não comprou no mês
            linhas.append({
                "codigo": codigo,
                "cliente": _t(r.get("cliente")),
                # Primeira compra DENTRO do mês: é a data que a tela usa para
                # dizer quando o cliente apareceu no período em análise.
                "data": _t(no_mes.get("primeira_compra_mes")),
                "valor": _f(no_mes.get("valor")),
            })
        return sorted(linhas, key=lambda l: l["valor"], reverse=True)

    def _histograma(self, carteira: list[dict]) -> list[dict]:
        """Distribuição da carteira por dias desde a última compra.

        As faixas são fixas e sempre saem todas, inclusive zeradas: o gráfico
        as trata como posições, e omitir uma faixa vazia deslocaria as cores e
        faria "91-180" ser lida como "61-90".
        """
        contagem = {rotulo: 0 for rotulo, _ in FAIXAS}
        contagem[FAIXA_FINAL] = 0
        for c in carteira:
            dias = _i(c.get("dias"))
            for rotulo, teto in FAIXAS:
                if dias <= teto:
                    contagem[rotulo] += 1
                    break
            else:
                contagem[FAIXA_FINAL] += 1
        rotulos = [r for r, _ in FAIXAS] + [FAIXA_FINAL]
        return [{"faixa": r, "clientes": contagem[r]} for r in rotulos]

    def _por_valor(self, clientes: list[dict]) -> list[dict]:
        """Ordena por histórico de faturamento — o corte das listas de atenção
        precisa manter quem dói perder, não quem parou primeiro."""
        return sorted(clientes, key=lambda c: _f(c.get("historico")), reverse=True)
