// Adaptador Dashboard — payload de GET /dados/dashboard (ou de
// /dados/dashboard/filtered, quando a tela pede um período) → DashboardData.
//
// O servidor entrega tudo pronto e JÁ no recorte pedido: resultado do mês,
// performance (inclusive % da meta e meta do dia), série diária e os rankings
// por vendedor / marca / grupo. Logo, aqui não se reagrega nada — o adaptador
// faz três coisas:
//   1. renomeia snake_case → camelCase do contrato;
//   2. sanea números (todo campo numérico do contrato precisa ser finito);
//   3. recorta as LISTAS já agregadas pelas seleções ativas — é o que faz a
//      barra clicada isolar o gráfico enquanto a próxima resposta do servidor
//      (que já vem filtrada) não chega.
// Cruzamentos que o payload não expõe (vendedor × marca, marca × grupo…) são
// responsabilidade do servidor: não há fonte nível-produto neste payload.

import type {
  DashboardData,
  DimensaoValor,
  Filtros,
  Grupo,
  Marca,
  RankVendedor,
  SerieDia,
  Vendedor,
} from "../types";
import { clean, dayOfMonth, isoDate, mesReferenciaAtual, num } from "./shared";

// Linhas cruas do payload — shape validado pelo fixture, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

/** Seleção de filtro → Set de nomes limpos (o payload traz nomes, não códigos). */
function selecao(valores: string[]): Set<string> {
  return new Set((valores ?? []).map(clean).filter(Boolean));
}

/**
 * Opções de filtro ({id, nome}). O `id` do payload pode vir numérico (o
 * contrato exige string) e pode faltar — nesse caso o próprio nome serve de id,
 * que é o que a tela usa como `value` do MultiSelect.
 */
function opcoes(rows: Row[]): { id: string; nome: string }[] {
  const vistos = new Map<string, string>();
  for (const r of rows) {
    const nome = clean(r?.nome);
    if (!nome || vistos.has(nome)) continue;
    vistos.set(nome, clean(r?.id) || nome);
  }
  return [...vistos.entries()].map(([nome, id]) => ({ id, nome }));
}

/**
 * por_marca / por_grupo → DimensaoValor. `margem` vem em PONTOS PERCENTUAIS
 * (ex.: 35.76 = 35,76%) e é repassada como está; só quando o campo falta ela é
 * derivada de lucro/venda para o tooltip não exibir 0% num item com lucro.
 */
function dimensoes(rows: Row[], sel: Set<string>): DimensaoValor[] {
  return (
    rows
      .map((r) => {
        const vendaLiquida = num(r?.venda_liquida);
        const lucroBruto = num(r?.lucro_bruto);
        return {
          nome: clean(r?.nome),
          vendaLiquida,
          custoReposicao: num(r?.custo_reposicao),
          lucroBruto,
          margem:
            r?.margem != null
              ? num(r.margem)
              : vendaLiquida > 0
                ? (lucroBruto / vendaLiquida) * 100
                : 0,
          quantidade: num(r?.quantidade),
        };
      })
      .filter((d) => d.nome && (sel.size === 0 || sel.has(d.nome)))
      // Os gráficos são rankings horizontais: ordem decrescente é parte do
      // contrato visual, mesmo que o servidor já mande ordenado.
      .sort((a, b) => b.vendaLiquida - a.vendaLiquida)
  );
}

