import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { AppLayout } from "@/components/g2/AppLayout";
import { PageHeader } from "@/components/g2/PageHeader";
import { KpiCard, KpiGrid } from "@/components/g2/KpiCard";
import { Panel } from "@/components/g2/Panel";
import { FilterChips, MultiSelect, PeriodFilter } from "@/components/g2/Filters";
import {
  CHART,
  CURSOR_FILL,
  ChartTooltip,
  DimensionTooltip,
  axisProps,
  moneyAxis,
} from "@/components/g2/charts";
import { PERIODO_MES_ATUAL, useDashboard } from "@/lib/api/hooks";
import type { DimensaoValor, Periodo } from "@/lib/api/types";
import { listaOuTodos, periodoTexto, secaoFiltros, secaoIndicadores } from "@/lib/export";
import type { SecaoExcel } from "@/lib/export";
import { brl, dt, pct } from "@/lib/format";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard | G2 Analytics" },
      { name: "description", content: "Resultado comercial do mês, performance e análise diária." },
      { property: "og:title", content: "Dashboard | G2 Analytics" },
      { property: "og:description", content: "Resultado comercial do mês em tempo real." },
    ],
  }),
  component: () => (
    <AppLayout>
      <DashboardPage />
    </AppLayout>
  ),
});

