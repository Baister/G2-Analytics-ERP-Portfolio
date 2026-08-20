// Adaptador CRM — payload de GET /dados/crm → contrato CrmData da aba CRM.
//
// O backend entrega a aba inteira pronta e já ordenada: KPIs do mês, funil de
// três etapas com o percentual de cada uma, evolução semanal com o rótulo dd/mm
// montado, ranking com taxa/ticket/cancelados/% da meta, oportunidades com o
// aging calculado, top de clientes, clientes novos, histograma de inatividade e
// as duas listas de atenção (em risco e inativos). Sobrou para cá:
//   1. renomear snake_case → camelCase do contrato;
//   2. sanear (todo número do contrato precisa ser finito, todo texto trimado);
//   3. recortar client-side as listas que TÊM dimensão de vendedor.
//
// Deixou de ser feito aqui (virou responsabilidade do servidor): taxa de
// conversão, percentual das etapas do funil, rótulo dd/mm da semana a partir da
// data de início, ticket médio por vendedor, merge de uma lista separada de
// cancelados por vendedor, cálculo do percentual da meta individual e as
// contagens de clientes novos / em risco / inativos.
//
// Recorte por vendedor: só ranking, oportunidades, em risco (dono da carteira) e
// inativos (último vendedor que atendeu) carregam essa dimensão. Funil, semanal,
// histograma, top de clientes e clientes novos são leituras da EMPRESA e seguem
// inteiros com um vendedor selecionado — recortá-los exigiria um cruzamento que
// o payload não traz, e inventar esse número é pior do que não recortar.

import type { CrmData, Vendedor } from "../types";
import { clean, isoDate, num } from "./shared";

// Linhas cruas do payload — shape validado pelo retrato da API, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

/** Chave de comparação de vendedor: trim + lowercase (o filtro da tela usa o NOME como valor). */
const chave = (x: unknown): string => clean(x).toLowerCase();

/**
 * Opções do MultiSelect. A fonte é a tabela de vendedores do payload; o ranking
 * entra só como reserva, para o filtro não ficar vazio num ciclo em que a lista
 * de vendedores não veio. `id` do payload é numérico e o contrato pede string.
 */
function opcoesVendedores(lista: Row[], ranking: Row[]): Vendedor[] {
  const vistos = new Set<string>();
  const opcoes: Vendedor[] = [];

  const juntar = (nome: string, id: unknown) => {
    const k = nome.toLowerCase();
    if (!nome || vistos.has(k)) return;
    vistos.add(k);
    opcoes.push({ id: clean(id) || nome, nome });
  };

  for (const r of lista) juntar(clean(r?.nome), r?.id);
  if (!opcoes.length) for (const r of ranking) juntar(clean(r?.vendedor), null);
  return opcoes;
}

