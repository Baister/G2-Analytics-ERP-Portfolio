// Adaptador Vendas — traduz o payload de GET /dados/vendas (+ GET /metas) no
// contrato VendasData consumido pela aba Vendas.
//
// O backend passou a entregar a aba inteira já agregada e ordenada: KPIs do mês,
// ritmo acumulado × meta, ranking de vendedores, top de itens/marcas, progresso
// mensal e diário por vendedor e a série de progresso diário da empresa. Sobrou
// para cá a tradução snake_case → camelCase e o recorte client-side dos painéis
// que a seleção de vendedor/marca consegue recortar sem inventar número.
//
// Deixou de ser feito aqui (virou responsabilidade do servidor): contagem de
// dias úteis e distribuição da meta mensal, soma do acumulado dia a dia, meta do
// dia por vendedor (restante ÷ dias úteis restantes), dedução do top de itens a
// partir dos dicionários por marca/vendedor e a agregação cruzada
// vendedor × marca.
//
// Regras que a tela exige:
//   - ritmo[].acumulado é null nos dias futuros; o LineChart usa
//     connectNulls={false} e a linha precisa PARAR no último dia com dado.
//   - percentuais em pontos percentuais (109.6 = 109,6%), como o payload manda.
//   - KPIs são o agregado do mês inteiro: não recortam por vendedor/marca (o
//     payload não traz o cruzamento). A seleção recorta apenas as listas; no
//     ranking ela serve de destaque (a tela pinta a barra selecionada).
//   - filtros.periodo é ignorado: o backend entrega sempre o mês corrente.
//
// De /metas só as metas_individuais ainda são úteis, e apenas como plano B —
// meta_mensal_total já chega embutida em ritmo[].meta.

import type {
  Filtros,
  ItemRank,
  Marca,
  ProgressoDia,
  ProgressoVendedor,
  RankVendedor,
  Vendedor,
  VendasData,
} from "../types";
import { clean, dayOfMonth, isoDate, num, round2 } from "./shared";

// Linhas cruas da API — shape validado pelo payload de referência, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

/** Nomes selecionados nos filtros (trim); conjunto vazio = "todos". */
const selecao = (xs: string[] | undefined): Set<string> =>
  new Set((xs ?? []).map(clean).filter(Boolean));

/**
 * Acumulado do ritmo. Dia futuro chega null e PRECISA continuar null: num()
 * devolveria 0 e o gráfico desenharia uma queda a zero até o fim do mês em vez
 * de encerrar a linha. O contrato declara `number` porque a tela só lê o ponto —
 * o null é o sentinela combinado com o gráfico (connectNulls={false}), e a
 * exportação Excel já trata valor não-finito como célula vazia.
 */
function acumuladoDoDia(x: unknown): number {
  return x == null ? (null as unknown as number) : num(x);
}

/**
 * Opções de um filtro. Usa a dimensão pronta do payload quando existe e cai para
 * os nomes que aparecem nas listas (payload parcial não pode zerar o MultiSelect
 * — sem opção a tela trava o filtro).
 */
function dimensao(prontos: Row[], derivados: string[]): { id: string; nome: string }[] {
  const out: { id: string; nome: string }[] = [];
  const vistos = new Set<string>();
  const push = (nome: unknown, id: unknown) => {
    const n = clean(nome);
    if (!n || vistos.has(n)) return;
    vistos.add(n);
    // id numérico do payload vira string (o contrato exige string); sem id, o
    // próprio nome identifica — é ele que a tela manda de volta como filtro.
    out.push({ id: clean(id) || n, nome: n });
  };
  for (const d of prontos) push(d.nome, d.id);
  for (const n of derivados) push(n, "");
  return out;
}

/** Linhas de progresso (mensal ou do dia) já calculadas pelo servidor. */
function mapProgresso(rows: Row[], sel: Set<string>): ProgressoVendedor[] {
  return rows
    .map((p) => ({
      vendedor: clean(p.vendedor),
      realizado: num(p.realizado),
      meta: num(p.meta),
      percentual: num(p.percentual),
    }))
    .filter((p) => p.vendedor && (sel.size === 0 || sel.has(p.vendedor)));
}