export function adaptDashboard(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawDashboard: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawVendas: any | null,
  filtros: Filtros,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawMetas: any | null = null,
): DashboardData {
  const d: Row = rawDashboard ?? {};
  const v: Row = rawVendas ?? {};
  const res: Row = d.resultado ?? {};
  const perf: Row = d.performance ?? {};

  const vendSel = selecao(filtros?.vendedores ?? []);
  const marcaSel = selecao(filtros?.marcas ?? []);
  const grupoSel = selecao(filtros?.grupos ?? []);

  // ── Dimensões (opções dos filtros) ─────────────────────────────────────────
  // O payload do dashboard é a fonte; /dados/vendas entra só como reserva
  // (mesmo shape {id, nome}) para os MultiSelects não ficarem vazios caso o
  // recorte do servidor devolva a lista enxuta.
  const vendedores: Vendedor[] = opcoes(
    asRows(d.vendedores).length ? asRows(d.vendedores) : asRows(v.vendedores),
  );
  const marcas: Marca[] = opcoes(asRows(d.marcas).length ? asRows(d.marcas) : asRows(v.marcas));
  const grupos: Grupo[] = opcoes(asRows(d.grupos));

  // ── Resultado Comercial ────────────────────────────────────────────────────
  const resultado: DashboardData["resultado"] = {
    faturamentoBruto: num(res.faturamento_bruto),
    devolucoes: num(res.devolucoes),
    documentosCancelados: num(res.documentos_cancelados),
    faturamentoLiquido: num(res.faturamento_liquido),
    qtdVendas: num(res.qtd_vendas),
    qtdDevolucoes: num(res.qtd_devolucoes),
    lucroBruto: num(res.lucro_bruto),
    custoReposicao: num(res.custo_reposicao),
  };

  // ── Performance ────────────────────────────────────────────────────────────
  // percentual_meta e margem_bruta já chegam em PONTOS PERCENTUAIS. O /metas
  // (4º argumento) é só rede de segurança: se o servidor não mandar a % da
  // meta, ela é recomposta com a meta da empresa sobre o faturamento líquido.
  const metaMensal = num(rawMetas?.meta_mensal_total);
  const percentualMeta =
    perf.percentual_meta != null
      ? num(perf.percentual_meta)
      : metaMensal > 0
        ? (resultado.faturamentoLiquido / metaMensal) * 100
        : 0;

  // ── Análise diária ─────────────────────────────────────────────────────────
  // `dia` é o rótulo do eixo X (dia do mês) e `data` é o ISO usado pelo card
  // "Meta do Dia" para achar o que foi vendido hoje — daí o fallback de `dia`
  // derivado da própria data quando o servidor manda só o ISO.
  const diario: SerieDia[] = asRows(d.diario)
    .map((r) => {
      const data = isoDate(r?.data);
      return {
        dia: r?.dia != null ? num(r.dia) : dayOfMonth(data),
        data,
        valor: num(r?.valor),
      };
    })
    .filter((s) => s.data)
    .sort((a, b) => (a.data < b.data ? -1 : 1));

  // ── Top vendedores ─────────────────────────────────────────────────────────
  const topVendedores: RankVendedor[] = asRows(d.top_vendedores)
    .map((r) => ({
      vendedor: clean(r?.vendedor),
      valor: num(r?.valor),
      ticket: num(r?.ticket),
      documentos: num(r?.documentos),
    }))
    .filter((r) => r.vendedor && (vendSel.size === 0 || vendSel.has(r.vendedor)))
    .sort((a, b) => b.valor - a.valor);

  // ── Faturamento por dimensão ───────────────────────────────────────────────
  const porMarca = dimensoes(asRows(d.por_marca), marcaSel);
  const porGrupo = dimensoes(asRows(d.por_grupo), grupoSel);

  return {
    // Rótulo do cabeçalho vem pronto do servidor ("Agosto 2026" ou o texto do
    // período consultado); o cálculo local é só fallback de payload vazio.
    mesReferencia: clean(d.mes_referencia) || mesReferenciaAtual(),
    vendedores,
    marcas,
    grupos,
    resultado,
    performance: {
      percentualMeta,
      metaDoDia: num(perf.meta_do_dia),
      margemBruta: num(perf.margem_bruta),
      ticketMedio: num(perf.ticket_medio),
      frete: num(perf.frete),
    },
    diario,
    topVendedores,
    porMarca,
    porGrupo,
  };
}
