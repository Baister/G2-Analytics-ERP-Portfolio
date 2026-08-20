// Adaptador Vendas — converte o payload real do bot (GET /dados/vendas) + a
// resposta crua do GET /metas no contrato VendasData, com filtragem client-side.
//
// Lógica portada do front antigo (hub/frontend/src/pages/Vendas.jsx):
//   - Ritmo do Mês: acumulado de fat_diario_mes vs meta distribuída pelos dias
//     úteis SP (meta_mensal_total do /metas) — visão da empresa, não filtra.
//   - Progresso por vendedor: total_venda (por_vendedor) vs metas_individuais.
//   - filtros.vendedores → kpis_por_vendedor; filtros.marcas → kpis_por_marca;
//     vendedor×marca → interseção via marcas_por_vendedor (nível item).
//   - filtros.periodo → ignorado (backend entrega o mês corrente; Fase 2).
//
// /metas responde { meta_mensal_total: number, metas_individuais: {nome: meta},
// ultima_atualizacao: string|null } (hub/server.py).

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
import {
  clean,
  countBusinessDaysSP,
  dayOfMonth,
  getHolidaysSP,
  isBusinessDaySP,
  isoDate,
  mesDaSerie,
  num,
  pad2,
  remainingBusinessDaysSP,
  round2,
} from "./shared";

// Linhas cruas do payload do bot — shape validado pelo fixture, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

/** Soma os campos kpi_* de um subconjunto de kpis_por_vendedor / kpis_por_marca. */
function somaKpis(rows: Row[]) {
  const t = { vendaLiquida: 0, fatBruto: 0, devolucoes: 0, qtdBruta: 0, qtdDev: 0, lucro: 0 };
  for (const r of rows) {
    t.vendaLiquida += num(r.kpi_venda_liquida);
    t.fatBruto += num(r.kpi_faturamento_bruto);
    t.devolucoes += num(r.kpi_devolucoes);
    t.qtdBruta += num(r.qtd_vendas_bruta);
    t.qtdDev += num(r.qtd_vendas_dev);
    t.lucro += num(r.kpi_lucro_bruto);
  }
  return t;
}

/**
 * Ritmo do Mês (porte fiel do front antigo): acumulado diário vs reta da meta
 * proporcional aos dias úteis SP. Dias após o último dado ficam com acumulado
 * NaN (a linha para, como no mock); sem meta configurada a linha de meta some.
 */
function calculaRitmo(
  serie: Row[],
  metaTotal: number,
): { dia: number; acumulado: number; meta: number }[] {
  if (!serie.length) return [];
  const { ano, mes } = mesDaSerie(serie);
  const totalUteis = countBusinessDaysSP(ano, mes);
  const holidays = getHolidaysSP(ano);
  const mapa = new Map<string, number>();
  for (const r of serie) mapa.set(isoDate(r.dia), num(r.faturamento));
  const ultimoDia = isoDate(serie[serie.length - 1]!.dia);
  const diasNoMes = new Date(ano, mes, 0).getDate();

  let acum = 0;
  let uteis = 0;
  const out: { dia: number; acumulado: number; meta: number }[] = [];
  for (let d = 1; d <= diasNoMes; d++) {
    const ds = `${ano}-${pad2(mes)}-${pad2(d)}`;
    if (isBusinessDaySP(ds, holidays)) uteis++;
    const futuro = ds > ultimoDia;
    if (!futuro) acum += mapa.get(ds) ?? 0;
    out.push({
      dia: d,
      acumulado: futuro ? Number.NaN : round2(acum),
      meta: metaTotal > 0 ? round2((metaTotal * uteis) / totalUteis) : Number.NaN,
    });
  }
  return out;
}

/**
 * Top itens do mês. O payload de vendas não tem um top global — deriva de
 * top_itens_por_marca (cada item pertence a uma única marca, então somar os
 * dicionários não duplica; um top-10 global aparece no top da própria marca).
 * Sob filtro de vendedor usa top_itens_por_vendedor; com marca TAMBÉM
 * selecionada, recorta as linhas por DescrMarca (disponível desde 2026-08-12;
 * payload antigo sem a chave → recorte não se aplica, em vez de esvaziar).
 */
