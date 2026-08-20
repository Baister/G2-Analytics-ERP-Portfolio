// Adaptador CMP — payload de GET /dados/cliente-marca-produto → CmpData.
//
// O endpoint agrega vmVndItemDoc com a MESMA convenção do kpi_marca dos bots
// (venda/custo por CASE em CustoRepTotItem, NOT IN de planos): o CMP filtrado
// por marca bate 1:1 com o card da aba Vendas filtrada pela mesma marca.
// Semântica de quantidade: porCliente.quantidade = nº de vendas (docs);
// porMarca/porItem.quantidade = unidades (SUM QtdItem).
// Convenção: dentro de src/lib/api/** só imports RELATIVOS.

import type { CmpData } from "../types";
import { clean, num, round2 } from "./shared";

// Linhas cruas do payload — shape validado pelo fixture, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

export function adaptCmp(raw: Row): CmpData {
  const k: Row = raw?.kpis ?? {};

  const porMarca = asRows(raw?.por_marca).map((r) => ({
    marca: clean(r.marca) || "—",
    vendaLiquida: num(r.venda_liq),
    custoReposicaoLiq: num(r.custo_rep),
    margem: round2(num(r.margem)),
    quantidade: num(r.quantidade),
    ticketMedio: num(r.ticket_medio),
  }));

  return {
    kpis: {
      margemLucro: round2(num(k.margem)),
      ticketMedioProduto: num(k.ticket_medio),
      qtdeVendasLiq: num(k.qtd_vendas),
      vendaLiquida: num(k.venda_liq),
      devolucao: num(k.devolucoes),
      frete: num(k.frete),
    },
    porCliente: asRows(raw?.por_cliente).map((r) => ({
      codigo: clean(r.cod),
      cliente: clean(r.nome) || "—",
      vendaLiquida: num(r.venda_liq),
      margemLucroBruto: num(r.lucro),
      quantidade: num(r.qtd_vendas),
      ticketMedioProduto: num(r.ticket_medio),
    })),
    porMarca,
    marcaQuantidade: porMarca.map((m) => ({ marca: m.marca, quantidade: m.quantidade })),
    porItem: asRows(raw?.por_item).map((r) => ({
      codigo: clean(r.cod_item),
      item: clean(r.descr) || "—",
      vendaLiquida: num(r.venda_liq),
      quantidade: num(r.quantidade),
      margem: round2(num(r.margem)),
      marca: clean(r.marca) || "—",
    })),
    clientes: asRows(raw?.clientes).map((r) => ({ codigo: clean(r.cod), nome: clean(r.nome) })),
    vendedores: asRows(raw?.vendedores).map((r) => ({ codigo: clean(r.cod), nome: clean(r.nome) })),
    marcas: asRows(raw?.marcas)
      .map((m) => ({ nome: clean(m) }))
      .filter((m) => m.nome),
  };
}