function DimensionChart({
  title,
  subtitle,
  data,
  color,
  loading,
  selected,
  onSelect,
  className = "",
}: {
  title: string;
  subtitle: string;
  data: DimensaoValor[];
  color: string;
  loading: boolean;
  selected: string[];
  onSelect: (nome: string) => void;
  className?: string;

}) {
  return (
    <Panel title={title} subtitle={subtitle} loading={loading} className={className}>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data} layout="vertical" margin={{ left: 10 }}>
          <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tickFormatter={moneyAxis} {...axisProps} />
          <YAxis type="category" dataKey="nome" width={130} {...axisProps} />
          <Tooltip cursor={{ fill: CURSOR_FILL }} content={<DimensionTooltip />} />
          <Bar
            dataKey="vendaLiquida"
            name="Venda Líquida"
            radius={[0, 4, 4, 0]}
            className="cursor-pointer"
            onClick={(d: { nome?: string }) => d?.nome && onSelect(d.nome)}
          >
            {data.map((d) => (
              <Cell key={d.nome} fill={selected.includes(d.nome) ? CHART.green : color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Panel>
  );
}

function DashboardPage() {
  const [vendedores, setVendedores] = useState<string[]>([]);
  const [marcas, setMarcas] = useState<string[]>([]);
  const [grupos, setGrupos] = useState<string[]>([]);
  // Período: rascunho (o que os inputs editam) × APLICADO (o que filtra).
  // A consulta de período personalizado é cara (~1-2 min) — só dispara na lupa.
  const [periodoDraft, setPeriodoDraft] = useState<Periodo>(PERIODO_MES_ATUAL);
  const [periodo, setPeriodo] = useState<Periodo>(PERIODO_MES_ATUAL);

  const filtros = useMemo(
    () => ({ vendedores, marcas, grupos, periodo }),
    [vendedores, marcas, grupos, periodo],
  );
  const { data, isLoading, isFetching } = useDashboard(filtros);
  const periodoCustom =
    periodo.inicio !== PERIODO_MES_ATUAL.inicio || periodo.fim !== PERIODO_MES_ATUAL.fim;

  const toggle = (setter: (fn: (v: string[]) => string[]) => void) => (nome: string) =>
    setter((v) => (v.includes(nome) ? v.filter((x) => x !== nome) : [...v, nome]));

  const chips = useMemo(() => {
    const c: { key: string; label: string }[] = [];
    vendedores.forEach((v) => c.push({ key: `vendedor:${v}`, label: `Vendedor: ${v}` }));
    marcas.forEach((m) => c.push({ key: `marca:${m}`, label: `Marca: ${m}` }));
    grupos.forEach((g) => c.push({ key: `grupo:${g}`, label: `Grupo: ${g}` }));
    return c;
  }, [vendedores, marcas, grupos]);

  const removeChip = (key: string) => {
    const [tipo, valor] = key.split(/:(.+)/);
    const remove = (v: string[]) => v.filter((x) => x !== valor);
    if (tipo === "vendedor") setVendedores(remove);
    if (tipo === "marca") setMarcas(remove);
    if (tipo === "grupo") setGrupos(remove);
  };

  const meta = data?.performance.percentualMeta ?? 0;
  const metaTone = meta >= 100 ? "success" : meta >= 75 ? "warning" : "danger";

  // Card "Meta do Dia": R$ vendido HOJE de R$ meta-do-dia + % cumprida.
  // Vendido hoje sai da própria série diária (segue os filtros aplicados).
  const hojeISO = (() => {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const vendidoHoje = data?.diario.find((s) => s.data === hojeISO)?.valor ?? 0;
  const metaDoDia = data?.performance.metaDoDia ?? 0;
  const pctDia = metaDoDia > 0 ? (vendidoHoje / metaDoDia) * 100 : vendidoHoje > 0 ? 100 : 0;
  const diaTone = pctDia >= 100 ? "success" : pctDia >= 50 ? "warning" : "danger";

  // Seções do Excel — montadas só no clique, com os filtros correntes.
  const secoesExcel = (): SecaoExcel[] => {
    if (!data) return [];
    const dimensao = (rotulo: string, linhas: DimensaoValor[]) =>
      linhas.map((d) => ({
        [rotulo]: d.nome,
        "Venda Líquida": d.vendaLiquida,
        "Custo de Reposição": d.custoReposicao,
        "Lucro Bruto": d.lucroBruto,
        "Margem (%)": d.margem,
        Quantidade: d.quantidade,
      }));
    return [
      secaoFiltros([
        ["Período", periodoTexto(periodo)],
        ["Vendedores", listaOuTodos(vendedores)],
        ["Marcas", listaOuTodos(marcas, "Todas")],
        ["Grupos", listaOuTodos(grupos)],
      ]),
      secaoIndicadores("Resultado", [
        ["Faturamento Bruto", data.resultado.faturamentoBruto],
        ["Devoluções", data.resultado.devolucoes],
        ["Documentos Cancelados", data.resultado.documentosCancelados],
        ["Faturamento Líquido", data.resultado.faturamentoLiquido],
        ["Quantidade de Vendas", data.resultado.qtdVendas],
        ["Quantidade de Devoluções", data.resultado.qtdDevolucoes],
        ["Lucro Bruto", data.resultado.lucroBruto],
        ["Custo de Reposição", data.resultado.custoReposicao],
      ]),
      secaoIndicadores("Performance", [
        ["% da Meta", data.performance.percentualMeta],
        ["Meta do Dia", data.performance.metaDoDia],
        ["Vendido Hoje", vendidoHoje],
        ["Meta do Dia Cumprida (%)", pctDia],
        ["Margem Bruta (%)", data.performance.margemBruta],
        ["Ticket Médio", data.performance.ticketMedio],
        ["Frete", data.performance.frete],
      ]),
      {
        nome: "Faturamento Diário",
        linhas: data.diario.map((d) => ({ Dia: d.dia, Data: dt(d.data), Faturamento: d.valor })),
      },
      {
        nome: "Top Vendedores",
        linhas: data.topVendedores.map((v) => ({
          Vendedor: v.vendedor,
          Faturamento: v.valor,
          "Ticket Médio": v.ticket,
          Documentos: v.documentos,
        })),
      },
      { nome: "Por Marca", linhas: dimensao("Marca", data.porMarca) },
      { nome: "Por Grupo", linhas: dimensao("Grupo", data.porGrupo) },
    ];
  };

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`Resultado comercial · ${data?.mesReferencia ?? "Agosto/2026"}`}
        excel={secoesExcel}
      />

      <div className="flex flex-wrap items-end gap-3">
        <PeriodFilter
          periodo={periodoDraft}
          onChange={(p) => {
            setPeriodoDraft(p);
            // Atalho "Mês Atual" aplica na hora; datas digitadas esperam a lupa.
            if (p.inicio === PERIODO_MES_ATUAL.inicio && p.fim === PERIODO_MES_ATUAL.fim) {
              setPeriodo(p);
            }
          }}
          onBuscar={() => setPeriodo(periodoDraft)}
          mesAtual={PERIODO_MES_ATUAL}
        />
        {periodoCustom && isFetching ? (
          <span className="mb-1.5 flex items-center gap-2 text-xs font-medium text-warning">
            <span className="live-dot size-2 rounded-full bg-warning" />
            Consultando período… (pode levar 1-2 min)
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <MultiSelect
          label="Vendedor"
          values={vendedores}
          onChange={setVendedores}
          allLabel="Todos os vendedores"
          options={(data?.vendedores ?? []).map((v) => ({ value: v.nome, label: v.nome }))}
        />
        <MultiSelect
          label="Marca"
          values={marcas}
          onChange={setMarcas}
          allLabel="Todas as marcas"
          options={(data?.marcas ?? []).map((m) => ({ value: m.nome, label: m.nome }))}
        />
        <MultiSelect
          label="Grupo"
          values={grupos}
          onChange={setGrupos}
          allLabel="Todos os grupos"
          options={(data?.grupos ?? []).map((g) => ({ value: g.nome, label: g.nome }))}
        />
      </div>

      <FilterChips
        chips={chips}
        onRemove={removeChip}
        onClear={() => {
          setVendedores([]);
          setMarcas([]);
          setGrupos([]);
        }}
      />

      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Resultado Comercial do Mês
      </h2>
      <KpiGrid cols={4}>
        <KpiCard loading={isLoading} label="Faturamento Bruto" value={data?.resultado.faturamentoBruto ?? 0} format="brl" tone="primary" />
        <KpiCard loading={isLoading} label="Devoluções" value={data?.resultado.devolucoes ?? 0} format="brl" tone="danger" />
        <KpiCard loading={isLoading} label="Documentos Cancelados" value={data?.resultado.documentosCancelados ?? 0} format="brl" tone="warning" />
        <KpiCard loading={isLoading} label="Faturamento Líquido" value={data?.resultado.faturamentoLiquido ?? 0} format="brl" tone="success" />
        <KpiCard loading={isLoading} label="Quantidade de Vendas" value={data?.resultado.qtdVendas ?? 0} format="int" tone="primary" />
        <KpiCard loading={isLoading} label="Quantidade de Devoluções" value={data?.resultado.qtdDevolucoes ?? 0} format="int" tone="danger" />
        <KpiCard loading={isLoading} label="Lucro Bruto" value={data?.resultado.lucroBruto ?? 0} format="brl" tone="success" />
        <KpiCard loading={isLoading} label="Custo de Reposição" value={data?.resultado.custoReposicao ?? 0} format="brl" tone="purple" />
      </KpiGrid>

      <h2 className="mt-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Performance
      </h2>
      <KpiGrid cols={5}>
        <KpiCard
          loading={isLoading}
          label="% da Meta"
          value={meta}
          format="pct"
          tone={metaTone}
          hint={meta >= 100 ? "Meta batida" : `Faltam ${pct(Math.max(0, 100 - meta))}`}
        />
        <KpiCard
          loading={isLoading}
          label="Meta do Dia"
          value={vendidoHoje}
          format="brl"
          tone={diaTone}
          hint={
            metaDoDia > 0
              ? `de ${brl(metaDoDia)} · ${pct(pctDia)} cumprida`
              : "meta do mês já atingida"
          }
        />
        <KpiCard loading={isLoading} label="Margem Bruta" value={data?.performance.margemBruta ?? 0} format="pct" tone="success" />
        <KpiCard loading={isLoading} label="Ticket Médio" value={data?.performance.ticketMedio ?? 0} format="brl" tone="purple" />
        <KpiCard loading={isLoading} label="Frete" value={data?.performance.frete ?? 0} format="brl" tone="warning" />
      </KpiGrid>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel
          title="Análise Diária — Faturamento"
          subtitle="Passe o mouse nos pontos para ver o valor do dia"
          className="xl:col-span-2"
          loading={isLoading}
        >
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={data?.diario ?? []}>
              <defs>
                <linearGradient id="fatGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CHART.blue} stopOpacity={0.5} />
                  <stop offset="100%" stopColor={CHART.blue} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="dia" {...axisProps} />
              <YAxis tickFormatter={moneyAxis} {...axisProps} width={70} />
              <Tooltip
                cursor={{ stroke: CHART.blue, strokeWidth: 1 }}
                content={<ChartTooltip labelPrefix="Dia " />}
              />
              <Area
                type="monotone"
                dataKey="valor"
                name="Faturamento"
                stroke={CHART.blue}
                strokeWidth={2}
                fill="url(#fatGrad)"
                activeDot={{ r: 5 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </Panel>

        <Panel
          title="Top 10 Vendedores"
          subtitle="Clique numa barra para filtrar a página"
          loading={isLoading}
        >
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data?.topVendedores ?? []} layout="vertical" margin={{ left: 10 }}>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tickFormatter={moneyAxis} {...axisProps} />
              <YAxis type="category" dataKey="vendedor" width={130} {...axisProps} />
              <Tooltip cursor={{ fill: CURSOR_FILL }} content={<ChartTooltip />} />
              <Bar
                dataKey="valor"
                name="Faturamento"
                radius={[0, 4, 4, 0]}
                onClick={(d: { vendedor?: string }) =>
                  d?.vendedor && toggle(setVendedores)(d.vendedor)
                }
                className="cursor-pointer"
              >
                {(data?.topVendedores ?? []).map((v) => (
                  <Cell
                    key={v.vendedor}
                    fill={vendedores.includes(v.vendedor) ? CHART.green : CHART.blue}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="mt-2 text-xs text-muted-foreground">
            Maior vendedor:{" "}
            <span className="text-foreground">
              {data?.topVendedores[0]?.vendedor} · {brl(data?.topVendedores[0]?.valor ?? 0)}
            </span>
          </p>
        </Panel>
      </div>

      <h2 className="mt-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Faturamento por Dimensão
      </h2>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <DimensionChart
          title="Faturamento por Marca"
          subtitle="Hover: venda líquida, custo, lucro, margem e quantidade"
          data={data?.porMarca ?? []}
          color={CHART.blue}
          loading={isLoading}
          selected={marcas}
          onSelect={toggle(setMarcas)}
        />
        <DimensionChart
          title="Faturamento por Grupo de Produtos"
          subtitle="Clique para filtrar toda a aba"
          data={data?.porGrupo ?? []}
          color={CHART.purple}
          loading={isLoading}
          selected={grupos}
          onSelect={toggle(setGrupos)}
        />
      </div>
    </>
  );
}