function calculaTopItens(raw: Row, vendSel: Set<string>, marcaSel: Set<string>): ItemRank[] {
  const porVendedor = vendSel.size > 0;
  const dict: Record<string, unknown> =
    (porVendedor ? raw.top_itens_por_vendedor : raw.top_itens_por_marca) ?? {};
  const chaves = porVendedor ? vendSel : marcaSel.size ? marcaSel : null;

  const mapa = new Map<string, ItemRank>();
  for (const [chaveBruta, lista] of Object.entries(dict)) {
    const chave = clean(chaveBruta);
    if (chaves && !chaves.has(chave)) continue;
    for (const r of asRows(lista)) {
      const descricao = clean(r.DescrItem);
      if (!descricao) continue;
      const marca = porVendedor ? clean(r.DescrMarca) || "—" : chave;
      // combo vendedor+marca: linha de outra marca sai do top
      if (porVendedor && marcaSel.size > 0 && "DescrMarca" in (r as object) && !marcaSel.has(marca)) {
        continue;
      }
      const id = `${marca}|${descricao}`;
      const alvo =
        mapa.get(id) ??
        { codigo: clean(r.CodItem) || "—", descricao, marca, quantidade: 0, valor: 0 };
      alvo.quantidade += num(r.quantidade);
      alvo.valor += num(r.faturamento ?? r.venda_liq_prod);
      mapa.set(id, alvo);
    }
  }
  return [...mapa.values()].sort((a, b) => b.valor - a.valor).slice(0, 10);
}

