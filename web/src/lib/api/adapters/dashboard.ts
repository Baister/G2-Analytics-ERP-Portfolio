// Adaptador Dashboard — converte o payload real do bot (GET /dados/dashboard)
// no contrato DashboardData consumido pela tela, com filtragem 100% client-side.
//
// Lógica portada do front antigo (hub/frontend/src/pages/Dashboard.jsx +
// docs/superpowers/plans/2026-05-11-dashboard-client-side-filtering.md):
//   - filtros.vendedores → kpis_por_vendedor + faturamento_diario_por_vendedor
//   - filtros.marcas     → kpis_por_marca + faturamento_diario_por_marca
//   - vendedor×marca     → interseção via marcas_por_vendedor (nível produto)
//   - filtros.grupos     → kpis_por_grupo + marcas_por_grupo + grupos_por_vendedor
//     + faturamento_diario_por_grupo (bot expõe desde 2026-08-13) — recorta
//     KPIs, série diária, Top Vendedores e Por Marca; payload antigo sem as
//     chaves degrada para o comportamento anterior (filtra só o gráfico).
//   - filtros.periodo    → mês atual do ciclo ou janela via /dados/dashboard/filtered.

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
import {
  clean,
  dayOfMonth,
  isoDate,
  mesReferenciaAtual,
  num,
  remainingBusinessDaysSP,
} from "./shared";

// Linhas cruas do payload do bot — shape validado pelo fixture, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

/** Soma os campos kpi_* de um subconjunto de kpis_por_vendedor / kpis_por_marca. */
function somaKpis(rows: Row[]) {
  const t = {
    vendaLiquida: 0,
    custoRep: 0,
    frete: 0,
    qtdBruta: 0,
    qtdDev: 0,
    devolucoes: 0,
    cancelados: 0,
    fatBruto: 0,
    lucro: 0,
  };
  for (const r of rows) {
    t.vendaLiquida += num(r.kpi_venda_liquida);
    t.custoRep += num(r.kpi_custo_rep);
    t.frete += num(r.kpi_frete);
    t.qtdBruta += num(r.qtd_vendas_bruta);
    t.qtdDev += num(r.qtd_vendas_dev);
    t.devolucoes += num(r.kpi_devolucoes);
    t.cancelados += num(r.kpi_cancelados);
    t.fatBruto += num(r.kpi_faturamento_bruto);
    t.lucro += num(r.kpi_lucro_bruto);
  }
  return t;
}

/** Equivalente ao agregaPorDia do front antigo: filtra por chave e soma faturamento por dia. */
function agregaPorDia(
  rows: Row[],
  chave: string | null,
  selecao: Set<string> | null,
): { dia: string; valor: number }[] {
  const mapa = new Map<string, number>();
  for (const r of rows) {
    if (chave && selecao && !selecao.has(clean(r[chave]))) continue;
    const dia = isoDate(r.dia);
    if (!dia) continue;
    mapa.set(dia, (mapa.get(dia) ?? 0) + num(r.faturamento));
  }
  return [...mapa.entries()]
    .map(([dia, valor]) => ({ dia, valor }))
    .sort((a, b) => (a.dia < b.dia ? -1 : 1));
}

/**
 * A série diária do bot cobre os últimos 30 dias (cruza meses); a tela mostra o
 * mês de referência — recorta pelo mês do dia mais recente da série.
 */
function recortaMesDeReferencia(rows: { dia: string; valor: number }[]): SerieDia[] {
  if (!rows.length) return [];
  const prefixo = rows[rows.length - 1]!.dia.slice(0, 7);
  return rows
    .filter((r) => r.dia.startsWith(prefixo))
    .map((r) => ({ dia: dayOfMonth(r.dia), data: r.dia, valor: r.valor }));
}

/**
 * Agrega marcas_por_vendedor (nível produto: venda_liq_prod/custo_rep_prod/lucro_prod)
 * por Vendedor ou por DescrMarca, devolvendo fatias DimensaoValor ordenadas.
 */
