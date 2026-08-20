// Adaptador CRM — converte o payload real do bot (GET /dados/crm) no contrato
// CrmData consumido pela tela, com filtro de vendedores 100% client-side.
//
// Lógica portada do front antigo (hub/frontend/src/pages/CRM.jsx + doc/ABA_CRM.txt):
//   - KPIs, funil, evolução semanal e histograma são visões da EMPRESA e
//     permanecem GLOBAIS mesmo com vendedor selecionado (desenho documentado);
//     o filtro recorta apenas as tabelas com dimensão de vendedor.
//   - ranking: propostas/convertidos/taxa/valor/ticket vêm de ranking_vendedores;
//     cancelados vêm de cancelados_por_vendedor (lookup por nome); % da meta
//     individual vem do GET /metas (metas_individuais) — 3º argumento opcional.
//   - conv_por_vendedor e meta_vendedor são IGNORADOS de propósito: o bot mantém
//     conv_por_vendedor sempre vazio (Parte AG, sem consumidor) e meta_vendedor
//     são categorias agregadas para o desktop, não linhas por vendedor.

import type { CrmData, Vendedor } from "../types";
import { clean, isoDate, num } from "./shared";

// Linhas cruas do payload do bot — shape validado pelo fixture, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

/** Chave de comparação de vendedor — trim + lowercase (padrão do front antigo). */
const chave = (x: unknown): string => clean(x).toLowerCase();

export function adaptCrm(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  vendedores: string[],
  // Resposta crua do GET /metas ({ meta_mensal_total, metas_individuais: {nome: meta} }).
  // Opcional — sem ela, percentualMeta fica 0 (sem meta configurada).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metas: any = null,
): CrmData {
  const d: Row = raw ?? {};

  const rankingRaw = asRows(d.ranking_vendedores);
  const cancVendRaw = asRows(d.cancelados_por_vendedor);
  const topCliRaw = asRows(d.top_clientes);
  const novosRaw = asRows(d.clientes_novos_lista);
  const orcAbertosRaw = asRows(d.orc_abertos_lista);
  const riscoRaw = asRows(d.clientes_risco);
  const inativosRaw = asRows(d.inativos_lista);

  // ── Filtro de vendedores (client-side; lista vazia = sem filtro) ───────────
  const sel = new Set(vendedores.map(chave).filter(Boolean));
  const passa = (nome: unknown): boolean => sel.size === 0 || sel.has(chave(nome));

  // ── Opções do filtro — união defensiva (ranking pode vir [] em run degradado)
  const nomes = new Set<string>();
  for (const r of rankingRaw) nomes.add(clean(r.Vendedor ?? r.vendedor));
  for (const r of cancVendRaw) nomes.add(clean(r.Vendedor));
  for (const r of [...topCliRaw, ...novosRaw, ...orcAbertosRaw]) nomes.add(clean(r.vendedor));
  for (const r of [...riscoRaw, ...inativosRaw]) nomes.add(clean(r.ultimo_vendedor));
  nomes.delete("");
  const opcoesVendedores: Vendedor[] = [...nomes].sort().map((nome) => ({ id: nome, nome }));

  // ── Funil do mês (Em Negociação → Fechadas → Faturadas) ────────────────────
  const funil = asRows(d.funil_etapas).map((r) => ({
    etapa: clean(r.etapa),
    valor: num(r.valor),
    percentual: num(r.pct),
  }));

  // ── Evolução semanal — rótulo dd/mm do início da semana ────────────────────
  const semanal = asRows(d.evolucao_semanal).map((r) => {
    const inicio = isoDate(r.inicio_semana);
    const rotulo = inicio ? `${inicio.slice(8, 10)}/${inicio.slice(5, 7)}` : `S${num(r.semana)}`;
    return { semana: rotulo, propostas: num(r.propostas), convertidos: num(r.convertidos) };
  });

  // ── Metas individuais (GET /metas) — match por nome trim+lowercase ─────────
  const metasIndividuais = new Map<string, number>();
  for (const [nome, valor] of Object.entries(metas?.metas_individuais ?? {})) {
    const k = chave(nome);
    if (k) metasIndividuais.set(k, num(valor));
  }

  // ── Ranking da equipe — merge cancelados + % meta, mapeado defensivamente ──
  const cancelados = new Map<string, number>();
  for (const r of cancVendRaw) cancelados.set(chave(r.Vendedor), num(r.cancelados));

  const ranking: CrmData["ranking"] = rankingRaw
    .map((r) => {
      const nome = clean(r.Vendedor ?? r.vendedor);
      const valor = num(r.valor_convertido ?? r.valor);
      const meta = metasIndividuais.get(chave(nome)) ?? 0;
      return {
        vendedor: nome,
        propostas: num(r.propostas),
        conversoes: num(r.convertidos ?? r.conversoes),
        taxa: num(r.taxa_conv ?? r.taxa),
        valor,
        ticket: num(r.ticket_medio ?? r.ticket),
        cancelados: cancelados.get(chave(nome)) ?? 0,
        percentualMeta: meta > 0 ? Math.round((valor / meta) * 100) : 0,
      };
    })
    .filter((r) => r.vendedor && passa(r.vendedor))
    .sort((a, b) => b.valor - a.valor);

  // ── Oportunidades — orçamentos abertos (90d); valor pode vir como STRING ───
  const oportunidades = orcAbertosRaw
    .filter((r) => passa(r.vendedor))
    .map((r) => ({
      numero: clean(r.NrOrcPedVnd),
      cliente: clean(r.cliente),
      vendedor: clean(r.vendedor),
      data: isoDate(r.DtOrcPedVnd),
      diasAberto: num(r.dias_aberto),
      valor: num(r.valor),
    }));

  // ── Carteira ───────────────────────────────────────────────────────────────
  const topClientes = topCliRaw
    .filter((r) => passa(r.vendedor))
    .map((r) => ({
      codigo: clean(r.CodCli),
      cliente: clean(r.nome_cliente),
      valor: num(r.valor_mes),
    }));

  const clientesNovos = novosRaw
    .filter((r) => passa(r.vendedor))
    .map((r) => ({
      codigo: clean(r.CodCli),
      cliente: clean(r.nome_cliente),
      data: isoDate(r.primeira_compra),
      valor: num(r.valor_mes),
    }));

  const histogramaInatividade = asRows(d.faixas_inatividade).map((r) => ({
    faixa: clean(r.faixa),
    clientes: num(r.qtd),
  }));

  // ── Atenção — risco e inativos (filtro pelo ÚLTIMO vendedor) ───────────────
  // clientes_risco não traz receita — valor fica 0 (bot pode ganhar o campo na Fase 2).
  const emRisco = riscoRaw
    .filter((r) => passa(r.ultimo_vendedor))
    .map((r) => ({
      cliente: clean(r.nome_cliente),
      vendedor: clean(r.ultimo_vendedor),
      dias: num(r.dias_inativo),
      valor: 0,
    }));

  const inativos = inativosRaw
    .filter((r) => passa(r.ultimo_vendedor))
    .map((r) => ({
      cliente: clean(r.nome_cliente),
      ultimoVendedor: clean(r.ultimo_vendedor),
      dias: num(r.dias_inativo),
      historico: num(r.faturamento_historico),
    }));

  // ── KPIs ───────────────────────────────────────────────────────────────────
  // Com vendedor(es) selecionado(s), o useCrm busca o endpoint FILTRADO do
  // servidor — os escalares (taxa, pipeline, faturado, propostas no caixa e
  // clientes ativos) já chegam recortados ao vendedor. As contagens de novos/
  // risco/inativos são derivadas das listas filtradas acima (as listas do
  // payload seguem completas e trazem o vendedor por linha).
  const temSelecao = vendedores.length > 0;
  const kpis: CrmData["kpis"] = {
    taxaConversao: num(d.taxa_conversao_pct),
    pipeline: num(d.valor_orcado),
    faturadoMes: num(d.fat_liq_mes),
    propostasCaixa: num(d.valor_faturadas),
    // qtd_ativos_mes_real = COUNT DISTINCT real (CRM v4); qtd_ativos_mes é o
    // proxy legado len(top10) — usado só como fallback de payload antigo.
    clientesAtivos: num(d.qtd_ativos_mes_real) || num(d.qtd_ativos_mes),
    clientesNovos: temSelecao ? clientesNovos.length : num(d.clientes_novos_qtd),
    emRisco: temSelecao ? emRisco.length : num(d.qtd_em_risco),
    inativos: temSelecao ? inativos.length : num(d.qtd_inativos),
  };

  return {
    vendedores: opcoesVendedores,
    kpis,
    funil,
    semanal,
    ranking,
    oportunidades,
    topClientes,
    clientesNovos,
    histogramaInatividade,
    emRisco,
    inativos,
  };
}

