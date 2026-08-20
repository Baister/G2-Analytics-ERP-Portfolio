"""Bot financeiro — contas a receber: carteira em aberto, atraso e risco.

O painel responde a três perguntas, nesta ordem de importância para quem cobra:
*quanto está em aberto*, *quanto disso já venceu* e *quando o dinheiro entra*.

Convenções que valem para o arquivo inteiro:

* **Em aberto = `recebido_em IS NULL`.** Não existe baixa parcial neste modelo:
  o título está pago ou não está. Por isso toda soma de carteira é sobre o
  `valor` cheio, sem saldo residual.
* **Vencido = `vencimento < hoje` e em aberto.** O dia do vencimento ainda é
  prazo válido, então o que vence *hoje* conta como a vencer nos KPIs — é a
  mesma régua que o setor de cobrança usa para não ligar para o cliente um dia
  antes da hora.
* **A carteira não tem recorte de data.** Um título de treze meses atrás e
  ainda aberto é exatamente o que o painel precisa mostrar; filtrar por período
  de emissão esconderia o pior da inadimplência.
* **Título cancelado não existe aqui.** O gerador só emite título para
  documento de venda não cancelado, então não há filtro por `documento` — o
  join extra custaria sem mudar um número.

Uma decisão de leitura merece registro: o calendário `vencimentos` cobre a
janela [hoje, hoje+30]. Dentro dela, só o próprio dia de hoje cai na faixa
`atrasado` — é o último dia para o dinheiro entrar. O passado vencido não entra
no calendário de propósito (ele distorceria a escala do gráfico de fluxo); quem
mostra esse backlog são os KPIs `vencidos` e a lista `foco`.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

import pandas as pd

from bots.base import BaseBot

logger = logging.getLogger(__name__)

#: Ciclo de 5 min. A carteira só muda por baixa de título — um punhado de
#: eventos por dia, não um fluxo contínuo. Menos que isso seria reprocessar a
#: base inteira para reencontrar os mesmos números; muito mais que isso e o
#: pessoal da cobrança veria como "recebido" algo que acabou de ser baixado.
INTERVALO_PADRAO = 300

#: Horizonte do calendário de vencimentos, em dias corridos.
DIAS_CALENDARIO = 30

#: Fronteira entre `proximo` e `futuro` no calendário.
DIAS_PROXIMO = 7

#: Atraso a partir do qual o título entra no selo de risco do boleto. Noventa
#: dias é a régua contábil usual para provisão de perda.
DIAS_RISCO = 90

#: Tetos de lista. Existem para o payload não crescer sem limite: o front
#: mostra um resumo clicável, não a carteira completa.
MAX_CLIENTES_POR_DIA = 20
MAX_CLIENTES_FOCO = 50
MAX_LIMITES = 100

#: Formas de pagamento que geram título, na ordem em que o painel as exibe.
FORMAS = (("boleto", "Boleto"), ("cartao", "Cartão"))


# ── conversões para JSON ───────────────────────────────────────────────────
# O payload atravessa `json.dumps`: nada de numpy.int64, NaN ou Timestamp pode
# escapar daqui.

def _f(valor: Any, casas: int = 2) -> float:
    """Float nativo e arredondado; NaN/None/lixo viram 0.0."""
    try:
        n = float(valor)
    except (TypeError, ValueError):
        return 0.0
    if n != n or n in (float("inf"), float("-inf")):
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


def _pct(parte: float, todo: float) -> float:
    """Percentual em pontos percentuais (23.7 = 23,7%). Todo zero devolve 0.0."""
    if not todo:
        return 0.0
    return round(parte * 100.0 / todo, 2)


def _uma_linha(df: pd.DataFrame | None) -> dict[str, Any]:
    if df is None or df.empty:
        return {}
    return df.iloc[0].to_dict()


def _moeda(valor: float) -> str:
    """Formata no padrão brasileiro (R$ 1.234,56).

    O selo (`badge`) vai como texto pronto para o front não ter de reimplementar
    localização só para desenhar uma etiqueta.
    """
    bruto = f"{valor:,.2f}"                       # 1,234.56
    return "R$ " + bruto.replace(",", "@").replace(".", ",").replace("@", ".")


# ── consultas ──────────────────────────────────────────────────────────────
# Uma consulta por string, sempre um único SELECT/WITH: é o contrato do guarda
# de SQL. As datas chegam como parâmetro em texto ISO — comparação lexicográfica
# em coluna TEXT usa o índice e dispensa conversão.

SQL_CARTEIRA = """
    SELECT COUNT(*)                                                             AS aberto_qtd,
           COALESCE(SUM(t.valor), 0.0)                                          AS aberto_valor,
           COALESCE(SUM(CASE WHEN t.vencimento <  ? THEN 1 ELSE 0 END), 0)       AS vencidos_qtd,
           COALESCE(SUM(CASE WHEN t.vencimento <  ? THEN t.valor ELSE 0 END), 0.0) AS vencidos_valor,
           COALESCE(SUM(CASE WHEN t.vencimento >= ? THEN 1 ELSE 0 END), 0)       AS a_vencer_qtd,
           COALESCE(SUM(CASE WHEN t.vencimento >= ? THEN t.valor ELSE 0 END), 0.0) AS a_vencer_valor
      FROM titulo t
     WHERE t.recebido_em IS NULL
