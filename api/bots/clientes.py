"""Bot de clientes — a carteira dos últimos 12 meses.

Enquanto o bot de CRM olha para a *intenção* (o funil de orçamentos do mês),
aqui a pergunta é sobre a base instalada: quem compra, quanto pesa e há quanto
tempo sumiu. Tudo sai da mesma varredura de `documento`/`item` na janela de 12
meses, para que os KPIs do topo fechem com as listas de baixo — dois SELECTs
com recortes ligeiramente diferentes divergiriam na terceira casa e ninguém
descobriria por quê.

Decisões de interpretação que mudam o que a tela mostra:

- **Janela de 12 meses de calendário**, do primeiro dia do mês 11 meses atrás
  até o primeiro dia do mês seguinte (fim exclusivo). O mês corrente entra
  parcial e é isso que se quer: a última barra da série é "o mês até hoje", não
  um buraco. Usar "365 dias atrás" cortaria um mês pela metade nas duas pontas
  e faria a série começar com uma barra truncada sem explicação.
- **Receita é líquida; recência e pedidos contam só venda.** Devolução chega da
  origem com valor negativo, então somar sem filtrar tipo já dá o líquido — que
  é o número certo para ranquear cliente. Mas devolução não é compra: se
  entrasse no `MAX(data)`, quem só devolveu mercadoria apareceria como "Ativo",
  e a contagem de pedidos premiaria quem devolve. Mesma regra do bot de CRM,
  para as duas telas não brigarem.
- **A carteira é quem comprou na janela.** Cliente cadastrado que nunca comprou
  em 12 meses não tem recência mensurável e fica fora da segmentação e do ABC —
  ele é um cadastro, não uma carteira. Por isso `compradores_12m` costuma ser
  menor que o total de clientes da base.

Documento cancelado fica fora de tudo: existe como registro, não como venda.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

import pandas as pd

from bots.base import BaseBot, registros

logger = logging.getLogger(__name__)

#: Ciclo de 7 min. O bloco caro é a varredura de 12 meses de itens agregada por
#: cliente, mais um segundo passe sobre a base inteira para achar a primeira
#: compra de cada um. Carteira se move em escala de dias — reprocessar de minuto
#: em minuto gastaria conexão do pool para devolver o mesmo número.
INTERVALO_PADRAO = 420

MESES_ABREV = (
    "jan.", "fev.", "mar.", "abr.", "mai.", "jun.",
    "jul.", "ago.", "set.", "out.", "nov.", "dez.",
)

#: Tamanho da janela de análise, em meses (inclui o mês corrente, parcial).
MESES_JANELA = 12

#: Faixas de recência. Rótulos são contrato com o gráfico e com a coluna
#: `recencia` do top 50 — posicionais e fixos. O número é o teto INCLUSIVO de
#: dias sem comprar; o que passa do último cai em `FAIXA_FINAL`.
#: 30 dias é o ciclo típico de recompra desta operação, 60 é onde o vendedor
#: ainda recupera o cliente com um telefonema, 90 é quando ele já comprou de
#: outro fornecedor.
FAIXAS: tuple[tuple[str, int], ...] = (
    ("Ativo", 30), ("Atenção", 60), ("Em risco", 90),
)
FAIXA_FINAL = "Inativo"

#: Cortes da curva ABC, em percentual acumulado da receita.
CORTE_A = 80.0
CORTE_B = 95.0
CLASSES = ("A", "B", "C")

#: Tetos de lista: o payload é um resumo navegável, não a carteira inteira
#: viajando até o navegador a cada ciclo.
TOP_CLIENTES = 50
TOP_CONCENTRACAO = 10

#: Janela do segundo sinal de aquisição — ver `_SQL_NOVOS`.
DIAS_CADASTRO_NOVO = 90


# ── consultas ──────────────────────────────────────────────────────────────
# Uma consulta por string, sempre um único SELECT: é o contrato do guarda
# somente-leitura em `core/sql_guard.py`.

# Espinha dorsal do bot: uma linha por cliente que comprou na janela. Alimenta
# KPIs, segmentação, ABC e top 50 de uma vez só.
#
# O filtro de data vive no ON do JOIN, não no WHERE: no WHERE ele descartaria
# as linhas ANTES do GROUP BY do mesmo jeito, mas no ON fica explícito que a
# janela recorta os documentos, e não a lista de clientes.
#
# `pedidos` conta documentos DISTINTOS: o JOIN com `item` multiplica a linha do
# documento pelo número de itens, e um COUNT(*) aqui contaria itens chamando-os
# de pedidos — inflando o número e afundando o ticket na mesma proporção.
#
# Sem LIMIT de propósito: `compradores_12m` é a contagem de linhas desta
# consulta e o ABC precisa da cauda inteira para o acumulado fechar em 100%.
# São centenas de linhas, bem abaixo do teto de segurança da camada de dados.
_SQL_CARTEIRA = """
    SELECT c.codigo                                                    AS codigo,
           c.nome                                                      AS cliente,
           COALESCE(SUM(i.valor_total), 0.0)                           AS receita,
           COUNT(DISTINCT CASE WHEN d.tipo = 'venda'
                               THEN d.numero END)                      AS pedidos,
           MAX(CASE WHEN d.tipo = 'venda' THEN d.data END)             AS ultima_compra,
           CAST(julianday(?) - julianday(
                MAX(CASE WHEN d.tipo = 'venda' THEN d.data END)
           ) AS INTEGER)                                               AS dias
      FROM cliente c
      JOIN documento d ON d.cliente_codigo = c.codigo
                      AND d.cancelado = 0
                      AND d.data >= ? AND d.data < ?
      JOIN item i ON i.documento_numero = d.numero
     GROUP BY c.codigo, c.nome
    HAVING pedidos > 0
     ORDER BY receita DESC
