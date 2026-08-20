"""Bot de estoque — posição imobilizada, itens parados e curva ABC.

Três decisões guiam todos os números deste painel:

1. **A posição vem da tabela de estoque; o giro, do histórico de itens.** Não se
   reconstrói saldo somando movimento: o saldo é o que a tabela de estoque diz.
   O histórico entra só para responder "isso gira?" — faturamento dos últimos
   90 dias (curva ABC) e consumo médio diário (cobertura).

2. **Giro é medido pelo líquido.** Devolução chega com quantidade e valor
   negativos na origem, então somar sem filtrar tipo já desconta o que voltou —
   que é o correto: mercadoria devolvida voltou para a prateleira e não deve
   contar como consumo. Documento cancelado fica de fora: existe como registro,
   não como movimento.

3. **Nunca vendido ≠ parado há muito tempo.** Um item sem nenhuma venda no
   histórico não tem "dias sem venda" calculável. Em vez de inventar a idade do
   cadastro, o payload manda a sentinela 9999 e a interface escreve "nunca" —
   ordenar por essa coluna continua jogando o item para o fim da fila, que é o
   comportamento desejado.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Any

import pandas as pd

from bots.base import BaseBot, registros

logger = logging.getLogger(__name__)

#: Ciclo de 10 min: saldo de estoque não muda de minuto a minuto (a leitura é
#: "o que está parado", não "o que acabou de sair") e duas das três consultas
#: varrem 90 dias e 12 meses de itens. Mais curto gastaria banco à toa.
INTERVALO_PADRAO = 600

MESES_ABREV = (
    "jan.", "fev.", "mar.", "abr.", "mai.", "jun.",
    "jul.", "ago.", "set.", "out.", "nov.", "dez.",
)

#: Disponível abaixo disto acende o alerta de reposição. Sem cadastro de
#: estoque mínimo por SKU na base, um piso único é a aproximação honesta.
MINIMO_DISPONIVEL = 10.0

#: Dias sem venda a partir dos quais o valor entra em "estoque parado".
DIAS_PARADO = 90

#: Janela de giro usada pela ABC e pela cobertura.
JANELA_GIRO = 90

#: Sentinela para "nunca vendeu" — ver docstring do módulo.
NUNCA_VENDEU = 9999

MESES_EVOLUCAO = 12
LIMITE_ITENS = 300
LIMITE_MARCAS = 10

# Posição completa (uma linha por SKU). São centenas de linhas, não milhares:
# vale trazer tudo e derivar KPIs, valor por marca e a lista de itens do mesmo
# recorte — assim os três blocos nunca divergem entre si por causa de dois
# GROUP BY diferentes.
# `julianday(NULL)` devolve NULL, então item nunca vendido chega com
# dias_sem_venda nulo e vira a sentinela no Python.
SQL_POSICAO = """
    SELECT p.codigo                        AS codigo,
           p.descricao                     AS descricao,
           m.nome                          AS marca,
           e.quantidade                    AS quantidade,
           e.reservado                     AS reservado,
           e.quantidade - e.reservado      AS disponivel,
           p.custo                         AS custo,
           e.quantidade * p.custo          AS valor,
           CAST(julianday(?) - julianday(e.ultima_venda) AS INTEGER) AS dias_sem_venda
      FROM estoque e
      JOIN produto p ON p.codigo = e.produto_codigo
      JOIN marca m ON m.id = p.marca_id
     ORDER BY e.quantidade * p.custo DESC
"""

# Giro por SEM filtro de tipo: devolução é negativa e se abate sozinha.
SQL_GIRO = """
    SELECT i.produto_codigo                   AS codigo,
           COALESCE(SUM(i.valor_total), 0.0)  AS valor,
           COALESCE(SUM(i.quantidade), 0.0)   AS quantidade
      FROM documento d
      JOIN item i ON i.documento_numero = d.numero
     WHERE d.data >= ? AND d.data < ? AND d.cancelado = 0
     GROUP BY i.produto_codigo
"""

# Proxy de giro mês a mês: o banco guarda a posição de estoque de HOJE, não uma
# série histórica de saldo. O que dá para reconstruir é o fluxo — quanto saiu
# por mês — e é isso que a evolução mostra.
SQL_EVOLUCAO = """
    SELECT substr(d.data, 1, 7)               AS mes,
           COALESCE(SUM(i.valor_total), 0.0)  AS valor,
           COALESCE(SUM(i.quantidade), 0.0)   AS quantidade
      FROM documento d
      JOIN item i ON i.documento_numero = d.numero
     WHERE d.data >= ? AND d.data < ? AND d.cancelado = 0
     GROUP BY substr(d.data, 1, 7)
     ORDER BY mes