"""

# Fim EXCLUSIVO do mês: dispensa saber quantos dias o mês tem.
SQL_RECEBIDO_MES = """
    SELECT COUNT(*)                    AS qtd,
           COALESCE(SUM(t.valor), 0.0) AS valor
      FROM titulo t
     WHERE t.recebido_em >= ? AND t.recebido_em < ?
"""

SQL_VENCIMENTOS_DIA = """
    SELECT t.vencimento               AS data,
           COALESCE(SUM(t.valor), 0.0) AS valor
      FROM titulo t
     WHERE t.recebido_em IS NULL
       AND t.vencimento >= ? AND t.vencimento <= ?
     GROUP BY t.vencimento
     ORDER BY t.vencimento
"""

# Detalhe do calendário: os N maiores títulos de cada dia. O ranking sai no
# banco (ROW_NUMBER por dia) em vez de trazer a janela inteira para o pandas —
# são ~30 dias × 20 linhas em vez de alguns milhares.
SQL_VENCIMENTOS_CLIENTE = """
    WITH abertos AS (
        SELECT t.vencimento         AS data,
               c.nome               AS cliente,
               t.documento_numero   AS documento,
               t.valor              AS valor,
               ROW_NUMBER() OVER (
                   PARTITION BY t.vencimento ORDER BY t.valor DESC, t.numero
               )                    AS ordem
          FROM titulo t
          JOIN cliente c ON c.codigo = t.cliente_codigo
         WHERE t.recebido_em IS NULL
           AND t.vencimento >= ? AND t.vencimento <= ?
    )
    SELECT data, cliente, documento, valor
      FROM abertos
     WHERE ordem <= ?
     ORDER BY data, valor DESC
"""

SQL_FOCO = """
    SELECT t.forma                                                              AS forma,
           COALESCE(SUM(t.valor), 0.0)                                          AS em_aberto,
           COUNT(*)                                                             AS em_aberto_qtd,
           COALESCE(SUM(CASE WHEN t.vencimento <  ? THEN t.valor ELSE 0 END), 0.0) AS vencidos,
           COALESCE(SUM(CASE WHEN t.vencimento >= ? AND t.vencimento <= ?
                             THEN t.valor ELSE 0 END), 0.0)                     AS a_vencer_30,
           COALESCE(SUM(CASE WHEN t.vencimento <  ? THEN 1 ELSE 0 END), 0)       AS risco
      FROM titulo t
     WHERE t.recebido_em IS NULL
     GROUP BY t.forma
"""

SQL_FOCO_RECEBIDO = """
    SELECT t.forma AS forma, COUNT(*) AS qtd
      FROM titulo t
     WHERE t.recebido_em >= ? AND t.recebido_em < ?
     GROUP BY t.forma
"""

# `dias` é positivo para vencido e negativo para a vencer — é o sinal que o
# front usa para escolher entre "há N dias" e "em N dias". A ordenação por
# vencimento crescente traz o mais atrasado no topo, que é a fila de trabalho
# da cobrança.
SQL_FOCO_CLIENTES = """
    WITH abertos AS (
        SELECT t.forma              AS forma,
               c.nome               AS cliente,
               t.documento_numero   AS documento,
               CAST(julianday(?) - julianday(t.vencimento) AS INTEGER) AS dias,
               t.valor              AS valor,
               ROW_NUMBER() OVER (
                   PARTITION BY t.forma ORDER BY t.vencimento, t.valor DESC
               )                    AS ordem
          FROM titulo t
          JOIN cliente c ON c.codigo = t.cliente_codigo
         WHERE t.recebido_em IS NULL
    )
    SELECT forma, cliente, documento, dias, valor
      FROM abertos
     WHERE ordem <= ?
     ORDER BY forma, dias DESC, valor DESC
