// Adaptador Imposto — traduz o payload de GET /dados/imposto no contrato
// ImpostoData consumido pela aba Imposto.
//
// O backend passou a entregar a apuração inteira já calculada, agregada e
// ordenada: os 12 KPIs fiscais prontos (projeção inclusive), o ICMS dia a dia,
// a evolução de 12 meses com a alíquota efetiva, os CFOPs já classificados como
// dentro/fora do estado, a série de 6 meses já somada nesses dois grupos, as
// maiores NFs, a distribuição por situação tributária com o percentual pronto,
// as regras PIS/COFINS e os itens × tributação com NCM e alíquota. Sobrou para
// cá a tradução snake_case → camelCase e o saneamento de tipos.
//
// Deixou de ser feito aqui (virou responsabilidade do servidor): a projeção do
// ICMS por dias úteis decorridos, a soma "isentas + outras" do livro de IPI, a
// ordenação/corte do top de CFOPs, a inferência de dentro do estado pelo 1º
// dígito do CFOP, a soma por coluna da evolução de CFOP em dentro × fora e o
// cálculo do percentual das situações tributárias a partir da contagem de itens.
//
// Regras que a tela exige:
//   - situacoes[].valor alimenta uma pizza com tooltip em percentual: o campo
//     precisa ser a PARTICIPAÇÃO em pontos percentuais (42.58), não o R$.
//   - cfops[].dentroEstado governa a pizza "Dentro × Fora do Estado", que soma
//     valor por grupo — um booleano errado move dinheiro de fatia.
//   - a ordem de cfops/maioresNfs/itensTributacao é a do servidor (já ranqueada);
//     reordenar aqui só divergiria do que a exportação Excel mostra.
//   - alíquotas em pontos percentuais (12.37 = 12,37%), como o payload manda.

import type { ImpostoData } from "../types";
import { clean, isoDate, num } from "./shared";

// Linhas cruas da API — shape validado pelo payload de referência, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

/**
 * Booleano defensivo. O payload manda `true`/`false` de verdade, mas o campo
 * nasce de uma coluna fiscal e um driver pode entregá-lo como 1/0 ou "true" —
 * Boolean("false") daria true e jogaria a nota no grupo errado da pizza.
 */
function flag(x: unknown): boolean {
  return x === true || x === 1 || x === "1" || x === "true";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function adaptImposto(raw: any): ImpostoData {
  const r: Row = raw ?? {};
  const k: Row = r.kpis ?? {};

  // ── 12 KPIs fiscais (todos prontos no payload) ─────────────────────────────
  const kpis: ImpostoData["kpis"] = {
    icmsMes: num(k.icms_mes),
    aliquotaEfetiva: num(k.aliquota_efetiva),
    projecaoIcms: num(k.projecao_icms),
    baseCalculo: num(k.base_calculo),
    faturamentoNfs: num(k.faturamento_nfs),
    qtdeNfs: num(k.qtde_nfs),
    stOutras: num(k.st_outras),
    isentasIcms: num(k.isentas_icms),
    icmsStDestacado: num(k.icms_st_destacado),
    ipiDebitado: num(k.ipi_debitado),
    isentasIpi: num(k.isentas_ipi),
    frete: num(k.frete),
  };

  // ── ICMS dia a dia (dia já vem como número do mês) ─────────────────────────
  const diario: ImpostoData["diario"] = asRows(r.diario).map((d) => ({
    dia: num(d.dia),
    icms: num(d.icms),
  }));

  // ── Evolução 12 meses (ICMS · ST · IPI + alíquota efetiva no eixo direito) ─
  const evolucao: ImpostoData["evolucao"] = asRows(r.evolucao).map((m) => ({
    mes: clean(m.mes),
    icms: num(m.icms),
    st: num(m.st),
    ipi: num(m.ipi),
    aliquota: num(m.aliquota),
  }));

  // ── CFOPs do mês (ordem do servidor) — a pizza Dentro × Fora deriva daqui ──
  // Devoluções chegam com valor/ICMS negativos e seguem assim de propósito:
  // elas abatem o grupo a que pertencem na soma da pizza.
  const cfops: ImpostoData["cfops"] = asRows(r.cfops).map((c) => ({
    cfop: clean(c.cfop),
    descricao: clean(c.descricao),
    valor: num(c.valor),
    icms: num(c.icms),
    dentroEstado: flag(c.dentro_estado),
  }));

  // ── Evolução 6 meses já agregada em dentro × fora do estado ────────────────
  const cfopEvolucao: ImpostoData["cfopEvolucao"] = asRows(r.cfop_evolucao).map((e) => ({
    mes: clean(e.mes),
    dentro: num(e.dentro),
    fora: num(e.fora),
  }));

  // ── Maiores NFs do mês por valor ───────────────────────────────────────────
  const maioresNfs: ImpostoData["maioresNfs"] = asRows(r.maiores_nfs).map((n) => ({
    nf: clean(n.nf),
    cliente: clean(n.cliente),
    data: isoDate(n.data), // a tela formata a data; corta hora se o payload trouxer
    valor: num(n.valor),
    icms: num(n.icms),
  }));

  // ── Situações tributárias — pizza em percentual ────────────────────────────
  // O payload traz `valor` em R$ e `percentual` (participação, em pontos
  // percentuais). O contrato só tem `valor` e a tela o renderiza com tooltip de
  // percentual, então o que entra aqui é o `percentual`, não o R$.
  const situacoes: ImpostoData["situacoes"] = asRows(r.situacoes).map((s) => ({
    nome: clean(s.nome),
    valor: num(s.percentual),
  }));

  // ── Regras PIS/COFINS (itens e valor agora vêm do servidor) ────────────────
  const regrasPisCofins: ImpostoData["regrasPisCofins"] = asRows(r.regras_pis_cofins).map((p) => ({
    regra: clean(p.regra),
    itens: num(p.itens),
    valor: num(p.valor),
  }));

  // ── Itens vendidos no mês × tributação (CST, NCM e alíquota reais) ─────────
  const itensTributacao: ImpostoData["itensTributacao"] = asRows(r.itens_tributacao).map((i) => ({
    codigo: clean(i.codigo),
    descricao: clean(i.descricao),
    cst: clean(i.cst), // código de situação tributária, com zeros à esquerda → string
    ncm: clean(i.ncm),
    aliquota: num(i.aliquota),
    valor: num(i.valor),
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
