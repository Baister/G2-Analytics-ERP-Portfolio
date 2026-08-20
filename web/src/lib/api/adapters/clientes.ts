// Adaptador Carteira de Clientes — converte o payload cru da aba Clientes no
// contrato ClientesCarteira. Função pura: entra o JSON da API, sai o contrato
// tipado que a tela renderiza.
//
// O servidor entrega a carteira dos últimos 12 meses já classificada: KPIs,
// segmentação por recência, curva ABC, série de ativos por mês e o top 50 com
// a classe e o rótulo de situação prontos. Aqui só há renomeação de campos
// (snake_case → camelCase do contrato) e blindagem de tipos.
//
// Semântica de que a tela depende:
//   - abc tem SEMPRE 3 linhas na ordem A, B, C (os cartões são renderizados na
//     ordem do array).
//   - top50[].recencia precisa bater EXATAMENTE com um dos quatro rótulos do
//     contrato: a badge escolhe a cor por igualdade de string.
//   - percentual e concentracaoTop10 já vêm em pontos percentuais
//     (80.12 = 80,12%) — não multiplicar nem dividir por 100.

import type { ClientesCarteira } from "../types";
import { clean, isoDate, num } from "./shared";

// Linhas cruas do payload — shape validado contra o retrato da API, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

type ClasseABC = ClientesCarteira["abc"][number]["classe"];
type Recencia = ClientesCarteira["top50"][number]["recencia"];

/** Ordem fixa exigida pela tela. */
const CLASSES_ABC: ClasseABC[] = ["A", "B", "C"];

/** Rótulos aceitos pela badge de situação; qualquer outro vira "Inativo". */
const RECENCIAS: readonly string[] = ["Ativo", "Atenção", "Em risco", "Inativo"];

/**
 * Texto normalizado em NFC. O rótulo de recência é comparado por igualdade de
 * string, e acento decomposto (NFD) na origem produziria um texto visualmente
 * idêntico que não casaria com nenhum rótulo do contrato.
 */
function texto(x: unknown): string {
  return clean(x).normalize("NFC");
}

/** 'A' | 'B' | 'C' defensivo — qualquer outra coisa cai em C (cauda longa). */
function classeABC(x: unknown): ClasseABC {
  const c = clean(x).toUpperCase();
  return c === "A" || c === "B" ? c : "C";
}

/** Situação por recência — string pronta no payload, apenas validada. */
function recencia(x: unknown): Recencia {
  const v = texto(x);
  return (RECENCIAS.includes(v) ? v : "Inativo") as Recencia;
}

export function adaptClientesCarteira(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
): ClientesCarteira {
  const d: Row = raw ?? {};
  const k: Row = d.kpis ?? {};

  // ── Curva ABC — 3 linhas garantidas, na ordem A, B, C ──────────────────────
  // Montada a partir da ordem fixa (e não da ordem do payload) para a tela
  // nunca ficar com uma classe faltando nem fora de posição.
  const abcPayload = asRows(d.abc);

  return {
    kpis: {
      compradores12m: num(k.compradores_12m),
      ativosMes: num(k.ativos_mes),
      novosMes: num(k.novos_mes),
      receita12m: num(k.receita_12m),
      ticketMedio: num(k.ticket_medio),
      concentracaoTop10: num(k.concentracao_top10), // pontos percentuais
    },

    // Faixas de recência da rosca — rótulos prontos do servidor.
    segmentacao: asRows(d.segmentacao)
      .map((r) => ({ faixa: texto(r.faixa), clientes: num(r.clientes) }))
      .filter((s) => s.faixa),

    abc: CLASSES_ABC.map((classe) => {
      const linha: Row = abcPayload.find((r) => clean(r.classe).toUpperCase() === classe) ?? {};
      return {
        classe,
        clientes: num(linha.clientes),
        receita: num(linha.receita),
        percentual: num(linha.percentual), // pontos percentuais
      };
    }),

    ativosPorMes: asRows(d.ativos_por_mes).map((r) => ({
      mes: clean(r.mes),
      ativos: num(r.ativos),
    })),

    // Top 50 por receita — o corte é garantia de contrato; o servidor já ordena.
    top50: asRows(d.top50)
      .slice(0, 50)
      .map((r) => ({
        codigo: clean(r.codigo),
        cliente: texto(r.cliente),
        abc: classeABC(r.abc),
        receita: num(r.receita),
        pedidos: num(r.pedidos),
        ticket: num(r.ticket),
        ultimaCompra: isoDate(r.ultima_compra),
        recencia: recencia(r.recencia),
      })),
  };
}
