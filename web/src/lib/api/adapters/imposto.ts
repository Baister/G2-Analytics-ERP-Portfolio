// Adaptador Imposto — converte o payload real do bot (GET /dados/imposto) no
// contrato ImpostoData.
//
// Lógica portada do front antigo (hub/frontend/src/pages/Imposto.jsx):
//   - Projeção de ICMS = icms ÷ dias úteis SP decorridos × dias úteis do mês
//     (hoje conta como decorrido).
//   - "Isentas/Outras IPI" soma isentas_ipi + outras_ipi (colunas do livro IPI).
//   - CFOPs ordenados por ICMS desc (top 10); Dentro×Fora pelo rótulo `uf` do
//     bot (1º dígito do CFOP: 5=dentro · 6=fora · 7=exterior).
//
// ImpostoData não expõe campos de variação vs mês anterior — raw.deltas e
// raw.kpis_ant ficam sem uso aqui (Fase 2).

import type { ImpostoData } from "../types";
import { clean, countBusinessDaysSP, isoDate, num, remainingBusinessDaysSP } from "./shared";

// Linhas cruas do payload do bot — shape validado pelo fixture, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

/** Projeção do ICMS do mês pelo ritmo de dias úteis SP já decorridos. */
function projecaoIcms(icms: number, agora: Date = new Date()): number {
  if (!icms) return 0;
  const ano = agora.getFullYear();
  const mes = agora.getMonth() + 1;
  const total = countBusinessDaysSP(ano, mes);
  const restantes = remainingBusinessDaysSP(ano, mes);
  const decorridos = Math.max(total - restantes + 1, 1); // hoje conta como decorrido
  return (icms / decorridos) * total;
}

/** Dentro do Estado pelo rótulo do bot; fallback: 1º dígito do CFOP = 5. */
function ehDentroEstado(row: Row): boolean {
  const uf = clean(row.uf);
  if (uf) return uf === "Dentro do Estado";
  return clean(row.cfop).charAt(0) === "5";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function adaptImposto(raw: any): ImpostoData {
  const r: Row = raw ?? {};
  const k: Row = r.kpis ?? {};

  // ── 12 KPIs fiscais ────────────────────────────────────────────────────────
  const kpis: ImpostoData["kpis"] = {
    icmsMes: num(k.icms),
    aliquotaEfetiva: num(k.aliquota_efetiva),
    projecaoIcms: projecaoIcms(num(k.icms)),
    baseCalculo: num(k.base_icms),
    faturamentoNfs: num(k.faturamento),
    qtdeNfs: num(k.qtd_nf),
    stOutras: num(k.outras), // ICMS-ST retido na origem (CFOP 5405/6404)
    isentasIcms: num(k.isentas),
    icmsStDestacado: num(k.icms_st),
    ipiDebitado: num(k.ipi),
    isentasIpi: num(k.isentas_ipi) + num(k.outras_ipi),
    frete: num(k.frete),
  };

  // ── ICMS dia a dia (dia vem como string '01'…'31') ─────────────────────────
  const diario: ImpostoData["diario"] = asRows(r.icms_diario).map((d) => ({
    dia: num(d.dia),
    icms: num(d.icms),
  }));

  // ── Evolução 12 meses (ICMS · ST · IPI + alíquota efetiva) ─────────────────
  const evolucao: ImpostoData["evolucao"] = asRows(r.evolucao_mensal).map((m) => ({
    mes: clean(m.mes),
    icms: num(m.icms),
    st: num(m.icms_st),
    ipi: num(m.ipi),
    aliquota: num(m.aliquota),
  }));

  // ── Análise por CFOP — top 10 por ICMS (a pizza Dentro×Fora deriva daqui) ──
  const cfops: ImpostoData["cfops"] = asRows(r.por_cfop)
    .map((c) => ({
      cfop: clean(c.cfop),
      descricao: clean(c.descricao),
      valor: num(c.total),
      icms: num(c.icms),
      dentroEstado: ehDentroEstado(c),
    }))
    .sort((a, b) => b.icms - a.icms)
    .slice(0, 10);

  // ── Evolução 6 meses por CFOP → agregada Dentro×Fora do Estado ─────────────
  // cfop_evolucao traz uma coluna por CFOP (chaves em cfop_series).
  const series = asRows(r.cfop_series).map(clean).filter(Boolean);
  const cfopEvolucao: ImpostoData["cfopEvolucao"] = asRows(r.cfop_evolucao).map((row) => {
    const chaves = series.length ? series : Object.keys(row).filter((c) => c !== "mes");
    let dentro = 0;
    let fora = 0;
    for (const c of chaves) {
      const v = num(row[c]);
      if (c.charAt(0) === "5") dentro += v;
      else fora += v; // 6xxx (fora do estado) e 7xxx (exterior)
    }
    return { mes: clean(row.mes), dentro, fora };
  });

  // ── Maiores NFs do mês por ICMS ────────────────────────────────────────────
  const maioresNfs: ImpostoData["maioresNfs"] = asRows(r.top_nfs).map((n) => ({
    nf: clean(n.nr_nf),
    cliente: clean(n.cliente),
    data: isoDate(n.data),
    valor: num(n.total),
    icms: num(n.icms),
  }));

  // ── Situações tributárias de saída (TABELA_TRIBUTACAO — qtd de itens por situação) ─
  // O tooltip da pizza formata como percentual → converte contagem em % do total.
  const situacoesQtd = asRows(r.trib_distribuicao).map((s) => ({
    nome: clean(s.label),
    valor: num(s.qtd_itens),
  }));
  const totalSituacoes = situacoesQtd.reduce((acc, s) => acc + s.valor, 0);
  const situacoes: ImpostoData["situacoes"] = situacoesQtd.map((s) => ({
    nome: s.nome,
    valor: totalSituacoes > 0 ? (s.valor / totalSituacoes) * 100 : 0,
  }));

  // ── Regras PIS/COFINS (cadastro do ERP) ────────────────────────────────────
  const regrasPisCofins: ImpostoData["regrasPisCofins"] = asRows(r.pis_cofins).map((p) => ({
    regra: clean(p.descricao),
    itens: 0, // sem fonte no bot atual (Fase 2)
    valor: 0, // sem fonte no bot atual (Fase 2)
  }));

  // ── Itens vendidos no mês × tributação ─────────────────────────────────────
  const itensTributacao: ImpostoData["itensTributacao"] = asRows(r.itens_tributacao).map((i) => ({
    codigo: clean(i.cod_item),
    descricao: clean(i.descricao),
    cst: clean(i.trib_sai), // situação tributária de saída (proxy do CST no ERP)
    ncm: "", // sem fonte no bot atual (Fase 2)
    aliquota: 0, // sem fonte no bot atual (Fase 2)
    valor: num(i.valor_vendido),
  }));

  return {
    kpis,
    diario,
    evolucao,
    cfops,
    cfopEvolucao,
    maioresNfs,
    situacoes,
    regrasPisCofins,
    itensTributacao,
  };
}
