// Adaptador Painel de Pedidos — converte o payload de GET /dados/painel_pedidos
// no contrato PainelPedidos (três filas + o resumo do topo). Função pura: entra
// o JSON da API, sai o contrato tipado.
//
// O servidor já entrega os pedidos separados por fila (aguardando_faturamento,
// aguardando_conferencia, saiu_hoje), com a logística resolvida em
// { tipo, nome }, o aging em horas, o flag de entrega vencida e o registro do
// dia partido em data + hora. Ao adaptador cabe renomear os campos para o
// contrato e blindar os tipos — nenhuma regra de fila mora aqui.
//
// Semântica de que a tela depende:
//   - resumo tem SEMPRE 3 linhas na ordem Faturamento → Conferência → Saiu
//     Hoje: os cartões do topo tiram a COR do índice do array.
//   - logistica.tipo === "retira" muda o ícone e a cor da badge, e é o recorte
//     do telão de retirada — qualquer outro valor cai em "rota".
//   - nf e hora são opcionais e ficam AUSENTES (não `undefined`) quando o
//     pedido ainda não saiu: o contrato roda com exactOptionalPropertyTypes.
//   - registroISO/registroHora são o filtro do telão de retirada, que só
//     mostra o que foi registrado hoje entre 08:00 e 18:00; sem hora apurável
//     o pedido fica fora, então o campo não é preenchido com valor inventado.
//   - horasFila alimenta a badge de aging (verde <24h, amarelo <72h, vermelho
//     acima) — número finito e nunca negativo.
//
// Convenção: dentro de src/lib/api/** só imports RELATIVOS.

import type { PainelPedidos, Pedido } from "../types";
import { clean, isoDate, num, pad2 } from "./shared";

// Linhas cruas do payload — shape validado contra o retrato da API, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

/** Rótulos do resumo, na ordem exigida pelos cartões do topo. */
const ROTULO_FATURAMENTO = "Aguardando Faturamento";
const ROTULO_CONFERENCIA = "Aguardando Conferência";
const ROTULO_SAIU = "Saiu Hoje";

/** Data local 'YYYY-MM-DD' — só entra em cena se o payload vier sem `hoje`. */
function hojeISO(agora: Date): string {
  return `${agora.getFullYear()}-${pad2(agora.getMonth() + 1)}-${pad2(agora.getDate())}`;
}

/** Logística pronta do payload, apenas validada contra o par do contrato. */
function logisticaDe(x: unknown): Pedido["logistica"] {
  const l: Row = x ?? {};
  const tipo = clean(l.tipo).toLowerCase() === "retira" ? "retira" : "rota";
  return { tipo, nome: clean(l.nome) || (tipo === "retira" ? "Retira na Loja" : "—") };
}

export function adaptPainelPedidos(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  agora: Date = new Date(),
): PainelPedidos {
  const d: Row = raw ?? {};
  const hoje = isoDate(d.hoje) || hojeISO(agora);

  const linha = (r: Row): Pedido => {
    const entrega = isoDate(r.entrega);
    const nf = clean(r.nf);
    const hora = clean(r.hora);
    const registroISO = isoDate(r.registro_iso);
    const registroHora = clean(r.registro_hora);
    return {
      pedido: clean(r.pedido),
      // Caixa alta é o padrão de leitura à distância do telão.
      razaoSocial: clean(r.razao_social).toUpperCase() || "—",
      vendedor: clean(r.vendedor) || "—",
      emissao: isoDate(r.emissao),
      entrega,
      // Flag pronta do servidor; a comparação local é só rede de segurança
      // para um payload antigo que ainda não traga o campo.
      entregaVencida:
        r.entrega_vencida != null ? Boolean(r.entrega_vencida) : Boolean(entrega) && entrega < hoje,
      logistica: logisticaDe(r.logistica),
      valor: num(r.valor),
      horasFila: Math.max(0, num(r.horas_fila)),
      // Opcionais entram por spread: atribuir `undefined` violaria
      // exactOptionalPropertyTypes e a tela distingue ausente de vazio.
      ...(nf ? { nf } : {}),
      ...(hora ? { hora } : {}),
      ...(registroISO ? { registroISO } : {}),
      ...(registroHora ? { registroHora } : {}),
    };
  };

  // Ordem do servidor preservada em cada fila (a tela reordena por conta
  // própria no telão de retirada).
  const aguardandoFaturamento = asRows(d.aguardando_faturamento).map(linha);
  const aguardandoConferencia = asRows(d.aguardando_conferencia).map(linha);
  const saiuHoje = asRows(d.saiu_hoje).map(linha);

  // Resumo montado na ordem FIXA da tela e não na ordem do payload — os
  // cartões coloriem por índice. Cada linha usa o total do servidor e cai para
  // a soma da própria fila se o rótulo não vier. A normalização NFC é porque a
  // busca do rótulo é igualdade de string e "Conferência" acentuado em NFD
  // pareceria idêntico sem casar.
  const resumoPayload = asRows(d.resumo);
  const totais = (status: string, fila: Pedido[]) => {
    const r: Row = resumoPayload.find((x) => clean(x.status).normalize("NFC") === status) ?? {};
    return {
      status,
      pedidos: r.pedidos != null ? num(r.pedidos) : fila.length,
      valor: r.valor != null ? num(r.valor) : fila.reduce((s, p) => s + p.valor, 0),
    };
  };

  return {
    resumo: [
      totais(ROTULO_FATURAMENTO, aguardandoFaturamento),
      totais(ROTULO_CONFERENCIA, aguardandoConferencia),
      totais(ROTULO_SAIU, saiuHoje),
    ],
    aguardandoFaturamento,
    aguardandoConferencia,
    saiuHoje,
  };
}
