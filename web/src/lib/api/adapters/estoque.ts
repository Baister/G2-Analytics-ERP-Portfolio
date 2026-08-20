// Adaptador Estoque — converte o payload real do bot (GET /dados/estoque) no
// contrato EstoqueData. Fonte da verdade: dict retornado por
// BotEstoque.analisar() (bots/analise_bots.py) — a entrada "estoque" de
// PAYLOADS_REAIS.json está atrofiada e foi ignorada.
//
// Semântica portada do front antigo (hub/frontend/src/pages/Estoque.jsx):
//   - VlrEstq = valor do estoque do item AO CUSTO (total, não unitário);
//     o custo unitário exibido na tabela é derivado (VlrEstq ÷ QtdEstq).
//   - Estoque Parado (KPI) = parado_valor em R$ (imobilizado 90+ dias sem venda).
//   - Curva ABC pelo valor vendido 90d: A=80% · B=15% · C=5% (abc_resumo).
//   - Evolução 12 meses = evolucao_estimada (reconstruída pelos movimentos,
//     valorada ao custo médio atual).
//
// Filtros grupo/subgrupo: tabela_detalhada NÃO traz CodGrpItem/CodSubGrpItem
// (só sugestao_transferencia tem, sem valor de estoque) — sem fonte no bot
// atual (Fase 2); o contrato EstoqueData tampouco expõe essas dimensões hoje.

import type { EstoqueData, EstoqueItem } from "../types";
import { clean, isoDate, num } from "./shared";

// Linhas cruas do payload do bot — shape validado pelo fixture, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

/** Sentinela para item sem última venda registrada ("nunca vendido"). */
const DIAS_NUNCA_VENDIDO = 9999;

function classeABC(x: unknown): "A" | "B" | "C" {
  const c = clean(x).toUpperCase();
  return c === "A" || c === "B" ? c : "C";
}

/** Dias desde a última venda (DtUltVnd 'YYYY-MM-DD'); sem data → sentinela. */
function diasSemVenda(dtUltVnd: unknown, agora: number): number {
  const iso = isoDate(dtUltVnd);
  const t = Date.parse(iso);
  if (!iso || Number.isNaN(t)) return DIAS_NUNCA_VENDIDO;
  return Math.max(Math.floor((agora - t) / 86400000), 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function adaptEstoque(raw: any): EstoqueData {
  const r: Row = raw ?? {};

  // ── KPIs ───────────────────────────────────────────────────────────────────
  const kpis: EstoqueData["kpis"] = {
    valorEstoque: num(r.valor_total_estoque),
    qtdEstoque: num(r.qtd_total),
    skus: num(r.skus) || num(r.total_itens),
    abaixoMinimo: num(r.abaixo_min_qtd),
    semEstoque: num(r.itens_zerados),
    estoqueParado: num(r.parado_valor), // R$ imobilizado (a tela formata como BRL)
    coberturaMedia: num(r.cobertura_media_dias), // bot manda null sem demanda → 0
  };

  // ── Curva ABC 90 dias (cartões A/B/C + rosca) ──────────────────────────────
  const abc: EstoqueData["abc"] = asRows(r.abc_resumo).map((a) => ({
    classe: classeABC(a.classe),
    itens: num(a.itens),
    percentualVendas: num(a.pct_valor_vendido),
    valorEstoque: num(a.valor_estoque),
  }));

  // ── Valor por marca (top 10; bot já ordena por valor desc) ─────────────────
  const valorPorMarca: EstoqueData["valorPorMarca"] = asRows(r.por_marca)
    .map((m) => ({ marca: clean(m.DescrMarca), valor: num(m.valor_estoque) }))
    .filter((m) => m.marca)
    .sort((a, b) => b.valor - a.valor)
    .slice(0, 10);

  // ── Evolução 12 meses (série estimada — a real ainda é curta) ──────────────
  const evolucao: EstoqueData["evolucao"] = asRows(r.evolucao_estimada).map((e) => ({
    mes: clean(e.mes),
    valor: num(e.valor_estimado),
    quantidade: num(e.qtd),
  }));

  // ── Tabela geral de itens (tabela_detalhada = itens com estoque) ───────────
  const agora = Date.now();
  const itens: EstoqueItem[] = asRows(r.tabela_detalhada).map((t) => {
    const quantidade = num(t.QtdEstq);
    const valor = num(t.VlrEstq); // valor total ao custo
    return {
      codigo: clean(t.CodItem),
      descricao: clean(t.DescrItem),
      marca: clean(t.DescrMarca),
      quantidade,
      disponivel: num(t.QtdEstqDisp),
      diasSemVenda: diasSemVenda(t.DtUltVnd, agora),
      custo: quantidade > 0 ? valor / quantidade : 0, // custo unitário médio derivado
      valor,
      classe: classeABC(t.abc),
    };
  });

  return { kpis, abc, valorPorMarca, evolucao, itens };
}