function agregaNivelProduto(
  rows: Row[],
  por: "Vendedor" | "DescrMarca" | "DescrGrpItem",
): DimensaoValor[] {
  const mapa = new Map<string, DimensaoValor>();
  for (const r of rows) {
    const nome = clean(r[por]);
    if (!nome) continue;
    const alvo =
      mapa.get(nome) ??
      { nome, vendaLiquida: 0, custoReposicao: 0, lucroBruto: 0, margem: 0, quantidade: 0 };
    alvo.vendaLiquida += num(r.venda_liq_prod);
    alvo.custoReposicao += num(r.custo_rep_prod);
    alvo.lucroBruto += num(r.lucro_prod);
    alvo.quantidade += num(r.quantidade);
    mapa.set(nome, alvo);
  }
  return [...mapa.values()]
    .map((m) => ({
      ...m,
      margem: m.vendaLiquida > 0 ? (m.lucroBruto / m.vendaLiquida) * 100 : 0,
    }))
    .sort((a, b) => b.vendaLiquida - a.vendaLiquida);
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

  const vendSel = new Set(filtros.vendedores.map(clean).filter(Boolean));
  const marcaSel = new Set(filtros.marcas.map(clean).filter(Boolean));
  const grupoSel = new Set(filtros.grupos.map(clean).filter(Boolean));
  const temVend = vendSel.size > 0;
  const temMarca = marcaSel.size > 0;
  const temGrupo = grupoSel.size > 0;

  const kpisVend = asRows(d.kpis_por_vendedor);
  const kpisMarca = asRows(d.kpis_por_marca);
  const marcasVend = asRows(d.marcas_por_vendedor);
  const topVendRaw = asRows(d.top_vendedores);
  const marcasMes = asRows(d.marcas_mes);

  // Dimensão GRUPO (bot expõe desde 2026-08-13): KPIs por grupo, marca×grupo,
  // vendedor×grupo e série diária por grupo. Payload antigo (hub sem restart)
  // não tem as chaves → grupoAtivo=false e o filtro volta ao comportamento
  // anterior (recorta só o gráfico Por Grupo), sem quebrar nada.
  const kpisGrupo = asRows(d.kpis_por_grupo);
  const marcasGrupo = asRows(d.marcas_por_grupo);
  const gruposVend = asRows(d.grupos_por_vendedor);
  const diarioGrupoRaw = asRows(d.faturamento_diario_por_grupo);
  const grupoAtivo = temGrupo && kpisGrupo.length > 0;

  const doVendedor = (r: Row) => vendSel.has(clean(r.Vendedor));
  const daMarca = (r: Row) => marcaSel.has(clean(r.DescrMarca));
  const doGrupo = (r: Row) => grupoSel.has(clean(r.DescrGrpItem));

  // ── KPIs — Resultado Comercial + Performance ───────────────────────────────
  let resultado: DashboardData["resultado"];
  let ticketMedio: number;
  let frete: number;

  if (grupoAtivo && (temVend || temMarca)) {
    // Interseções com grupo só existem no nível produto: vendedor×grupo via
    // grupos_por_vendedor; marca×grupo via marcas_por_grupo. Devoluções/
    // cancelados/frete/contagens são nível documento → 0 (mesmo compromisso
    // do combo vendedor×marca). Trio vendedor×marca×grupo não tem fonte —
    // prevalece vendedor×grupo (marca segue recortando os gráficos).
    const rows = temVend
      ? gruposVend.filter((r) => doVendedor(r) && doGrupo(r))
      : marcasGrupo.filter((r) => daMarca(r) && doGrupo(r));
    let venda = 0;
    let custo = 0;
    let lucro = 0;
    for (const r of rows) {
      venda += num(r.venda_liq_prod);
      custo += num(r.custo_rep_prod);
      lucro += num(r.lucro_prod);
    }
    resultado = {
      faturamentoBruto: venda,
      devolucoes: 0,
      documentosCancelados: 0,
      faturamentoLiquido: venda,
      qtdVendas: 0,
      qtdDevolucoes: 0,
      lucroBruto: lucro,
      custoReposicao: custo,
    };
    ticketMedio = 0;
    frete = 0;
  } else if (grupoAtivo) {
    // kpi_cancelados/kpi_frete são null no nível grupo (como no nível marca) → 0.
    const t = somaKpis(kpisGrupo.filter(doGrupo));
    resultado = {
      faturamentoBruto: t.fatBruto,
      devolucoes: t.devolucoes,
      documentosCancelados: t.cancelados,
      faturamentoLiquido: t.vendaLiquida,
      qtdVendas: t.qtdBruta,
      qtdDevolucoes: t.qtdDev,
      lucroBruto: t.lucro,
      custoReposicao: t.custoRep,
    };
    ticketMedio = t.qtdBruta > 0 ? t.vendaLiquida / t.qtdBruta : 0;
    frete = t.frete;
  } else if (temVend && temMarca) {
    // Interseção vendedor×marca só existe no nível produto (marcas_por_vendedor).
    // Devoluções/cancelados/frete/contagens são nível documento → 0 na Fase 1.
    let venda = 0;
    let custo = 0;
    let lucro = 0;
    for (const r of marcasVend) {
      if (!doVendedor(r) || !daMarca(r)) continue;
      venda += num(r.venda_liq_prod);
      custo += num(r.custo_rep_prod);
      lucro += num(r.lucro_prod);
    }
    resultado = {
      faturamentoBruto: venda,
      devolucoes: 0,
      documentosCancelados: 0,
      faturamentoLiquido: venda,
      qtdVendas: 0,
      qtdDevolucoes: 0,
      lucroBruto: lucro,
      custoReposicao: custo,
    };
    ticketMedio = 0;
    frete = 0;
  } else if (temVend) {
    const t = somaKpis(kpisVend.filter(doVendedor));
    resultado = {
      faturamentoBruto: t.fatBruto,
      devolucoes: t.devolucoes,
      documentosCancelados: t.cancelados,
      faturamentoLiquido: t.vendaLiquida,
      qtdVendas: t.qtdBruta,
      qtdDevolucoes: t.qtdDev,
      lucroBruto: t.lucro,
      custoReposicao: t.custoRep,
    };
    ticketMedio = t.qtdBruta > 0 ? t.vendaLiquida / t.qtdBruta : 0;
    frete = t.frete;
  } else if (temMarca) {
    // kpi_cancelados/kpi_frete são null no nível marca (front antigo mostrava "—") → 0.
    const t = somaKpis(kpisMarca.filter(daMarca));
    resultado = {
      faturamentoBruto: t.fatBruto,
      devolucoes: t.devolucoes,
      documentosCancelados: t.cancelados,
      faturamentoLiquido: t.vendaLiquida,
      qtdVendas: t.qtdBruta,
      qtdDevolucoes: t.qtdDev,
      lucroBruto: t.lucro,
      custoReposicao: t.custoRep,
    };
    ticketMedio = t.qtdBruta > 0 ? t.vendaLiquida / t.qtdBruta : 0;
    frete = t.frete;
  } else {
    resultado = {
      faturamentoBruto: num(d.kpi_faturamento_bruto) || num(d.venda_bruta),
      devolucoes: num(d.kpi_devolucoes),
      documentosCancelados: num(d.kpi_cancelados),
      faturamentoLiquido: num(d.kpi_venda_liquida),
      qtdVendas: num(d.qtd_vendas_bruta),
      qtdDevolucoes: num(d.qtd_vendas_dev),
      lucroBruto: num(d.kpi_lucro_bruto),
      custoReposicao: num(d.kpi_custo_rep),
    };
    ticketMedio = num(d.ticket_medio);
    frete = num(d.kpi_frete);
  }

  // % da Meta: escalares globais usam pct_meta do bot; com filtro recalcula sobre
  // a meta da empresa (metas individuais por vendedor ficam para a Fase 2).
  // Meta efetiva (prioridade do front antigo): /metas — a mesma fonte das abas
  // Vendas/CRM — vence quando configurada; fallback meta_mensal do bot (ALERTAS).
  const metaConfigurada = num(rawMetas?.meta_mensal_total);
  const metaMensal = metaConfigurada > 0 ? metaConfigurada : num(d.meta_mensal);
  const kpiFiltrado = temVend || temMarca || grupoAtivo;
  const percentualMeta = kpiFiltrado
    ? metaMensal > 0
      ? (resultado.faturamentoLiquido / metaMensal) * 100
      : 0
    : num(d.pct_meta);

  // Margem Bruta = Lucro Bruto / Venda Líquida (fórmula validada do front antigo).
  const margemBruta =
    resultado.faturamentoLiquido > 0
      ? (resultado.lucroBruto / resultado.faturamentoLiquido) * 100
      : 0;

  // Meta do Dia DINÂMICA (front antigo): o que FALTA da meta ÷ dias úteis SP
  // restantes do mês corrente — cai conforme se vende.
  const agora = new Date();
  const metaDoDia =
    metaMensal > 0
      ? Math.max(metaMensal - resultado.faturamentoLiquido, 0) /
        Math.max(remainingBusinessDaysSP(agora.getFullYear(), agora.getMonth() + 1), 1)
      : 0;

  // ── Análise diária ─────────────────────────────────────────────────────────
  // A série tem uma dimensão por vez; em combos prevalece vendedor > grupo > marca.
  let diarioBase: { dia: string; valor: number }[];
  if (temVend) {
    diarioBase = agregaPorDia(asRows(d.faturamento_diario_por_vendedor), "Vendedor", vendSel);
  } else if (grupoAtivo) {
    diarioBase = agregaPorDia(diarioGrupoRaw, "DescrGrpItem", grupoSel);
  } else if (temMarca) {
    diarioBase = agregaPorDia(asRows(d.faturamento_diario_por_marca), "DescrMarca", marcaSel);
  } else {
    diarioBase = agregaPorDia(asRows(d.faturamento_diario), null, null);
  }
  // Janela personalizada (payload do endpoint filtrado carrega `janela`):
  // a série já é exatamente o range pedido — sem recorte ao mês. O rótulo
  // continua o dia do mês (SerieDia.dia é numérico); o tooltip usa `data`.
  const janela = d.janela as { de?: string; ate?: string } | undefined;
  const diario: SerieDia[] = janela
    ? diarioBase.map((r) => ({ dia: dayOfMonth(r.dia), data: r.dia, valor: r.valor }))
    : recortaMesDeReferencia(diarioBase);

  // ── Top vendedores ─────────────────────────────────────────────────────────
  const rankDoc = (rows: Row[]): RankVendedor[] =>
    rows.map((r) => ({
      vendedor: clean(r.Vendedor),
      valor: num(r.total_venda),
      ticket: num(r.ticket_medio),
      documentos: num(r.qtd_pedidos),
    }));

  let topVendedores: RankVendedor[];
  if (grupoAtivo) {
    // Sob filtro de grupo o ranking vem de grupos_por_vendedor (nível produto)
    // — ticket/documentos não existem nesse nível (mesmo padrão da marca).
    const rows = gruposVend.filter((r) => doGrupo(r) && (!temVend || doVendedor(r)));
    topVendedores = agregaNivelProduto(rows, "Vendedor")
      .slice(0, 10)
      .map((m) => ({ vendedor: m.nome, valor: m.vendaLiquida, ticket: 0, documentos: 0 }));
  } else if (temMarca) {
    // Front antigo: sob filtro de marca o ranking vem de marcas_por_vendedor
    // (venda_liq_prod, nível produto) — ticket/documentos não existem nesse nível.
    const rows = marcasVend.filter((r) => daMarca(r) && (!temVend || doVendedor(r)));
    topVendedores = agregaNivelProduto(rows, "Vendedor")
      .slice(0, 10)
      .map((m) => ({ vendedor: m.nome, valor: m.vendaLiquida, ticket: 0, documentos: 0 }));
  } else if (temVend) {
    topVendedores = rankDoc(topVendRaw.filter(doVendedor));
  } else {
    topVendedores = rankDoc(topVendRaw.slice(0, 10));
  }

  // ── Faturamento por Marca ──────────────────────────────────────────────────
  let porMarca: DimensaoValor[];
  if (grupoAtivo) {
    // Sob filtro de grupo as marcas vêm de marcas_por_grupo (nível produto);
    // combo com vendedor não tem fonte tripla — o grupo prevalece.
    const rows = marcasGrupo.filter((r) => doGrupo(r) && (!temMarca || daMarca(r)));
    porMarca = agregaNivelProduto(rows, "DescrMarca").slice(0, 12);
  } else if (temVend) {
    const rows = marcasVend.filter((r) => doVendedor(r) && (!temMarca || daMarca(r)));
    porMarca = agregaNivelProduto(rows, "DescrMarca").slice(0, 12);
  } else {
    const base: DimensaoValor[] = kpisMarca.length
      ? kpisMarca.map((r) => {
          const venda = num(r.kpi_venda_liquida);
          const lucro = num(r.kpi_lucro_bruto);
          return {
            nome: clean(r.DescrMarca),
            vendaLiquida: venda,
            custoReposicao: num(r.kpi_custo_rep),
            lucroBruto: lucro,
            margem: venda > 0 ? (lucro / venda) * 100 : 0,
            quantidade: num(r.quantidade),
          };
        })
      : agregaNivelProduto(marcasMes, "DescrMarca"); // fallback: marcas_mes (top 8)
    porMarca = base
      .filter((m) => !temMarca || marcaSel.has(m.nome))
      .sort((a, b) => b.vendaLiquida - a.vendaLiquida)
      .slice(0, 12);
  }

  // ── Faturamento por Grupo ──────────────────────────────────────────────────
  // Fonte preferida: kpis_por_grupo do próprio bot (custo/lucro/margem reais;
  // presente também na janela personalizada). Sob filtro de MARCA deriva de
  // marcas_por_grupo (só os grupos daquela marca); sob filtro de VENDEDOR,
  // de grupos_por_vendedor. Fallbacks p/ payload antigo: d.por_grupo (janela)
  // → v.por_grupo (vendas, custo desde 2026-08-11).
  let porGrupoTudo: DimensaoValor[];
  if (kpisGrupo.length) {
    if (temVend) {
      porGrupoTudo = agregaNivelProduto(gruposVend.filter(doVendedor), "DescrGrpItem");
    } else if (temMarca) {
      porGrupoTudo = agregaNivelProduto(marcasGrupo.filter(daMarca), "DescrGrpItem");
    } else {
      porGrupoTudo = kpisGrupo
        .map((r) => {
          const venda = num(r.kpi_venda_liquida);
          const lucro = num(r.kpi_lucro_bruto);
          return {
            nome: clean(r.DescrGrpItem),
            vendaLiquida: venda,
            custoReposicao: num(r.kpi_custo_rep),
            lucroBruto: lucro,
            margem: venda > 0 ? (lucro / venda) * 100 : 0,
            quantidade: num(r.quantidade),
          };
        })
        .filter((g) => g.nome)
        .sort((a, b) => b.vendaLiquida - a.vendaLiquida);
    }
  } else {
    const grupoFonte = asRows(d.por_grupo).length ? asRows(d.por_grupo) : asRows(v.por_grupo);
    porGrupoTudo = grupoFonte
      .map((r) => {
        const faturamento = num(r.faturamento);
        const custo = num(r.custo_rep);
        const lucro = custo > 0 ? faturamento - custo : 0;
        return {
          nome: clean(r.DescrGrpItem),
          vendaLiquida: faturamento,
          custoReposicao: custo,
          lucroBruto: lucro,
          margem: faturamento > 0 && custo > 0 ? (lucro / faturamento) * 100 : 0,
          quantidade: num(r.quantidade),
        };
      })
      .filter((g) => g.nome)
      .sort((a, b) => b.vendaLiquida - a.vendaLiquida);
  }
  const porGrupo = grupoSel.size
    ? porGrupoTudo.filter((g) => grupoSel.has(g.nome))
    : porGrupoTudo;

  // ── Dimensões (opções dos filtros) — nomes únicos com trim ─────────────────
  const nomesVend = new Map<string, string>(); // nome → id (CodVend quando houver)
  for (const r of [...kpisVend, ...topVendRaw, ...marcasVend]) {
    const nome = clean(r.Vendedor);
    if (nome && !nomesVend.has(nome)) nomesVend.set(nome, clean(r.CodVend) || nome);
  }
  const vendedores: Vendedor[] = [...nomesVend.entries()].map(([nome, id]) => ({ id, nome }));

  const nomesMarca = new Set<string>();
  for (const r of [...kpisMarca, ...marcasMes, ...marcasVend]) {
    const nome = clean(r.DescrMarca);
    if (nome) nomesMarca.add(nome);
  }
  const marcas: Marca[] = [...nomesMarca].sort().map((nome) => ({ id: nome, nome }));

  const nomesGrupo = new Map<string, string>(); // nome → id (CodGrpItem quando houver)
  const fonteDimGrupo = kpisGrupo.length
    ? kpisGrupo
    : asRows(d.por_grupo).length
      ? asRows(d.por_grupo)
      : asRows(v.por_grupo);
  for (const r of fonteDimGrupo) {
    const nome = clean(r.DescrGrpItem);
    if (nome && !nomesGrupo.has(nome)) nomesGrupo.set(nome, clean(r.CodGrpItem) || nome);
  }
  const grupos: Grupo[] = [...nomesGrupo.entries()].map(([nome, id]) => ({ id, nome }));

  const fmtBR = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  return {
    mesReferencia:
      janela?.de && janela?.ate
        ? `${fmtBR(janela.de)} a ${fmtBR(janela.ate)}`
        : mesReferenciaAtual(),
    vendedores,
    marcas,
    grupos,
    resultado,
    performance: {
      percentualMeta,
      metaDoDia,
      margemBruta,
      ticketMedio,
      frete,
    },
    diario,
    topVendedores,
    porMarca,
    porGrupo,
  };
}
