// Adaptador Carteira de Clientes — converte o payload real do bot
// (GET /dados/cliente_comportamento) no contrato ClientesCarteira da tela.
//
// Fonte: fixture cliente_comportamento.json + bot em bots/analise_bots.py +
// front antigo (hub/frontend/src/pages/ClienteComportamento.jsx).
//
// Mapeamento (payload → contrato):
//   kpis.clientes_12m → compradores12m · ativos_mes → ativosMes ·
//   novos_mes → novosMes · receita_12m → receita12m · ticket_medio →
//   ticketMedio · top10_pct → concentracaoTop10
//   segmentacao[{faixa,qtd,receita}] → {faixa, clientes} (rótulos prontos do
//   bot, mesmas faixas de recência da aba Cliente; receita fica no bot)
//   abc_resumo[{classe,clientes,receita,pct_receita}] → abc
//   evolucao[{mes,ativos,receita}] → ativosPorMes (mes = 'MM/AAAA')
//   top_clientes (50) → top50; recência derivada de `dias` (calculado no bot)
//     com as mesmas faixas do perfil 360º (situacaoPorDias).

import type { ClientesCarteira } from "../types";
import { clean, isoDate, num } from "./shared";
import { situacaoPorDias } from "./cliente";

// Linhas cruas do payload do bot — shape validado pelo fixture, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

/** 'A' | 'B' | 'C' defensivo (payload manda string). */
function classeABC(x: unknown): "A" | "B" | "C" {
  const c = clean(x).toUpperCase();
  return c === "A" || c === "B" ? c : "C";
}

export function adaptClientesCarteira(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
): ClientesCarteira {
  const d: Row = raw ?? {};
  const k: Row = d.kpis ?? {};

  return {
    kpis: {
      compradores12m: num(k.clientes_12m),
      ativosMes: num(k.ativos_mes),
      novosMes: num(k.novos_mes),
      receita12m: num(k.receita_12m),
      ticketMedio: num(k.ticket_medio),
      concentracaoTop10: num(k.top10_pct),
    },

    // 4 faixas de recência — rótulos vêm prontos do bot
    segmentacao: asRows(d.segmentacao).map((r) => ({
      faixa: clean(r.faixa),
      clientes: num(r.qtd),
    })),

    abc: asRows(d.abc_resumo).map((r) => ({
      classe: classeABC(r.classe),
      clientes: num(r.clientes),
      receita: num(r.receita),
      percentual: num(r.pct_receita),
    })),

    ativosPorMes: asRows(d.evolucao).map((r) => ({
      mes: clean(r.mes),
      ativos: num(r.ativos),
    })),

    top50: asRows(d.top_clientes)
      .slice(0, 50)
      .map((r) => ({
        codigo: clean(r.CodCli),
        cliente: clean(r.nome),
        abc: classeABC(r.abc),
        receita: num(r.receita),
        pedidos: num(r.pedidos),
        ticket: num(r.ticket),
        ultimaCompra: isoDate(r.ultima_compra),
        recencia: situacaoPorDias(r.dias == null ? null : num(r.dias)),
      })),
  };
}