"""


# ── conversões para JSON ───────────────────────────────────────────────────
# pandas devolve numpy.int64/float64 e NaN: o primeiro o json.dumps recusa, o
# segundo ele serializa como literal inválido. Tudo que entra no payload passa
# por um destes.
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


class BotEstoque(BaseBot):
    """Fecha a posição de estoque: KPIs, curva ABC, imobilizado e giro."""

    def __init__(self, db, cache=None, intervalo: int = INTERVALO_PADRAO):
        super().__init__("estoque", db, cache, intervalo=intervalo)

    def analisar(self) -> dict[str, Any]:
        hoje = date.today()
        giro_ini = (hoje - timedelta(days=JANELA_GIRO)).isoformat()
        # Fim exclusivo em AMANHÃ: `data < hoje` perderia o movimento do próprio
        # dia, e é justamente ele que o painel é aberto para conferir.
        giro_fim = (hoje + timedelta(days=1)).isoformat()

        evo_ini = _primeiro_do_mes(hoje, MESES_EVOLUCAO - 1)
        evo_fim = _primeiro_do_mes(hoje, -1)

        dfs = self.paralelo({
            "posicao": (SQL_POSICAO, (hoje.isoformat(),)),
            "giro": (SQL_GIRO, (giro_ini, giro_fim)),
            "evolucao": (SQL_EVOLUCAO, (evo_ini.isoformat(), evo_fim.isoformat())),
        })

        posicao = registros(dfs.get("posicao", pd.DataFrame()))
        if not posicao:
            # Estoque vazio não é um estado real desta operação — é consulta que
            # falhou. Devolver {} faz a base manter o último ciclo bom em vez de
            # apagar o painel (e o cache) com zeros.
            logger.warning("[estoque] posição não retornou linhas — "
                           "mantendo o ciclo anterior")
            return {}

        giro = registros(dfs.get("giro", pd.DataFrame()))
        venda_por_codigo = {str(r["codigo"]): _f(r.get("valor")) for r in giro}
        qtd_por_codigo = {str(r["codigo"]): _f(r.get("quantidade")) for r in giro}

        classe_por_codigo, abc = self._abc(posicao, venda_por_codigo)

        return {
            "kpis": self._kpis(posicao, qtd_por_codigo),
            "abc": abc,
            "valor_por_marca": self._por_marca(posicao),
            "evolucao": self._evolucao(dfs.get("evolucao", pd.DataFrame()), hoje),
            "itens": self._itens(posicao, classe_por_codigo),
        }

    # ── blocos ─────────────────────────────────────────────────────────────
    def _kpis(self, posicao: list[dict], qtd_por_codigo: dict[str, float]) -> dict[str, Any]:
        valor_total = sum(_f(r.get("valor")) for r in posicao)
        qtd_total = sum(_f(r.get("quantidade")) for r in posicao)

        abaixo = sum(1 for r in posicao
                     if _f(r.get("disponivel")) < MINIMO_DISPONIVEL)
        zerados = sum(1 for r in posicao if _f(r.get("quantidade")) <= 0)
        parado = sum(_f(r.get("valor")) for r in posicao
                     if self._dias_sem_venda(r) >= DIAS_PARADO)

        # Cobertura: quantos dias o saldo atual aguenta no ritmo dos últimos 90.
        # Consumo é o líquido (devolução já entrou negativa); se ele for zero ou
        # negativo — período sem saída, ou mais devolução que venda — a divisão
        # não tem significado e o KPI vai a zero em vez de a infinito.
        consumo_90d = sum(qtd_por_codigo.values())
        consumo_dia = consumo_90d / JANELA_GIRO if consumo_90d > 0 else 0.0

        return {
            "valor_estoque": _f(valor_total),
            "qtd_estoque": _f(qtd_total),
            "skus": len(posicao),
            "abaixo_minimo": abaixo,
            "sem_estoque": zerados,
            "estoque_parado": _f(parado),
            "cobertura_media": _f(qtd_total / consumo_dia) if consumo_dia > 0 else 0.0,
        }

    def _abc(self, posicao: list[dict],
             venda_por_codigo: dict[str, float]) -> tuple[dict[str, str], list[dict]]:
        """Curva ABC pelo faturamento de 90 dias: A até 80%, B até 95%, C o resto.

        Duas decisões de interpretação:

        * O universo é a união do que está em estoque com o que vendeu no
          período. Um SKU zerado que vendeu muito ainda é classe A (e é
          exatamente o item que não podia ter zerado); um SKU parado sem
          nenhuma venda cai em C carregando seu valor imobilizado.
        * O item que CRUZA o limiar entra na classe de cima. É a convenção
          usual — "A responde por pelo menos 80% do faturamento" —, senão o
          maior item de todos poderia sozinho estourar 80% e sobrar um A vazio.
        """
        valor_estoque: dict[str, float] = {}
        for r in posicao:
            valor_estoque[str(r["codigo"])] = _f(r.get("valor"))

        universo = set(valor_estoque) | set(venda_por_codigo)
        total_vendas = sum(venda_por_codigo.get(c, 0.0) for c in universo)

        # Desempate pelo código: sem ele, itens com o mesmo faturamento (todos
        # os zerados, por exemplo) mudariam de classe entre ciclos.
        ordenado = sorted(universo,
                          key=lambda c: (-venda_por_codigo.get(c, 0.0), c))

        classe_por_codigo: dict[str, str] = {}
        resumo = {c: {"itens": 0, "vendas": 0.0, "valor": 0.0} for c in ("A", "B", "C")}

        acumulado = 0.0
        for codigo in ordenado:
            vendas = venda_por_codigo.get(codigo, 0.0)
            # Percentual ANTES de somar o item: é o que coloca o item que cruza
            # o limiar na classe de cima. Sem faturamento no período, tudo cai
            # em C (100.0 força o último ramo).
            antes = (acumulado / total_vendas * 100.0) if total_vendas > 0 else 100.0
            classe = "A" if antes < 80.0 else "B" if antes < 95.0 else "C"
            classe_por_codigo[codigo] = classe

            linha = resumo[classe]
            linha["itens"] += 1
            linha["vendas"] += vendas
            linha["valor"] += valor_estoque.get(codigo, 0.0)
            acumulado += vendas

        # Sempre A, B e C nesta ordem, mesmo zeradas: a interface desenha três
        # faixas fixas e some com uma delas mudaria a cor das outras duas.
        return classe_por_codigo, [
            {
                "classe": c,
                "itens": int(resumo[c]["itens"]),
                "percentual_vendas": _pct(resumo[c]["vendas"], total_vendas),
                "valor_estoque": _f(resumo[c]["valor"]),
            }
            for c in ("A", "B", "C")
        ]

    def _por_marca(self, posicao: list[dict]) -> list[dict]:
        """Top 10 marcas por valor imobilizado."""
        acumulado: dict[str, float] = {}
        for r in posicao:
            marca = str(r.get("marca") or "—")
            acumulado[marca] = acumulado.get(marca, 0.0) + _f(r.get("valor"))
        ordenado = sorted(acumulado.items(), key=lambda kv: kv[1], reverse=True)
        return [{"marca": m, "valor": _f(v)} for m, v in ordenado[:LIMITE_MARCAS]]

    def _evolucao(self, df: pd.DataFrame, hoje: date) -> list[dict]:
        """Doze meses de saída (valor e quantidade), sem buracos na série.

        O esqueleto é montado em Python e preenchido com o que veio do banco:
        um mês sem movimento entra com zero em vez de sumir do eixo, senão o
        gráfico comprimiria o intervalo e sugeriria continuidade onde não houve.
        """
        por_mes = {str(r["mes"]): r for r in registros(df)}
        linhas: list[dict] = []
        for atras in range(MESES_EVOLUCAO - 1, -1, -1):
            chave = _primeiro_do_mes(hoje, atras).strftime("%Y-%m")
            registro = por_mes.get(chave, {})
            linhas.append({
                "mes": _rotulo_mes(chave),
                "valor": _f(registro.get("valor")),
                "quantidade": _f(registro.get("quantidade")),
            })
        return linhas

    def _itens(self, posicao: list[dict],
               classe_por_codigo: dict[str, str]) -> list[dict]:
        """Até 300 SKUs, já ordenados por valor imobilizado (ORDER BY do SQL)."""
        return [
            {
                "codigo": str(r["codigo"]),
                "descricao": str(r.get("descricao") or ""),
                "marca": str(r.get("marca") or "—"),
                "quantidade": _f(r.get("quantidade")),
                "disponivel": _f(r.get("disponivel")),
                "dias_sem_venda": self._dias_sem_venda(r),
                "custo": _f(r.get("custo")),
                "valor": _f(r.get("valor")),
                "classe": classe_por_codigo.get(str(r["codigo"]), "C"),
            }
            for r in posicao[:LIMITE_ITENS]
        ]

    @staticmethod
    def _dias_sem_venda(registro: dict) -> int:
        """Idade da última saída; sentinela quando nunca houve uma.

        O SQL devolve NULL para item sem venda (julianday de NULL é NULL) e o
        negativo não existe, mas a data do banco pode estar à frente de `hoje`
        num fuso diferente — o piso em zero evita "-1 dia sem venda" na tela.
        """
        dias = registro.get("dias_sem_venda")
        if dias is None:
            return NUNCA_VENDEU
        return max(0, _i(dias))