/**
 * Mescla N payloads de /dados/crm/filtered (um por vendedor selecionado) num
 * pseudo-payload: escalares somados (taxa/ticket recalculados), funil somado
 * etapa a etapa, top_clientes reunidos e reordenados. As listas globais
 * (novos/risco/inativos/oportunidades) são idênticas entre payloads — vale a
 * do primeiro. Cliente atendido por 2 vendedores selecionados conta em ambos
 * (raro; mesmo compromisso do somatório por vendedor das outras abas).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mesclaCrmFiltrado(payloads: any[]): any {
  if (payloads.length <= 1) return payloads[0] ?? {};
  const base = { ...payloads[0] };
  const soma = (campo: string) => payloads.reduce((s, p) => s + num(p?.[campo]), 0);

  const orc = soma("total_orcamentos");
  const conv = soma("total_convertidos");
  base.total_orcamentos = orc;
  base.total_convertidos = conv;
  base.taxa_conversao_pct = orc > 0 ? (conv / orc) * 100 : 0;
  base.valor_orcado = soma("valor_orcado");
  base.valor_convertido = soma("valor_convertido");
  base.valor_faturadas = soma("valor_faturadas");
  base.fat_liq_mes = soma("fat_liq_mes");
  base.ticket_medio = conv > 0 ? base.valor_convertido / conv : 0;
  base.qtd_ativos_mes_real = soma("qtd_ativos_mes_real");
  base.qtd_ativos_mes = soma("qtd_ativos_mes") || base.qtd_ativos_mes_real;

  const etapas = new Map<string, { etapa: string; qtd: number; valor: number }>();
  for (const p of payloads) {
    for (const e of asRows(p?.funil_etapas)) {
      const nome = clean(e.etapa);
      const alvo = etapas.get(nome) ?? { etapa: nome, qtd: 0, valor: 0 };
      alvo.qtd += num(e.qtd);
      alvo.valor += num(e.valor);
      etapas.set(nome, alvo);
    }
  }
  const total = Math.max(orc, 1);
  base.funil_etapas = [...etapas.values()].map((e) => ({
    ...e,
    pct: Math.round((e.qtd / total) * 1000) / 10,
  }));

  base.top_clientes = payloads
    .flatMap((p) => asRows(p?.top_clientes))
    .sort((a, b) => num(b.valor_mes) - num(a.valor_mes))
    .slice(0, 10);

  return base;
}
