// Adaptador Cliente × Marca × Produto — converte o payload de
// GET /dados/cliente-marca-produto no contrato CmpData. Função pura: entra o
// JSON da API, sai o contrato tipado.
//
// O servidor entrega o cruzamento já agregado nas três dimensões (cliente,
// marca e item) com venda líquida, custo, lucro, margem e ticket médio
// calculados por linha, mais as listas que alimentam os filtros. Ao adaptador
// cabe renomear os campos (snake_case → camelCase) e blindar os tipos.
//
// Semântica de que a tela depende:
//   - margem já vem em PONTOS PERCENTUAIS (31.24 = 31,24%) — não multiplicar
//     nem dividir por 100; a coluna pinta de verde a partir de 20.
//   - quantidade muda de unidade conforme a dimensão: em porCliente a coluna é
//     "Qtde. Vendas" (documentos), em porMarca/porItem é a quantidade de itens
//     vendidos. Por isso porCliente lê `documentos` e as outras `quantidade`.
//   - margemLucroBruto de porCliente é R$ (lucro), não percentual: a coluna é
//     formatada como moeda.
//   - marcaQuantidade preserva a MESMA ORDEM de porMarca — as fatias da rosca
//     tiram a cor do índice e o clique na fatia filtra a página pela marca.
//   - frete é do documento e, por isso, não recorta por marca; a tela avisa
//     isso no cartão.
//
// Convenção: dentro de src/lib/api/** só imports RELATIVOS.

import type { CmpData } from "../types";
import { clean, num, round2 } from "./shared";

// Linhas cruas do payload — shape validado contra o retrato da API, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

export function adaptCmp(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
): CmpData {
  const d: Row = raw ?? {};
  const k: Row = d.kpis ?? {};

  const porMarca = asRows(d.por_marca).map((r) => ({
    marca: clean(r.marca) || "—",
    vendaLiquida: num(r.venda_liquida),
    custoReposicaoLiq: num(r.custo),
    margem: round2(num(r.margem)),
    quantidade: num(r.quantidade), // itens vendidos
    ticketMedio: num(r.ticket_medio),
  }));

  return {
    kpis: {
      margemLucro: round2(num(k.margem)),
      ticketMedioProduto: num(k.ticket_medio),
      qtdeVendasLiq: num(k.documentos), // contagem de documentos de venda
      vendaLiquida: num(k.venda_liquida),
      // Devolução é um cartão de valor absoluto: o módulo evita que uma
      // convenção de sinal na origem vire "-R$" na tela.
      devolucao: Math.abs(num(k.devolucao)),
      frete: num(k.frete),
    },

    // Ordem do servidor preservada nas três tabelas (já vêm por venda líquida
    // decrescente); a tela oferece ordenação por coluna em cima disso.
    porCliente: asRows(d.por_cliente).map((r) => ({
      codigo: clean(r.codigo),
      cliente: clean(r.cliente) || "—",
      vendaLiquida: num(r.venda_liquida),
      margemLucroBruto: num(r.lucro), // R$
      quantidade: num(r.documentos), // "Qtde. Vendas" = documentos
      ticketMedioProduto: num(r.ticket_medio),
    })),

    porMarca,
    marcaQuantidade: porMarca.map((m) => ({ marca: m.marca, quantidade: m.quantidade })),

    porItem: asRows(d.por_item).map((r) => ({
      codigo: clean(r.codigo),
      item: clean(r.item) || "—",
      vendaLiquida: num(r.venda_liquida),
      quantidade: num(r.quantidade),
      margem: round2(num(r.margem)),
      marca: clean(r.marca) || "—",
    })),

    // Opções dos filtros. Linha sem chave é descartada: o MultiSelect usa o
    // código como value e o clique não teria o que enviar ao servidor.
    clientes: asRows(d.clientes)
      .map((r) => ({ codigo: clean(r.codigo), nome: clean(r.nome) || "—" }))
      .filter((c) => c.codigo),
    vendedores: asRows(d.vendedores)
      .map((r) => ({ codigo: clean(r.codigo), nome: clean(r.nome) || "—" }))
      .filter((v) => v.codigo),
    // Marcas chegam como lista de strings — o contrato pede objeto nomeado.
    marcas: asRows(d.marcas)
      .map((m) => ({ nome: clean(m) }))
      .filter((m) => m.nome),
  };
}
