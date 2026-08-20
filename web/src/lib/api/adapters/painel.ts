// Adaptador Painel de Pedidos — converte o payload AO VIVO de
// GET /dados/painel_pedidos no contrato PainelPedidos da tela (3 filas).
//
// Fonte: hub/server.py (dados_painel_pedidos) + front antigo
// (hub/frontend/src/pages/PainelPedidos.jsx) — rota sob demanda, sem fixture.
//
// Fluxo REAL (comprovado no LOG_PEDIDOS): o pedido espera em FATURAMENTO
// (status 3); a CONFERÊNCIA (status 5) é a última parada, minutos antes de
// concluir (5→1 direto). Portanto:
//   - status 5            → fila "Aguardando Conferência"
//   - demais em aberto    → fila "Aguardando Faturamento" (inclui os status
//     raros 2/44–50 do catálogo — nada some do telão; server já exclui
//     concluídos/cancelados: 1, 6, 26, 29, 200, 201)
//   - payload.saiu        → "Saiu Hoje" (status 1 concluído hoje; NF opcional
//     via link NSU; `emissao` ali é o DtHrEdit da conclusão → vira a Hora)
//
// Aging "na fila" (horasFila): a tela pinta verde <24h, amarelo <3d, vermelho
// acima. Entrega vencida = data de entrega anterior a hoje (comparação por dia).
// A consulta "saiu" não traz vendedor/rota — campos ficam "—" (Fase 2).

import type { PainelPedidos, Pedido } from "../types";
import { clean, isoDate, num, pad2 } from "./shared";

// Linhas cruas do payload — shape validado contra o server, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

/** Data local 'YYYY-MM-DD' para comparar entrega vencida por dia. */
function hojeISO(agora: Date): string {
  return `${agora.getFullYear()}-${pad2(agora.getMonth() + 1)}-${pad2(agora.getDate())}`;
}

/** Razão social em caixa alta (padrão do telão no front antigo). */
function razaoDe(r: Row): string {
  return (clean(r.razao) || clean(r.cliente) || "—").toUpperCase();
}

/**
 * Logística: "Retira na Loja" × rota de entrega (VIEW_CONFERENCIA).
 * tp_entrega vem como "1-Retira na Loja" → tira o prefixo numérico;
 * para entrega usa o NOME DA ROTA (fallback: descrição do tipo, senão "—").
 */
function logisticaDe(tpEntrega: unknown, rota: unknown): Pedido["logistica"] {
  const tipo = clean(tpEntrega).replace(/^\d+\s*-\s*/, "");
  if (/retira/i.test(tipo)) return { tipo: "retira", nome: "Retira na Loja" };
  return { tipo: "rota", nome: clean(rota) || tipo || "—" };
}

export function adaptPainelPedidos(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  agora: Date = new Date(),
): PainelPedidos {
  const d: Row = raw ?? {};
  const hoje = hojeISO(agora);

  const linhaFila = (r: Row): Pedido => {
    const entrega = isoDate(r.entrega);
    const regHr = String(r.registro_hr ?? ""); // primeiro rastro do dia (server)
    return {
      pedido: clean(r.pedido),
      razaoSocial: razaoDe(r),
      vendedor: clean(r.vendedor) || "—",
      emissao: isoDate(r.emissao),
      entrega,
      entregaVencida: Boolean(entrega && entrega < hoje),
      logistica: logisticaDe(r.tp_entrega, r.rota),
      valor: num(r.valor),
      horasFila: num(r.horas_fila),
      registroISO: isoDate(r.emissao), // emissao = DtOrcPedVnd (data de registro)
      ...(regHr.length >= 16 ? { registroHora: regHr.slice(11, 16) } : {}),
    };
  };

  // Server já ordena por nº do pedido decrescente — ordem preservada.
  const emAberto = asRows(d.pedidos);
  const aguardandoConferencia = emAberto.filter((r) => num(r.status) === 5).map(linhaFila);
  const aguardandoFaturamento = emAberto.filter((r) => num(r.status) !== 5).map(linhaFila);

  const saiuHoje: Pedido[] = asRows(d.saiu).map((r): Pedido => {
    const dtHr = String(r.emissao ?? ""); // DtHrEdit da conclusão ("YYYY-MM-DD HH:MM:SS")
    const nf = clean(r.nf);
    const regHr = String(r.registro_hr ?? "");
    const registro = isoDate(r.registro); // DtOrcPedVnd (data de registro)
    return {
      pedido: clean(r.pedido),
      razaoSocial: razaoDe(r),
      vendedor: clean(r.vendedor) || "—", // exposto pelo server desde 2026-08-11
      emissao: isoDate(r.emissao),
      entrega: "",
      entregaVencida: false,
      logistica: logisticaDe(r.tp_entrega, r.rota), // idem — habilita filtro "retira"
      valor: num(r.valor),
      horasFila: 0,
      ...(nf ? { nf } : {}),
      ...(dtHr.length >= 16 ? { hora: dtHr.slice(11, 16) } : {}),
      ...(registro ? { registroISO: registro } : {}),
      ...(regHr.length >= 16 ? { registroHora: regHr.slice(11, 16) } : {}),
    };
  });

  const soma = (l: Pedido[]): number => l.reduce((s, p) => s + p.valor, 0);

  return {
    resumo: [
      {
        status: "Aguardando Faturamento",
        pedidos: aguardandoFaturamento.length,
        valor: soma(aguardandoFaturamento),
      },
      {
        status: "Aguardando Conferência",
        pedidos: aguardandoConferencia.length,
        valor: soma(aguardandoConferencia),
      },
      { status: "Saiu Hoje", pedidos: saiuHoje.length, valor: soma(saiuHoje) },
    ],
    aguardandoFaturamento,
    aguardandoConferencia,
    saiuHoje,
  };
}