export function adaptVendas(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metas: any | null,
  filtros: Filtros,
): VendasData {
  const r: Row = raw ?? {};

  const vendSel = selecao(filtros?.vendedores);
  const marcaSel = selecao(filtros?.marcas);

  // ── Ritmo do Mês ───────────────────────────────────────────────────────────
  const ritmo: VendasData["ritmo"] = asRows(r.ritmo).map((p) => ({
    dia: num(p.dia),
    acumulado: acumuladoDoDia(p.acumulado),
    meta: num(p.meta),
  }));

  // ── Rankings (ordem do servidor preservada: já vêm por valor desc) ─────────
  // O ranking NÃO é recortado por vendedor: a tela usa a seleção para destacar a
  // barra clicada, e o top-10 do servidor não teria linha para quem está fora.
  const topVendedores: RankVendedor[] = asRows(r.top_vendedores).map((v) => ({
    vendedor: clean(v.vendedor),
    valor: num(v.valor),
    ticket: num(v.ticket),
    documentos: num(v.documentos),
  }));

  const topItens: ItemRank[] = asRows(r.top_itens)
    .map((i) => ({
      codigo: clean(i.codigo),
      descricao: clean(i.descricao),
      marca: clean(i.marca),
      quantidade: num(i.quantidade),
      valor: num(i.valor),
    }))
    .filter((i) => marcaSel.size === 0 || marcaSel.has(i.marca));

  const topMarcas: VendasData["topMarcas"] = asRows(r.top_marcas)
    .map((m) => ({
      marca: clean(m.marca),
      valor: num(m.valor),
      documentos: num(m.documentos),
    }))
    .filter((m) => marcaSel.size === 0 || marcaSel.has(m.marca));

  // ── Dimensões dos filtros ──────────────────────────────────────────────────
  const vendedores: Vendedor[] = dimensao(
    asRows(r.vendedores),
    topVendedores.map((v) => v.vendedor),
  );
  const marcas: Marca[] = dimensao(
    asRows(r.marcas),
    topMarcas.map((m) => m.marca),
  );

  // ── KPIs do mês (agregado do servidor) ─────────────────────────────────────
  const k: Row = r.kpis ?? {};
  const kpis: VendasData["kpis"] = {
    faturamentoBruto: num(k.faturamento_bruto),
    // Devolução chega positiva; abs mantém o cartão em R$ positivo caso o
    // servidor passe a mandar o valor com sinal de saída.
    devolucaoValor: Math.abs(num(k.devolucao_valor)),
    margemBruta: num(k.margem_bruta), // já em pontos percentuais
    ticketMedio: num(k.ticket_medio),
    documentos: num(k.documentos),
    devolucoes: num(k.devolucoes),
    clientesAtivos: num(k.clientes_ativos),
    totalMarcas: num(k.total_marcas) || marcas.length,
  };

  // ── Progresso de metas (mensal e do dia) ───────────────────────────────────
  const progressoBruto = asRows(r.progresso_vendedores);
  let progressoVendedores = mapProgresso(progressoBruto, vendSel);

  if (progressoBruto.length === 0) {
    // Plano B para payload sem o progresso pronto: realizado do ranking × meta
    // salva em /metas. Sem isso o painel inteiro sumiria da tela.
    const metasIndividuais = new Map<string, number>();
    for (const [nome, valor] of Object.entries(metas?.metas_individuais ?? {})) {
      const limpo = clean(nome);
      if (limpo) metasIndividuais.set(limpo, num(valor));
    }
    progressoVendedores = topVendedores
      .map((v) => {
        const meta = metasIndividuais.get(v.vendedor) ?? 0;
        return {
          vendedor: v.vendedor,
          realizado: v.valor,
          meta,
          percentual: meta > 0 ? round2((v.valor / meta) * 100) : 0,
        };
      })
      .filter((p) => p.meta > 0 && (vendSel.size === 0 || vendSel.has(p.vendedor)))
      .sort((a, b) => b.percentual - a.percentual);
  }

  const progressoDiarioVendedores: ProgressoVendedor[] = mapProgresso(
    asRows(r.progresso_diario_vendedores),
    vendSel,
  );

  // ── Série diária da empresa (meta do dia × realizado) ──────────────────────
  const progressoDiario: ProgressoDia[] = asRows(r.progresso_diario).map((p) => {
    const data = isoDate(p.data);
    return {
      // `dia` vem pronto; derivar da data cobre payload que só mandar a data.
      dia: num(p.dia) || dayOfMonth(data),
      data,
      metaDia: num(p.meta_dia),
      realizado: num(p.realizado),
      percentual: num(p.percentual),
    };
  });

  return {
    kpis,
    ritmo,
    vendedores,
    marcas,
    topVendedores,
    topItens,
    topMarcas,
    progressoVendedores,
    progressoDiarioVendedores,
    progressoDiario,
  };
}
