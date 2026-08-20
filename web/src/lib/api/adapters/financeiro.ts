// Adaptador Financeiro — converte o payload de GET /dados/financeiro no
// contrato FinanceiroData consumido pela tela.
//
// O servidor já entrega a análise pronta: quantidade por fatia do donut, a
// lista de clientes de cada dia de vencimento (deduplicada), a situação da
// barra e o texto do badge de cada card de foco. O adaptador aqui só
// renomeia campos (snake_case → camelCase), garante tipos/uniões do contrato
// e blinda contra número inválido — nenhuma regra de negócio é recalculada.
//
// Semânticas do contrato que a tela depende:
//   - statusTitulos: exatamente 2 fatias, "A Vencer" antes de "Vencido"
//     (o <Pie> usa <Cell> POSICIONAL: verde na 1ª, vermelho na 2ª).
//   - foco[].recebidoMes = CONTAGEM de títulos recebidos no mês, não R$
//     (a tela renderiza "N títulos" nesse quadrante).
//   - FocoLinha.dias com sinal: > 0 = vencido há N dias; < 0 = vence em N dias.

import type { FinanceiroData, FocoLinha, TituloVencimento } from "../types";
import { clean, dayOfMonth, isoDate, num, pad2 } from "./shared";

// Linhas cruas do payload — shape validado pelo fixture, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

const SITUACOES = new Set<TituloVencimento["situacao"]>(["atrasado", "proximo", "futuro"]);

/**
 * `situacao` já vem calculada pelo servidor, mas chega como string solta —
 * é preciso estreitar para a união do contrato (a cor da barra depende dela).
 * Valor ausente/desconhecido cai no fallback por data: vencido/hoje = atrasado,
 * até 7 dias = proximo, resto = futuro (mesma régua de cores do servidor).
 */
function situacaoVencimento(bruta: unknown, dataIso: string, hojeIso: string): TituloVencimento["situacao"] {
  const s = clean(bruta) as TituloVencimento["situacao"];
  if (SITUACOES.has(s)) return s;
  const diff = Math.round((Date.parse(dataIso) - Date.parse(hojeIso)) / 86_400_000);
  if (!Number.isFinite(diff) || diff <= 0) return "atrasado";
  return diff <= 7 ? "proximo" : "futuro";
}

/** O contrato exige "Cartão" acentuado; o payload pode trazer "Cartao". */
function tipoFoco(x: unknown): "Boleto" | "Cartão" {
  return clean(x).toLowerCase().startsWith("cart") ? "Cartão" : "Boleto";
}

/** Título do drill-down de foco — `dias` mantém o SINAL (vencido × a vencer). */
function linhaFoco(r: Row): FocoLinha {
  return {
    cliente: clean(r.cliente),
    documento: clean(r.documento),
    dias: num(r.dias),
    valor: num(r.valor),
  };
}

export function adaptFinanceiro(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  agora: Date = new Date(),
): FinanceiroData {
  const d: Row = raw ?? {};

  // ── KPIs ───────────────────────────────────────────────────────────────────
  // `inadimplencia` já vem em pontos percentuais (16.52 = 16,52%) — não multiplicar.
  const k: Row = d.kpis ?? {};
  const kpis: FinanceiroData["kpis"] = {
    aReceberQtd: num(k.a_receber_qtd),
    aReceberValor: num(k.a_receber_valor),
    vencidos: num(k.vencidos),
    aVencer: num(k.a_vencer),
    recebidoMes: num(k.recebido_mes),
    inadimplencia: num(k.inadimplencia),
    vencidosQtd: num(k.vencidos_qtd),
    aVencerQtd: num(k.a_vencer_qtd),
    recebidoMesQtd: num(k.recebido_mes_qtd),
  };

  // ── Status dos Títulos (donut: quantidade de títulos) ──────────────────────
  // Montado por NOME e não pela ordem do payload: as <Cell> são posicionais,
  // então a fatia faltante vira zero em vez de trocar as cores de lugar.
  // Fallback nos KPIs, que carregam os mesmos totais.
  const statusPorNome = new Map<string, Row>(
    asRows(d.status_titulos).map((s) => [clean(s.nome), s]),
  );
  const statusTitulos: FinanceiroData["statusTitulos"] = [
    { nome: "A Vencer", valor: kpis.aVencer, quantidade: kpis.aVencerQtd },
    { nome: "Vencido", valor: kpis.vencidos, quantidade: kpis.vencidosQtd },
  ].map((base) => {
    const s = statusPorNome.get(base.nome);
    return s
      ? { nome: base.nome, valor: num(s.valor), quantidade: num(s.quantidade) }
      : base;
  });

  // ── Vencimentos — próximos 30 dias, com os clientes de cada dia ────────────
  const hojeIso = `${agora.getFullYear()}-${pad2(agora.getMonth() + 1)}-${pad2(agora.getDate())}`;
  const vencimentos: TituloVencimento[] = asRows(d.vencimentos).map((v) => {
    const data = isoDate(v.data);
    return {
      data,
      // A barra é rotulada pelo dia do mês; deriva da data se o campo faltar.
      dia: num(v.dia) || dayOfMonth(data),
      valor: num(v.valor),
      situacao: situacaoVencimento(v.situacao, data, hojeIso),
      clientes: asRows(v.clientes).map((c) => ({
        cliente: clean(c.cliente),
        documento: clean(c.documento),
        valor: num(c.valor),
      })),
    };
  });

  // ── Foco Boleto & Cartão ───────────────────────────────────────────────────
  const foco: FinanceiroData["foco"] = asRows(d.foco).map((f) => ({
    tipo: tipoFoco(f.tipo),
    emAberto: num(f.em_aberto),
    vencidos: num(f.vencidos),
    aVencer30: num(f.a_vencer_30),
    recebidoMes: num(f.recebido_mes), // contagem de títulos, não R$
    badge: clean(f.badge),
    clientes: asRows(f.clientes).map(linhaFoco),
  }));

  // ── Limite de crédito por cliente ──────────────────────────────────────────
  // `utilizacao` em pontos percentuais e pode passar de 100 (limite estourado):
  // a tela é que trunca a barra em 100% e marca EXCEDIDO — não limitar aqui.
  const limites: FinanceiroData["limites"] = asRows(d.limites).map((l) => ({
    codigo: clean(l.codigo),
    cliente: clean(l.cliente),
    limite: num(l.limite),
    utilizado: num(l.utilizado),
    utilizacao: num(l.utilizacao),
  }));

  return { kpis, statusTitulos, vencimentos, foco, limites };
}
