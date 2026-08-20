// Adaptador Financeiro — converte o payload real do bot (GET /dados/financeiro)
// no contrato FinanceiroData consumido pela tela.
//
// Lógica portada do front antigo (hub/frontend/src/pages/Financeiro.jsx +
// doc/ABA_FINANCEIRO.txt):
//   - donut_status vem com 3 fatias ('Concluido', 'AVencer', 'Vencido'); a
//     PÁGINA remove 'Concluido' e mostra só A Vencer × Vencido — não "consertar"
//     o bot (o desktop ui/app.py consome a fatia extra).
//   - foco.recebidoMes = CONTAGEM de títulos recebidos no mês por tipo
//     (qtd_recebido_bol/car) — o payload não tem R$ recebido por tipo e o front
//     antigo exibe "N títulos recebidos" nesse card. Paridade mantida.
//   - Drill-downs (bol_*/car_*/hoje_vencidos) são TOP 200 cada — o detalhe de
//     clientes por dia é parcial em dias com muitos títulos.

import type { FinanceiroData, FocoLinha, TituloVencimento } from "../types";
import { clean, dayOfMonth, isoDate, num, pad2 } from "./shared";

// Linhas cruas do payload do bot — shape validado pelo fixture, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

/** BRL local (2 casas) — sem importar '@/lib/format': o adaptador roda standalone. */
const brlLocal = (v: number): string =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);

/** Um título de drill-down do bot → linha FocoLinha (dias>0 = vencido; dias<0 = a vencer). */
function linhaFoco(r: Row): FocoLinha {
  return {
    cliente: clean(r.NomeCli),
    documento: clean(r.NrDoc),
    dias: num(r.dias),
    valor: num(r.VlrTitulo),
  };
}

export function adaptFinanceiro(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  agora: Date = new Date(),
): FinanceiroData {
  const d: Row = raw ?? {};

  const bolVencidos = asRows(d.bol_vencidos);
  const bolAVencer = asRows(d.bol_a_vencer);
  const carVencidos = asRows(d.car_vencidos);
  const carAVencer = asRows(d.car_a_vencer);
  const hojeVencidos = asRows(d.hoje_vencidos);

  // ── KPIs ───────────────────────────────────────────────────────────────────
  const kpis: FinanceiroData["kpis"] = {
    aReceberQtd: num(d.qtd_total_aberto),
    aReceberValor: num(d.vlr_total_aberto),
    vencidos: num(d.vlr_vencidos),
    aVencer: num(d.vlr_a_vencer),
    recebidoMes: num(d.vlr_recebido_mes),
    inadimplencia: num(d.pct_inadimplencia),
    vencidosQtd: num(d.qtd_vencidos),
    aVencerQtd: num(d.qtd_a_vencer),
    recebidoMesQtd: num(d.qtd_recebido_mes),
  };

  // ── Status dos Títulos (donut 2 fatias: A Vencer × Vencido) ────────────────
  const rotuloStatus: Record<string, string> = { AVencer: "A Vencer", Vencido: "Vencido" };
  const statusTitulos = asRows(d.donut_status)
    .filter((s) => clean(s.status) !== "Concluido")
    .map((s) => ({
      nome: rotuloStatus[clean(s.status)] ?? clean(s.status),
      valor: num(s.valor),
      quantidade: num(s.qtd),
    }))
    // ordem fixa: A Vencer (Cell verde) antes de Vencido (Cell vermelho)
    .sort((a, b) => (a.nome === "A Vencer" ? -1 : b.nome === "A Vencer" ? 1 : 0));

  // ── Vencimentos — próximos 30 dias + drill de clientes por dia ─────────────
  // Um título vencendo HOJE aparece em bol/car_a_vencer (Vencendo<>'Atrasados'
  // inclui 'Hoje') E em hoje_vencidos — dedupe por NrDoc|DtVcto|VlrTitulo.
  const porDia = new Map<string, Map<string, { cliente: string; documento: string; valor: number }>>();
  for (const r of [...bolVencidos, ...bolAVencer, ...carVencidos, ...carAVencer, ...hojeVencidos]) {
    const data = isoDate(r.DtVcto);
    if (!data) continue;
    const chave = `${clean(r.NrDoc)}|${data}|${num(r.VlrTitulo)}`;
    const doDia = porDia.get(data) ?? new Map();
    if (!doDia.has(chave)) {
      doDia.set(chave, {
        cliente: clean(r.NomeCli),
        documento: clean(r.NrDoc),
        valor: num(r.VlrTitulo),
      });
    }
    porDia.set(data, doDia);
  }

  const hojeIso = `${agora.getFullYear()}-${pad2(agora.getMonth() + 1)}-${pad2(agora.getDate())}`;
  const diffDias = (data: string): number =>
    Math.round((Date.parse(data) - Date.parse(hojeIso)) / 86_400_000);

  const vencimentos: TituloVencimento[] = asRows(d.vencimentos_30d).map((r) => {
    const data = isoDate(r.data);
    const diff = diffDias(data);
    // Front antigo: vermelho = vencendo hoje/atrasado · âmbar ≤7d · verde 8–30d.
    const situacao: TituloVencimento["situacao"] =
      diff <= 0 ? "atrasado" : diff <= 7 ? "proximo" : "futuro";
    const clientes = [...(porDia.get(data)?.values() ?? [])].sort((a, b) => b.valor - a.valor);
    return { data, dia: dayOfMonth(data), valor: num(r.valor), situacao, clientes };
  });

  // ── Foco Boleto & Cartão ───────────────────────────────────────────────────
  const bol: Row = d.boleto ?? {};
  const car: Row = d.cartao ?? {};

  const bolRisco = bolVencidos.filter((r) => num(r.dias) > 90).length;
  const carTicket = num(car.qtd_total) > 0 ? num(car.valor_total) / num(car.qtd_total) : 0;

  const foco: FinanceiroData["foco"] = [
    {
      tipo: "Boleto",
      emAberto: num(bol.valor_total),
      vencidos: num(bol.vlr_vencidos),
      aVencer30: num(bol.vlr_a_vencer),
      recebidoMes: num(d.qtd_recebido_bol), // contagem de títulos (paridade front antigo)
      badge: `${bolRisco} em risco >90d`,
      clientes: [...bolVencidos, ...bolAVencer].map(linhaFoco),
    },
    {
      tipo: "Cartão",
      emAberto: num(car.valor_total),
      vencidos: num(car.vlr_vencidos),
      aVencer30: num(car.vlr_a_vencer),
      recebidoMes: num(d.qtd_recebido_car), // contagem de títulos (paridade front antigo)
      badge: `Ticket médio ${brlLocal(carTicket)}`,
      clientes: [...carVencidos, ...carAVencer].map(linhaFoco),
    },
  ];

  // ── Limite de crédito por cliente (boleto, TOP 100) ────────────────────────
  const limites = asRows(d.limite_credito).map((r) => ({
    codigo: clean(r.CodRedCt),
    cliente: clean(r.NomeFantCli),
    limite: num(r.limite_credito),
    utilizado: num(r.utilizado),
    utilizacao: num(r.pct_utilizado),
  }));

  return { kpis, statusTitulos, vencimentos, foco, limites };
}