"""

# Ocupação do limite de crédito. O JOIN já filtra o título em aberto, então
# cliente sem dívida não vira linha — utilização 0% não disputa o top 100.
# O CASE no ORDER BY protege a divisão: limite zerado ordena por último em vez
# de derrubar a consulta.
SQL_LIMITES = """
    SELECT c.codigo          AS codigo,
           c.nome            AS cliente,
           c.limite_credito  AS limite,
           COALESCE(SUM(t.valor), 0.0) AS utilizado
      FROM cliente c
      JOIN titulo t ON t.cliente_codigo = c.codigo AND t.recebido_em IS NULL
     GROUP BY c.codigo, c.nome, c.limite_credito
     ORDER BY CASE WHEN c.limite_credito > 0
                   THEN SUM(t.valor) / c.limite_credito
                   ELSE 0 END DESC
     LIMIT ?
"""


class BotFinanceiro(BaseBot):
    """Agrega a posição de contas a receber: KPIs, calendário, foco e limites."""

    def __init__(self, db, cache=None, intervalo: int = INTERVALO_PADRAO):
        super().__init__("financeiro", db, cache, intervalo=intervalo)

    # ── ciclo ──────────────────────────────────────────────────────────────
    def analisar(self) -> dict:
        hoje = date.today()
        iso_hoje = hoje.isoformat()
        fim_calendario = (hoje + timedelta(days=DIAS_CALENDARIO)).isoformat()
        risco = (hoje - timedelta(days=DIAS_RISCO)).isoformat()

        mes_ini = hoje.replace(day=1)
        mes_fim = (mes_ini.replace(year=mes_ini.year + 1, month=1) if mes_ini.month == 12
                   else mes_ini.replace(month=mes_ini.month + 1))
        janela_mes = (mes_ini.isoformat(), mes_fim.isoformat())

        dfs = self.paralelo({
            "carteira": (SQL_CARTEIRA, (iso_hoje, iso_hoje, iso_hoje, iso_hoje)),
            "recebido": (SQL_RECEBIDO_MES, janela_mes),
            "venc_dia": (SQL_VENCIMENTOS_DIA, (iso_hoje, fim_calendario)),
            "venc_cli": (SQL_VENCIMENTOS_CLIENTE,
                         (iso_hoje, fim_calendario, MAX_CLIENTES_POR_DIA)),
            "foco": (SQL_FOCO, (iso_hoje, iso_hoje, fim_calendario, risco)),
            "foco_receb": (SQL_FOCO_RECEBIDO, janela_mes),
            "foco_cli": (SQL_FOCO_CLIENTES, (iso_hoje, MAX_CLIENTES_FOCO)),
            "limites": (SQL_LIMITES, (MAX_LIMITES,)),
        })
        if self.db.last_error:
            logger.warning("bot [financeiro] com consulta degradada: %s", self.db.last_error)

        carteira = _uma_linha(dfs.get("carteira"))
        recebido = _uma_linha(dfs.get("recebido"))

        vencidos = _f(carteira.get("vencidos_valor"))
        a_vencer = _f(carteira.get("a_vencer_valor"))
        vencidos_qtd = _i(carteira.get("vencidos_qtd"))
        a_vencer_qtd = _i(carteira.get("a_vencer_qtd"))

        return {
            "kpis": {
                "a_receber_qtd": _i(carteira.get("aberto_qtd")),
                "a_receber_valor": _f(carteira.get("aberto_valor")),
                "vencidos": vencidos,
                "a_vencer": a_vencer,
                "recebido_mes": _f(recebido.get("valor")),
                # Denominador é a carteira aberta inteira (vencido + a vencer);
                # usar só o vencido daria 100% sempre.
                "inadimplencia": _pct(vencidos, vencidos + a_vencer),
                "vencidos_qtd": vencidos_qtd,
                "a_vencer_qtd": a_vencer_qtd,
                "recebido_mes_qtd": _i(recebido.get("qtd")),
            },
            # Ordem fixa: as cores do gráfico de rosca são posicionais, então
            # trocar as linhas de lugar trocaria verde por vermelho na tela.
            "status_titulos": [
                {"nome": "A Vencer", "valor": a_vencer, "quantidade": a_vencer_qtd},
                {"nome": "Vencido", "valor": vencidos, "quantidade": vencidos_qtd},
            ],
            "vencimentos": self._vencimentos(dfs.get("venc_dia"), dfs.get("venc_cli"), hoje),
            "foco": self._foco(dfs.get("foco"), dfs.get("foco_receb"), dfs.get("foco_cli")),
            "limites": self._limites(dfs.get("limites")),
        }

    # ── blocos do payload ──────────────────────────────────────────────────
    @staticmethod
    def _situacao(dia: date, hoje: date) -> str:
        if dia <= hoje:
            return "atrasado"
        if (dia - hoje).days <= DIAS_PROXIMO:
            return "proximo"
        return "futuro"

    def _vencimentos(self, df_dia: pd.DataFrame | None,
                     df_cli: pd.DataFrame | None, hoje: date) -> list[dict[str, Any]]:
        """Calendário dos próximos 30 dias, com o detalhe de cada dia embutido.

        Só entram dias com título em aberto: preencher o vazio com zeros criaria
        trinta colunas fantasma no gráfico de fluxo de caixa.
        """
        if df_dia is None or df_dia.empty:
            return []

        # Detalhe agrupado antes do laço: procurar o dia dentro do DataFrame a
        # cada iteração seria uma varredura por dia.
        por_dia: dict[str, list[dict[str, Any]]] = {}
        if df_cli is not None and not df_cli.empty:
            for r in df_cli.itertuples(index=False):
                por_dia.setdefault(str(r.data)[:10], []).append({
                    "cliente": str(r.cliente),
                    "documento": str(r.documento),
                    "valor": _f(r.valor),
                })

        saida: list[dict[str, Any]] = []
        for r in df_dia.itertuples(index=False):
            iso = str(r.data)[:10]
            try:
                dia = date.fromisoformat(iso)
            except ValueError:
                continue
            saida.append({
                "data": iso,
                "dia": dia.day,
                "valor": _f(r.valor),
                "situacao": self._situacao(dia, hoje),
                "clientes": por_dia.get(iso, []),
            })
        return saida

    def _foco(self, df_foco: pd.DataFrame | None, df_receb: pd.DataFrame | None,
              df_cli: pd.DataFrame | None) -> list[dict[str, Any]]:
        """Um bloco por forma de pagamento, sempre nas duas linhas esperadas.

        Boleto e cartão adoecem de formas diferentes: boleto acumula atraso
        longo (daí o selo de risco acima de 90 dias), cartão praticamente não
        atrasa mas dilui o valor em muitas parcelas pequenas (daí o ticket
        médio). Por isso o selo não é o mesmo cálculo para os dois.
        """
        agregado = {str(r.forma): r for r in df_foco.itertuples(index=False)} \
            if df_foco is not None and not df_foco.empty else {}
        recebidos = {str(r.forma): _i(r.qtd) for r in df_receb.itertuples(index=False)} \
            if df_receb is not None and not df_receb.empty else {}

        clientes: dict[str, list[dict[str, Any]]] = {}
        if df_cli is not None and not df_cli.empty:
            for r in df_cli.itertuples(index=False):
                clientes.setdefault(str(r.forma), []).append({
                    "cliente": str(r.cliente),
                    "documento": str(r.documento),
                    "dias": _i(r.dias),
                    "valor": _f(r.valor),
                })

        saida: list[dict[str, Any]] = []
        for chave, rotulo in FORMAS:
            linha = agregado.get(chave)
            em_aberto = _f(getattr(linha, "em_aberto", 0.0))
            qtd = _i(getattr(linha, "em_aberto_qtd", 0))
            risco = _i(getattr(linha, "risco", 0))
            if chave == "boleto":
                badge = f"{risco} em risco >{DIAS_RISCO}d"
            else:
                badge = f"Ticket médio {_moeda(round(em_aberto / qtd, 2) if qtd else 0.0)}"
            saida.append({
                "tipo": rotulo,
                "em_aberto": em_aberto,
                "vencidos": _f(getattr(linha, "vencidos", 0.0)),
                "a_vencer_30": _f(getattr(linha, "a_vencer_30", 0.0)),
                # Contagem, não valor: o contrato do painel pede o número de
                # baixas do mês nesta forma, para comparar com a fila em aberto.
                "recebido_mes": recebidos.get(chave, 0),
                "badge": badge,
                "clientes": clientes.get(chave, []),
            })
        return saida

    @staticmethod
    def _limites(df: pd.DataFrame | None) -> list[dict[str, Any]]:
        """Ocupação do limite de crédito, do mais apertado para o mais folgado.

        Utilização acima de 100% é resultado legítimo, não erro: o limite é a
        régua do cadastro e a carteira pode tê-la estourado — é justamente esse
        cliente que o painel precisa destacar.
        """
        if df is None or df.empty:
            return []
        saida: list[dict[str, Any]] = []
        for r in df.itertuples(index=False):
            limite = _f(r.limite)
            utilizado = _f(r.utilizado)
            saida.append({
                "codigo": str(r.codigo),
                "cliente": str(r.cliente),
                "limite": limite,
                "utilizado": utilizado,
                "utilizacao": _pct(utilizado, limite),
            })
        return saida