export function adaptVendas(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metas: any | null,
  filtros: Filtros,
): VendasData {
  const r: Row = raw ?? {};

  const vendSel = new Set(filtros.vendedores.map(clean).filter(Boolean));
  const marcaSel = new Set(filtros.marcas.map(clean).filter(Boolean));
  const temVend = vendSel.size > 0;
  const temMarca = marcaSel.size > 0;

  const kpisVend = asRows(r.kpis_por_vendedor);
  const kpisMarca = asRows(r.kpis_por_marca);
  const marcasVend = asRows(r.marcas_por_vendedor);
  const marcasMes = asRows(r.marcas_mes);
  const porVendedorRaw = asRows(r.por_vendedor);
  const topVendRaw = asRows(r.top_vendedores);
  const baseVendedores = porVendedorRaw.length ? porVendedorRaw : topVendRaw;

  const doVendedor = (row: Row) => vendSel.has(clean(row.Vendedor));
  const daMarca = (row: Row) => marcaSel.has(clean(row.DescrMarca));

  // ── Metas (/metas cru) — chaves com trim, como os nomes exibidos ───────────
  const metaTotal = num(metas?.meta_mensal_total);
  const metasIndividuais = new Map<string, number>();
  for (const [nome, valor] of Object.entries(metas?.metas_individuais ?? {})) {
    const limpo = clean(nome);
    if (limpo) metasIndividuais.set(limpo, num(valor));
  }

  // ── KPIs ───────────────────────────────────────────────────────────────────
  let kpis: VendasData["kpis"];
  if (temVend && temMarca) {
    // Interseção vendedor×marca: marcas_por_vendedor (nível item) tem
    // faturamento/devolucao/margem_bruta/qtd_documentos/qtd_devolucoes.
    let fat = 0;
    let dev = 0;
    let margem = 0;
    let docs = 0;
    let qtdDev = 0;
    for (const row of marcasVend) {
      if (!doVendedor(row) || !daMarca(row)) continue;
      fat += num(row.faturamento);
      dev += num(row.devolucao);
      margem += num(row.margem_bruta);
      docs += num(row.qtd_documentos);
      qtdDev += num(row.qtd_devolucoes);
    }
    kpis = {
      faturamentoBruto: fat,
      devolucaoValor: Math.abs(dev),
      margemBruta: fat > 0 ? (margem / fat) * 100 : 0,
      ticketMedio: docs > 0 ? fat / docs : 0,
      documentos: docs,
      devolucoes: qtdDev,
      clientesAtivos: 0, // nível cruzado não expõe clientes (front antigo: "—")
      totalMarcas: marcasMes.length,
    };
  } else if (temVend || temMarca) {
    const t = somaKpis(temVend ? kpisVend.filter(doVendedor) : kpisMarca.filter(daMarca));
    kpis = {
      faturamentoBruto: t.fatBruto,
      devolucaoValor: t.devolucoes,
      margemBruta: t.vendaLiquida > 0 ? (t.lucro / t.vendaLiquida) * 100 : 0,
      ticketMedio: t.qtdBruta > 0 ? t.vendaLiquida / t.qtdBruta : 0,
      documentos: t.qtdBruta,
      devolucoes: t.qtdDev,
      clientesAtivos: 0, // nível vendedor/marca não expõe clientes (front antigo: "—")
      totalMarcas: marcasMes.length,
    };
  } else {
    // Margem Bruta em % = Lucro Bruto / Venda Líquida (fórmula do front antigo;
    // margem_total do payload é R$, mas a tela formata como percentual).
    const vendaLiq = num(r.kpi_venda_liquida);
    kpis = {
      faturamentoBruto: num(r.kpi_faturamento_bruto),
      devolucaoValor: Math.abs(num(r.devolucao)) || num(r.kpi_devolucoes),
      margemBruta:
        vendaLiq > 0
          ? (num(r.kpi_lucro_bruto) / vendaLiq) * 100
          : num(r.faturamento_atual) > 0
            ? (num(r.margem_total) / num(r.faturamento_atual)) * 100
            : 0,
      ticketMedio: num(r.ticket_medio),
      // Front antigo: KPI global de documentos = qtd_vendas_bruta (fallback
      // qtd_documentos quando ausente); ticketMedio segue o escalar do bot.
      documentos: num(r.qtd_vendas_bruta) || num(r.qtd_documentos),
      devolucoes: num(r.qtd_devolucoes),
      clientesAtivos: num(r.clientes_ativos),
      totalMarcas: marcasMes.length,
    };
  }

  // ── Ritmo do Mês (visão da empresa — não filtra) ───────────────────────────
  const serieDiaria = asRows(r.fat_diario_mes);
  const ritmo = calculaRitmo(serieDiaria, metaTotal);

  // ── Top vendedores / Ticket médio ──────────────────────────────────────────
  const rankDoc = (rows: Row[]): RankVendedor[] =>
    rows.map((row) => ({
      vendedor: clean(row.Vendedor),
      valor: num(row.total_venda),
      ticket: num(row.ticket_medio),
      documentos: num(row.qtd_pedidos),
    }));

  let topVendedores: RankVendedor[];
  if (temMarca) {
    // Front antigo: sob filtro de marca o ranking vem de marcas_por_vendedor.
    const soma = new Map<string, { valor: number; documentos: number }>();
    for (const row of marcasVend) {
      if (!daMarca(row) || (temVend && !doVendedor(row))) continue;
      const nome = clean(row.Vendedor);
      if (!nome) continue;
      const alvo = soma.get(nome) ?? { valor: 0, documentos: 0 };
      alvo.valor += num(row.faturamento);
      alvo.documentos += num(row.qtd_documentos);
      soma.set(nome, alvo);
    }
    topVendedores = [...soma.entries()]
      .map(([vendedor, t]) => ({
        vendedor,
        valor: t.valor,
        ticket: t.documentos > 0 ? t.valor / t.documentos : 0,
        documentos: t.documentos,
      }))
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 10);
  } else if (temVend) {
    topVendedores = rankDoc(topVendRaw.filter(doVendedor));
  } else {
    topVendedores = rankDoc(topVendRaw.slice(0, 10));
  }

  // ── Top itens / Top marcas ─────────────────────────────────────────────────
  const topItens = calculaTopItens(r, vendSel, marcaSel);

  let topMarcas: VendasData["topMarcas"];
  if (temVend) {
    const soma = new Map<string, { valor: number; documentos: number }>();
    for (const row of marcasVend) {
      if (!doVendedor(row) || (temMarca && !daMarca(row))) continue;
      const nome = clean(row.DescrMarca);
      if (!nome) continue;
      const alvo = soma.get(nome) ?? { valor: 0, documentos: 0 };
      alvo.valor += num(row.faturamento);
      alvo.documentos += num(row.qtd_documentos);
      soma.set(nome, alvo);
    }
    topMarcas = [...soma.entries()]
      .map(([marca, t]) => ({ marca, valor: t.valor, documentos: t.documentos }))
      .sort((a, b) => b.valor - a.valor);
  } else {
    topMarcas = marcasMes
      .filter((row) => !temMarca || daMarca(row))
      .map((row) => ({
        marca: clean(row.DescrMarca),
        valor: num(row.faturamento),
        documentos: num(row.qtd_documentos),
      }))
      .sort((a, b) => b.valor - a.valor);
  }

  // ── Progresso de metas por vendedor (metas_individuais do /metas) ──────────
  const progressoVendedores: ProgressoVendedor[] = baseVendedores
    .map((row) => {
      const vendedor = clean(row.Vendedor);
      return {
        vendedor,
        realizado: num(row.total_venda),
        meta: metasIndividuais.get(vendedor) ?? 0,
        percentual: 0,
      };
    })
    .filter((p) => p.vendedor && p.meta > 0 && (!temVend || vendSel.has(p.vendedor)))
    .map((p) => ({ ...p, percentual: p.meta > 0 ? (p.realizado / p.meta) * 100 : 0 }))
    .sort((a, b) => b.percentual - a.percentual);

  // ── Meta do dia POR VENDEDOR (porte fiel do front antigo) ──────────────────
  // meta do dia = restante da meta mensal ÷ dias úteis restantes ("meta
  // ajustada pelo restante"); realizado = venda de HOJE (venda_hoje_vendedor).
  // Quem já bateu a meta do mês fica em 100%.
  const vendaHoje = new Map<string, number>();
  for (const row of asRows(raw?.venda_hoje_vendedor)) {
    const nome = clean(row.Vendedor);
    if (nome) vendaHoje.set(nome, num(row.venda_hoje));
  }
  const agora = new Date();
  const diasRestantes = Math.max(
    remainingBusinessDaysSP(agora.getFullYear(), agora.getMonth() + 1),
    1,
  );
  const progressoDiarioVendedores: ProgressoVendedor[] = progressoVendedores
    .map((p) => {
      const hoje = vendaHoje.get(p.vendedor) ?? 0;
      const bateuMes = p.realizado >= p.meta;
      const metaD = round2(Math.max(p.meta - p.realizado, 0) / diasRestantes);
      const percentual = bateuMes ? 100 : metaD > 0 ? Math.min((hoje / metaD) * 100, 100) : 0;
      return { vendedor: p.vendedor, realizado: hoje, meta: metaD, percentual };
    })
    .sort((a, b) => b.percentual - a.percentual);

  // ── Progresso diário (meta do dia = meta mensal ÷ dias úteis SP) ───────────
  const { ano, mes } = mesDaSerie(serieDiaria);
  const holidays = getHolidaysSP(ano);
  const metaDiaria = metaTotal > 0 ? metaTotal / countBusinessDaysSP(ano, mes) : 0;
  const progressoDiario: ProgressoDia[] = serieDiaria.map((row) => {
    const data = isoDate(row.dia);
    const realizado = num(row.faturamento);
    // Fim de semana/feriado não carrega meta; venda nesses dias conta como 100%.
    const metaDia = isBusinessDaySP(data, holidays) ? round2(metaDiaria) : 0;
    return {
      dia: dayOfMonth(data),
      data,
      metaDia,
      realizado,
      percentual: metaDia > 0 ? (realizado / metaDia) * 100 : realizado > 0 ? 100 : 0,
    };
  });

  // ── Dimensões (opções dos filtros) — nomes únicos com trim ─────────────────
  const nomesVend = new Map<string, string>();
  for (const row of [...kpisVend, ...baseVendedores, ...marcasVend]) {
    const nome = clean(row.Vendedor);
    if (nome && !nomesVend.has(nome)) nomesVend.set(nome, clean(row.CodVend) || nome);
  }
  const vendedores: Vendedor[] = [...nomesVend.entries()].map(([nome, id]) => ({ id, nome }));

  const nomesMarca = new Set<string>();
  for (const row of [...kpisMarca, ...marcasMes, ...marcasVend]) {
    const nome = clean(row.DescrMarca);
    if (nome) nomesMarca.add(nome);
  }
  const marcas: Marca[] = [...nomesMarca].sort().map((nome) => ({ id: nome, nome }));

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