"""

# Clientes distintos com venda no mês corrente. Poderia sair da carteira acima
# por recência, mas não daria o mesmo número: "comprou nos últimos 20 dias" e
# "comprou neste mês" só coincidem no dia 20 — no dia 1º de cada mês a
# diferença é a operação de um mês inteiro.
_SQL_ATIVOS_MES = """
    SELECT COUNT(DISTINCT d.cliente_codigo) AS clientes
      FROM documento d
     WHERE d.data >= ? AND d.data < ?
       AND d.cancelado = 0 AND d.tipo = 'venda'
"""

# Clientes NOVOS do mês, por dois sinais independentes de aquisição:
#   primeira compra da base dentro do mês → entrou comprando agora;
#   cadastro recente + compra no mês      → entrou há pouco e já está ativo.
#
# O segundo sinal existe porque o primeiro sozinho mede o tamanho do histórico,
# não a operação comercial: numa base cuja janela tem poucos meses, quase todo
# cliente tem a "primeira compra" amontoada no mês mais antigo disponível e o
# KPI vive zerado — dizendo mais sobre o recorte dos dados do que sobre a
# captação. Mesmo critério do bot de CRM, para as duas telas contarem o mesmo.
#
# O `MAX(CASE ...)` é um "existe compra no mês" expresso como agregação: evita
# um segundo JOIN com a mesma tabela só para testar presença.
_SQL_NOVOS = """
    SELECT COUNT(*) AS clientes
      FROM (SELECT c.codigo                                        AS codigo,
                   c.cadastro                                      AS cadastro,
                   MIN(d.data)                                     AS primeira,
                   MAX(CASE WHEN d.data >= ? THEN 1 ELSE 0 END)    AS comprou_mes
              FROM cliente c
              JOIN documento d ON d.cliente_codigo = c.codigo
                              AND d.cancelado = 0 AND d.tipo = 'venda'
             GROUP BY c.codigo, c.cadastro)
     WHERE comprou_mes = 1 AND (primeira >= ? OR cadastro >= ?)
"""

# Clientes distintos por mês. `strftime('%Y-%m', ...)` ordena alfabeticamente na
# mesma ordem que cronologicamente — é por isso que a chave é ISO e o rótulo
# bonito ('set. 25') só aparece na montagem do payload.
_SQL_SERIE = """
    SELECT strftime('%Y-%m', d.data)         AS mes,
           COUNT(DISTINCT d.cliente_codigo)  AS ativos
      FROM documento d
     WHERE d.data >= ? AND d.data < ?
       AND d.cancelado = 0 AND d.tipo = 'venda'
     GROUP BY mes
     ORDER BY mes
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
    return round(n, casas) if n == n else 0.0      # n != n captura NaN


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


def _escalar(df: pd.DataFrame | None, coluna: str) -> Any:
    """Primeira célula de uma agregação — 0 se a consulta falhou (df vazio)."""
    if df is None or df.empty or coluna not in df.columns:
        return 0
    return df.iloc[0][coluna]


def _faixa(dias: int) -> str:
    """Rótulo de recência a partir dos dias sem comprar."""
    for rotulo, teto in FAIXAS:
        if dias <= teto:
            return rotulo
    return FAIXA_FINAL