export function adaptCrm(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  vendedores: string[],
  // Resposta crua do GET /metas ({ meta_mensal_total, metas_individuais }).
  // Opcional: hoje só cobre o buraco de um ranking sem percentual_meta.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metas: any = null,
): CrmData {
  const d: Row = raw ?? {};
  const k: Row = d.kpis ?? {};

  const rankingRaw = asRows(d.ranking);

  // ── Filtro de vendedores (client-side; seleção vazia = sem filtro) ─────────
  const sel = new Set((vendedores ?? []).map(chave).filter(Boolean));
  const passa = (nome: unknown): boolean => sel.size === 0 || sel.has(chave(nome));

  // ── Metas individuais — plano B do percentual da meta ─────────────────────
  // O servidor já devolve percentual_meta por linha do ranking; este mapa só é
  // consultado quando o campo falta, para a coluna "% Meta" não zerar a tela.
  const metasIndividuais = new Map<string, number>();
  for (const [nome, valor] of Object.entries(metas?.metas_individuais ?? {})) {
    const nomeChave = chave(nome);
    if (nomeChave) metasIndividuais.set(nomeChave, num(valor));
  }

  // ── Funil do mês — três etapas encaixadas, percentual em PONTOS percentuais
  const funil = asRows(d.funil).map((r) => ({
    etapa: clean(r?.etapa),
    valor: num(r?.valor),
    percentual: num(r?.percentual),
  }));

  // ── Evolução semanal — `semana` já vem rotulada ("17/08") ─────────────────
  const semanal = asRows(d.semanal).map((r) => ({
    semana: clean(r?.semana),
    propostas: num(r?.propostas),
    convertidos: num(r?.convertidos),
  }));

  // ── Ranking da equipe ─────────────────────────────────────────────────────
  const ranking: CrmData["ranking"] = rankingRaw
    .map((r) => {
      const vendedor = clean(r?.vendedor);
      const valor = num(r?.valor);
      const meta = metasIndividuais.get(chave(vendedor)) ?? 0;
      return {
        vendedor,
        propostas: num(r?.propostas),
        conversoes: num(r?.conversoes),
        // taxa e percentual_meta chegam em pontos percentuais (93.75 = 93,75%).
        taxa: num(r?.taxa),
        valor,
        ticket: num(r?.ticket),
        cancelados: num(r?.cancelados),
        percentualMeta:
          r?.percentual_meta != null
            ? num(r.percentual_meta)
            : meta > 0
              ? (valor / meta) * 100
              : 0,
      };
    })
    .filter((l) => l.vendedor && passa(l.vendedor))
    // Os três gráficos ao lado da tabela leem esta mesma lista: a ordem
    // decrescente por valor faz parte do desenho, não só da tabela.
    .sort((a, b) => b.valor - a.valor);

  // ── Oportunidades — orçamentos ainda abertos (janela de 90 dias) ──────────
  const oportunidades = asRows(d.oportunidades)
    .filter((r) => passa(r?.vendedor))
    .map((r) => ({
      numero: clean(r?.numero),
      cliente: clean(r?.cliente),
      vendedor: clean(r?.vendedor),
      data: isoDate(r?.data),
      diasAberto: num(r?.dias_aberto),
      valor: num(r?.valor),
    }));

  // ── Carteira do mês ───────────────────────────────────────────────────────
  const topClientes = asRows(d.top_clientes).map((r) => ({
    codigo: clean(r?.codigo),
    cliente: clean(r?.cliente),
    valor: num(r?.valor),
  }));

  const clientesNovos = asRows(d.clientes_novos).map((r) => ({
    codigo: clean(r?.codigo),
    cliente: clean(r?.cliente),
    data: isoDate(r?.data),
    valor: num(r?.valor),
  }));

  // Faixas posicionais e fixas (inclusive as zeradas): o gráfico as lê pela
  // ordem, e omitir uma faixa vazia deslocaria as barras seguintes.
  const histogramaInatividade = asRows(d.histograma_inatividade).map((r) => ({
    faixa: clean(r?.faixa),
    clientes: num(r?.clientes),
  }));

  // ── Atenção ───────────────────────────────────────────────────────────────
  // Em risco filtra pelo DONO da carteira (quem tem a tarefa de recuperar);
  // inativos, pelo último vendedor que de fato atendeu — é quem tem o contexto.
  const emRisco = asRows(d.em_risco)
    .filter((r) => passa(r?.vendedor))
    .map((r) => ({
      cliente: clean(r?.cliente),
      vendedor: clean(r?.vendedor),
      dias: num(r?.dias),
      valor: num(r?.valor),
    }));

  const inativos = asRows(d.inativos)
    .filter((r) => passa(r?.ultimo_vendedor))
    .map((r) => ({
      cliente: clean(r?.cliente),
      ultimoVendedor: clean(r?.ultimo_vendedor),
      dias: num(r?.dias),
      historico: num(r?.historico),
    }));

  // ── KPIs ──────────────────────────────────────────────────────────────────
  // Permanecem a leitura da EMPRESA mesmo com vendedor selecionado, por dois
  // motivos: metade deles (pipeline, faturado, ativos, novos) não tem dimensão
  // de vendedor no payload, e as contagens de risco/inativos são as CHEIAS —
  // as listas acima chegam truncadas pelo servidor, então derivar o KPI delas
  // encolheria o tamanho real do problema.
  const kpis: CrmData["kpis"] = {
    taxaConversao: num(k.taxa_conversao),
    pipeline: num(k.pipeline),
    faturadoMes: num(k.faturado_mes),
    propostasCaixa: num(k.propostas_caixa),
    clientesAtivos: num(k.clientes_ativos),
    clientesNovos: num(k.clientes_novos),
    emRisco: num(k.em_risco),
    inativos: num(k.inativos),
  };

  return {
    vendedores: opcoesVendedores(asRows(d.vendedores), rankingRaw),
    kpis,
    funil,
    semanal,
    ranking,
    oportunidades,
    topClientes,
    clientesNovos,
    histogramaInatividade,
    emRisco,
    inativos,
  };
}

/**
 * Compatibilidade com o caminho de busca por vendedor.
 *
 * A API não recorta CRM por vendedor — devolve um retrato só da empresa, e o
 * recorte acontece no `adaptCrm`. Se N respostas chegarem aqui, são o MESMO
 * retrato: somá-las multiplicaria KPIs e funil pelo número de vendedores
 * selecionados. A primeira já é o payload correto.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mesclaCrmFiltrado(payloads: any[]): any {
  return (Array.isArray(payloads) ? payloads[0] : payloads) ?? {};
}
