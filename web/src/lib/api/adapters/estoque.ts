// Adaptador Estoque — converte o payload cru de GET /dados/estoque no contrato
// EstoqueData que a tela consome. Função pura: entra o JSON da API, sai o
// contrato tipado — nenhuma regra de negócio nova mora aqui.
//
// O servidor entrega a posição já agregada (KPIs, curva ABC, valor por marca,
// evolução de 12 meses e a lista de itens com custo unitário, classe e dias sem
// venda). Ao adaptador cabe apenas renomear os campos (snake_case do payload →
// camelCase do contrato) e blindar os tipos.
//
// Semântica de que a tela depende:
//   - itens[].diasSemVenda === 9999 é SENTINELA de "nunca vendeu": a tabela
//     escreve "nunca" no lugar do número e o valor alto joga o item para o fim
//     da ordenação por dias. Por isso um valor ausente/ilegível vira a
//     sentinela, e não 0 (0 significaria "vendeu hoje").
//   - abc tem SEMPRE 3 linhas na ordem A, B, C: os cartões clicáveis e a rosca
//     são renderizados a partir dessa lista e tiram a cor do índice.
//   - kpis.estoqueParado é R$ imobilizado (a tela formata como moeda);
//     coberturaMedia é em dias.
//   - percentualVendas já vem em pontos percentuais (80.06 = 80,06%).

import type { EstoqueData, EstoqueItem } from "../types";
import { clean, num } from "./shared";

// Linhas cruas do payload — shape validado contra o retrato da API, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

/** Sentinela de item sem venda registrada ("nunca" na tabela). */
const DIAS_NUNCA_VENDIDO = 9999;

/** Ordem fixa exigida pela tela (cartões A/B/C e fatias da rosca). */
const CLASSES_ABC: EstoqueItem["classe"][] = ["A", "B", "C"];

/** 'A' | 'B' | 'C' defensivo — qualquer outra coisa cai em C (cauda longa). */
function classeABC(x: unknown): EstoqueItem["classe"] {
  const c = clean(x).toUpperCase();
  return c === "A" || c === "B" ? c : "C";
}

/**
 * Dias sem venda do item. Sem número utilizável (null, texto, negativo) o item
 * é tratado como nunca vendido — a tela distingue os dois casos pela sentinela.
 */
function diasSemVenda(x: unknown): number {
  // null/"" precisam ser barrados ANTES do Number(), que os converteria em 0 —
  // e 0 na tela significa "vendeu hoje", o oposto do que o dado ausente diz.
  if (x === null || x === undefined || x === "") return DIAS_NUNCA_VENDIDO;
  const n = Number(x);
  if (!Number.isFinite(n) || n < 0) return DIAS_NUNCA_VENDIDO;
  return Math.floor(n);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function adaptEstoque(raw: any): EstoqueData {
  const r: Row = raw ?? {};
  const k: Row = r.kpis ?? {};

  // ── KPIs ───────────────────────────────────────────────────────────────────
  const kpis: EstoqueData["kpis"] = {
    valorEstoque: num(k.valor_estoque),
    qtdEstoque: num(k.qtd_estoque),
    skus: num(k.skus),
    abaixoMinimo: num(k.abaixo_minimo),
    semEstoque: num(k.sem_estoque),
    estoqueParado: num(k.estoque_parado),
    coberturaMedia: num(k.cobertura_media),
  };

  // ── Curva ABC — 3 linhas garantidas, na ordem A, B, C ──────────────────────
  // A lista é montada a partir da ordem fixa (e não da ordem do payload) para
  // que a tela nunca fique com uma classe faltando nem trocada de posição.
  const abcPayload = asRows(r.abc);
  const abc: EstoqueData["abc"] = CLASSES_ABC.map((classe) => {
    const linha: Row = abcPayload.find((a) => clean(a.classe).toUpperCase() === classe) ?? {};
    return {
      classe,
      itens: num(linha.itens),
      percentualVendas: num(linha.percentual_vendas),
      valorEstoque: num(linha.valor_estoque),
    };
  });

  // ── Valor por marca (o servidor já manda o top 10 ordenado) ────────────────
  // A reordenação é só uma garantia para o gráfico de barras horizontais, que
  // desenha na ordem do array.
  const valorPorMarca: EstoqueData["valorPorMarca"] = asRows(r.valor_por_marca)
    .map((m) => ({ marca: clean(m.marca), valor: num(m.valor) }))
    .filter((m) => m.marca)
    .sort((a, b) => b.valor - a.valor)
    .slice(0, 10);

  // ── Evolução de 12 meses (rótulo de mês pronto do servidor) ────────────────
  const evolucao: EstoqueData["evolucao"] = asRows(r.evolucao).map((e) => ({
    mes: clean(e.mes),
    valor: num(e.valor),
    quantidade: num(e.quantidade),
  }));

  // ── Itens (ordem do servidor preservada: valor em estoque decrescente) ─────
  const itens: EstoqueItem[] = asRows(r.itens).map((t) => ({
    codigo: clean(t.codigo),
    descricao: clean(t.descricao),
    marca: clean(t.marca),
    quantidade: num(t.quantidade),
    disponivel: num(t.disponivel),
    diasSemVenda: diasSemVenda(t.dias_sem_venda),
    custo: num(t.custo), // unitário — o total do item vem separado em `valor`
    valor: num(t.valor),
    classe: classeABC(t.classe),
  }));

  return { kpis, abc, valorPorMarca, evolucao, itens };
}