class BotClientes(BaseBot):
    """Carteira de 12 meses: recência, curva ABC e concentração de receita."""

    def __init__(self, db, cache=None, intervalo: int = INTERVALO_PADRAO):
        super().__init__("clientes", db, cache, intervalo=intervalo)

    def analisar(self) -> dict[str, Any]:
        hoje = date.today()
        hoje_iso = hoje.isoformat()
        # Fim EXCLUSIVO: o primeiro dia do mês seguinte fecha tanto a janela de
        # 12 meses quanto a do mês corrente — daí o mesmo `fim` nas duas.
        fim = _primeiro_do_mes(hoje, -1).isoformat()
        inicio = _primeiro_do_mes(hoje, MESES_JANELA - 1).isoformat()
        mes_inicio = hoje.replace(day=1).isoformat()
        cadastro_novo = (hoje - timedelta(days=DIAS_CADASTRO_NOVO)).isoformat()

        dfs = self.paralelo({
            "carteira": (_SQL_CARTEIRA, (hoje_iso, inicio, fim)),
            "ativos_mes": (_SQL_ATIVOS_MES, (mes_inicio, fim)),
            "novos": (_SQL_NOVOS, (mes_inicio, mes_inicio, cadastro_novo)),
            "serie": (_SQL_SERIE, (inicio, fim)),
        })

        carteira = self._carteira(dfs.get("carteira", pd.DataFrame()))
        if not carteira:
            # Banco fora do ar ≠ carteira vazia. A classe base devolve o último
            # ciclo bom quando `analisar()` volta vazio, mas engoliria um payload
            # zerado como verdade — apagando painel e cache de uma vez. Uma base
            # com 12 meses de movimento não fica sem nenhum comprador; se ficou,
            # a consulta falhou.
            logger.warning("[clientes] carteira vazia — mantendo o ciclo anterior")
            return {}

        abc, classe_de = self._abc(carteira)

        return {
            "kpis": self._kpis(dfs, carteira),
            "segmentacao": self._segmentacao(carteira),
            "abc": abc,
            "ativos_por_mes": self._serie(dfs.get("serie", pd.DataFrame()), hoje),
            "top50": self._top(carteira, classe_de),
        }

    # ── blocos ─────────────────────────────────────────────────────────────
    def _carteira(self, df: pd.DataFrame | None) -> list[dict]:
        """Carteira normalizada e ordenada por receita decrescente.

        A ordenação vem do SQL, mas é refeita aqui porque o ABC depende dela
        para estar correto: se alguém mexer no ORDER BY da consulta, a curva
        sairia silenciosamente errada em vez de quebrar.
        """
        linhas = []
        for r in registros(df):
            ultima = _t(r.get("ultima_compra"))
            linhas.append({
                "codigo": _t(r.get("codigo")),
                "cliente": _t(r.get("cliente")),
                "receita": _f(r.get("receita")),
                "pedidos": _i(r.get("pedidos")),
                "ultima_compra": ultima,
                # Piso 0: compra de hoje é "0 dias", nunca negativa — o relógio
                # do banco pode estar à frente do processo. Sem data de venda a
                # recência é indefinida; o HAVING da consulta garante que isso
                # não acontece, mas o fallback evita classificar um NULL como
                # "Ativo" caso a consulta mude.
                "dias": max(0, _i(r.get("dias"))) if ultima else FAIXAS[-1][1] + 1,
            })
        return sorted(linhas, key=lambda c: c["receita"], reverse=True)

    def _kpis(self, dfs: dict[str, pd.DataFrame],
              carteira: list[dict]) -> dict[str, Any]:
        receita = sum(c["receita"] for c in carteira)
        pedidos = sum(c["pedidos"] for c in carteira)
        # A carteira já chega ordenada por receita: a concentração é a soma do
        # começo da lista, sem uma segunda ida ao banco.
        top = sum(c["receita"] for c in carteira[:TOP_CONCENTRACAO])

        return {
            # Contagem de linhas da carteira: a consulta já agrupa por cliente,
            # então len() é o COUNT(DISTINCT) que não precisou ser consultado.
            "compradores_12m": len(carteira),
            "ativos_mes": _i(_escalar(dfs.get("ativos_mes"), "clientes")),
            "novos_mes": _i(_escalar(dfs.get("novos"), "clientes")),
            "receita_12m": _f(receita),
            # Ticket por PEDIDO, não por cliente: é o tamanho médio do negócio
            # que entra pela porta. Receita/cliente responde outra pergunta
            # (quanto vale um cliente) e já está no top 50, coluna a coluna.
            "ticket_medio": _f(receita / pedidos) if pedidos else 0.0,
            "concentracao_top10": _pct(top, receita),
        }

    def _segmentacao(self, carteira: list[dict]) -> list[dict]:
        """Distribuição da carteira por dias desde a última compra.

        As faixas são fixas e saem todas, inclusive zeradas: o gráfico as trata
        como posições, e omitir uma faixa vazia deslocaria as cores — fazendo
        "Inativo" ser lida como "Em risco".
        """
        contagem: dict[str, int] = {rotulo: 0 for rotulo, _ in FAIXAS}
        contagem[FAIXA_FINAL] = 0
        for cliente in carteira:
            contagem[_faixa(cliente["dias"])] += 1
        rotulos = [r for r, _ in FAIXAS] + [FAIXA_FINAL]
        return [{"faixa": r, "clientes": contagem[r]} for r in rotulos]

    def _abc(self, carteira: list[dict]) -> tuple[list[dict], dict[str, str]]:
        """Curva ABC por receita: A até 80% acumulado, B até 95%, C o resto.

        Devolve as três linhas do resumo e o mapa código→classe, que o top 50
        usa para etiquetar cada cliente — classificar duas vezes abriria a
        chance de a tabela discordar do gráfico ao lado dela.

        Duas sutilezas que só aparecem em carteira concentrada ou com devolução:

        - **O corte olha o acumulado ANTES do cliente**, então quem atravessa a
          linha dos 80% fica na classe que atravessou. Classificar pelo
          acumulado *depois* parece equivalente e não é: numa carteira onde o
          maior cliente sozinho passa de 80%, ele cairia em B e a classe A sairia
          VAZIA — o oposto do que a curva quer dizer. Com esta regra o primeiro
          cliente com receita positiva é sempre A.
        - **O acumulado é travado pelo PICO**, e não pelo valor corrente: cliente
          com receita líquida negativa (devolveu mais do que comprou no período)
          fica no fim da fila e faz o acumulado *cair* de volta abaixo de 95%, o
          que promoveria a cauda de C para B. O pico é monotônico e a curva não
          anda para trás.
        """
        total = sum(c["receita"] for c in carteira)
        if total <= 0:
            # Sem receita positiva na janela não há curva: ninguém é A ou B.
            return ([{"classe": cl, "clientes": len(carteira) if cl == "C" else 0,
                      "receita": 0.0, "percentual": 0.0} for cl in CLASSES],
                    {c["codigo"]: "C" for c in carteira})

        resumo: dict[str, dict[str, float]] = {
            cl: {"clientes": 0, "receita": 0.0} for cl in CLASSES
        }
        classe_de: dict[str, str] = {}
        acumulado = pico = 0.0

        for cliente in carteira:            # já ordenado por receita desc
            classe = "A" if pico < CORTE_A else "B" if pico < CORTE_B else "C"
            acumulado += cliente["receita"]
            pico = max(pico, acumulado / total * 100.0)
            classe_de[cliente["codigo"]] = classe
            resumo[classe]["clientes"] += 1
            resumo[classe]["receita"] += cliente["receita"]

        linhas = [
            {
                "classe": cl,
                "clientes": int(resumo[cl]["clientes"]),
                "receita": _f(resumo[cl]["receita"]),
                "percentual": _pct(resumo[cl]["receita"], total),
            }
            for cl in CLASSES
        ]
        return linhas, classe_de

    def _serie(self, df: pd.DataFrame | None, hoje: date) -> list[dict]:
        """Clientes ativos mês a mês, sempre com os 12 pontos.

        O eixo é montado a partir do calendário e as linhas da consulta são
        encaixadas nele: um mês sem movimento sai com 0 em vez de sumir, que é
        o que faria a série "pular" de julho para setembro e desenhar uma queda
        onde houve ausência de dado.
        """
        linhas = {_t(r.get("mes")): r for r in registros(df)}
        saida = []
        for atras in range(MESES_JANELA - 1, -1, -1):
            chave = _primeiro_do_mes(hoje, atras).isoformat()[:7]
            registro = linhas.get(chave) or {}
            saida.append({
                "mes": _rotulo_mes(chave),
                "ativos": _i(registro.get("ativos")),
            })
        return saida

    def _top(self, carteira: list[dict], classe_de: dict[str, str]) -> list[dict]:
        """Os maiores clientes da janela, já etiquetados por classe e recência."""
        return [
            {
                "codigo": cliente["codigo"],
                "cliente": cliente["cliente"],
                "abc": classe_de.get(cliente["codigo"], "C"),
                "receita": cliente["receita"],
                "pedidos": cliente["pedidos"],
                "ticket": _f(cliente["receita"] / cliente["pedidos"])
                          if cliente["pedidos"] else 0.0,
                "ultima_compra": cliente["ultima_compra"],
                "recencia": _faixa(cliente["dias"]),
            }
            for cliente in carteira[:TOP_CLIENTES]
        ]
