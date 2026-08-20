import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { AppLayout } from "@/components/g2/AppLayout";
import { PageHeader } from "@/components/g2/PageHeader";
import { KpiCard, KpiGrid } from "@/components/g2/KpiCard";
import { Panel } from "@/components/g2/Panel";
import { FilterChips, MultiSelect } from "@/components/g2/Filters";
import { DataTable } from "@/components/g2/DataTable";
import { MetaProgressRow, statusMeta } from "@/components/g2/MetaProgress";
import { CHART, CURSOR_FILL, ChartTooltip, axisProps, moneyAxis } from "@/components/g2/charts";
import { PERIODO_MES_ATUAL, useVendas } from "@/lib/api/hooks";
import type { ProgressoDia } from "@/lib/api/types";
import { listaOuTodos, periodoTexto, secaoFiltros, secaoIndicadores } from "@/lib/export";
import type { SecaoExcel } from "@/lib/export";
import { brl, dt, num, pct } from "@/lib/format";

export const Route = createFileRoute("/vendas")({
  head: () => ({
    meta: [
      { title: "Vendas | G2 Analytics" },
      { name: "description", content: "Ritmo do mês, ranking de vendedores, itens e marcas." },
      { property: "og:title", content: "Vendas | G2 Analytics" },
      { property: "og:description", content: "Acompanhe o acumulado versus meta do mês." },
    ],
  }),
  component: () => (
    <AppLayout>
      <VendasPage />
    </AppLayout>
  ),
});

function VendasPage() {
  const [vendedores, setVendedores] = useState<string[]>([]);
  const [marcas, setMarcas] = useState<string[]>([]);
  const filtros = useMemo(
    () => ({ vendedores, marcas, grupos: [], periodo: PERIODO_MES_ATUAL }),
    [vendedores, marcas],
  );
  const { data, isLoading } = useVendas(filtros);

  const toggleVendedor = (nome: string) =>
    setVendedores((v) => (v.includes(nome) ? v.filter((x) => x !== nome) : [...v, nome]));

  const chips = useMemo(() => {
    const c: { key: string; label: string }[] = [];
    vendedores.forEach((v) => c.push({ key: `vendedor:${v}`, label: `Vendedor: ${v}` }));
    marcas.forEach((m) => c.push({ key: `marca:${m}`, label: `Marca: ${m}` }));
    return c;
  }, [vendedores, marcas]);

  const removeChip = (key: string) => {
    const [tipo, valor] = key.split(/:(.+)/);
    const remove = (v: string[]) => v.filter((x) => x !== valor);
    if (tipo === "vendedor") setVendedores(remove);
    if (tipo === "marca") setMarcas(remove);
  };

  const progresso = data?.progressoVendedores ?? [];
  const atingiram = progresso.filter((p) => p.percentual >= 100).length;

  // Seções do Excel — montadas só no clique, com os filtros correntes.
  const secoesExcel = (): SecaoExcel[] => {
    if (!data) return [];
    // Sentinelas NaN do ritmo (fim da série / meta ausente) viram célula vazia.
    const cru = (v: number) => (Number.isFinite(v) ? v : null);
    return [
      secaoFiltros([
        ["Período", periodoTexto(PERIODO_MES_ATUAL)],
        ["Vendedores", listaOuTodos(vendedores)],
        ["Marcas", listaOuTodos(marcas, "Todas")],
      ]),
      secaoIndicadores("KPIs", [
        ["Faturamento Bruto do Mês", data.kpis.faturamentoBruto],
        ["Devolução R$", data.kpis.devolucaoValor],
        ["Margem Bruta (%)", data.kpis.margemBruta],
        ["Ticket Médio", data.kpis.ticketMedio],
        ["Nº Documentos", data.kpis.documentos],
        ["Nº Devoluções", data.kpis.devolucoes],
        ["Clientes Ativos", data.kpis.clientesAtivos],
        ["Total Marcas", data.kpis.totalMarcas],
      ]),
      {
        nome: "Ritmo do Mês",
        linhas: data.ritmo.map((r) => ({
          Dia: r.dia,
          Acumulado: cru(r.acumulado),
          Meta: cru(r.meta),
        })),
      },
      {
        nome: "Progresso Vendedores",
        linhas: data.progressoVendedores.map((p) => ({
          Vendedor: p.vendedor,
          Realizado: p.realizado,
          Meta: p.meta,
          "Atingimento (%)": p.percentual,
        })),
      },
      {
        nome: "Meta do Dia por Vendedor",
        linhas: data.progressoDiarioVendedores.map((p) => ({
          Vendedor: p.vendedor,
          "Vendido Hoje": p.realizado,
          "Meta do Dia": p.meta,
          "Atingimento (%)": p.percentual,
        })),
      },
      {
        nome: "Progresso Diário",
        linhas: data.progressoDiario.map((p) => ({
          Dia: p.dia,
          Data: dt(p.data),
          "Meta do Dia": p.metaDia,
          Realizado: p.realizado,
          "Atingimento (%)": p.percentual,
        })),
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
      {
        nome: "Top Itens",
        linhas: data.topItens.map((i) => ({
          Código: i.codigo,
          Descrição: i.descricao,
          Marca: i.marca,
          Quantidade: i.quantidade,
          Valor: i.valor,
        })),
      },
      {
        nome: "Top Marcas",
        linhas: data.topMarcas.map((m) => ({
          Marca: m.marca,
          Documentos: m.documentos,
          Faturamento: m.valor,
        })),
      },
    ];
  };

  return (
    <>
      <PageHeader
        title="Vendas"
        subtitle="Agosto/2026 · desempenho comercial detalhado"
        excel={secoesExcel}
      />

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
      </div>

      <FilterChips
        chips={chips}
        onRemove={removeChip}
        onClear={() => {
          setVendedores([]);
          setMarcas([]);
        }}
      />

      <KpiGrid cols={4}>
        <KpiCard loading={isLoading} label="Faturamento Bruto do Mês" value={data?.kpis.faturamentoBruto ?? 0} format="brl" tone="primary" />
        <KpiCard loading={isLoading} label="Devolução R$" value={data?.kpis.devolucaoValor ?? 0} format="brl" tone="danger" />
        <KpiCard loading={isLoading} label="Margem Bruta" value={data?.kpis.margemBruta ?? 0} format="pct" tone="success" />
        <KpiCard loading={isLoading} label="Ticket Médio" value={data?.kpis.ticketMedio ?? 0} format="brl" tone="purple" />
        <KpiCard loading={isLoading} label="Nº Documentos" value={data?.kpis.documentos ?? 0} format="int" tone="primary" />
        <KpiCard loading={isLoading} label="Nº Devoluções" value={data?.kpis.devolucoes ?? 0} format="int" tone="danger" />
        <KpiCard loading={isLoading} label="Clientes Ativos" value={data?.kpis.clientesAtivos ?? 0} format="int" tone="success" />
        <KpiCard loading={isLoading} label="Total Marcas" value={data?.kpis.totalMarcas ?? 0} format="int" tone="warning" />
      </KpiGrid>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel
          title="Progresso da Meta por Vendedor"
          subtitle={`${atingiram} de ${progresso.length} vendedores já bateram a meta`}
          loading={isLoading}
          bodyClassName="max-h-[420px] space-y-2 overflow-y-auto pr-1"
        >
          {progresso.map((p) => (
            <MetaProgressRow key={p.vendedor} item={p} />
          ))}
        </Panel>

        <Panel
          title="Progresso Diário — Meta do Dia"
          subtitle="Vendido hoje × meta do dia (restante da meta ÷ dias úteis restantes)"
          loading={isLoading}
          bodyClassName="max-h-[420px] space-y-2 overflow-y-auto pr-1"
        >
          {(data?.progressoDiarioVendedores ?? []).map((p) => (
            <MetaProgressRow key={p.vendedor} item={p} />
          ))}
          {(data?.progressoDiarioVendedores ?? []).length === 0 && !isLoading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Configure metas individuais na aba Configurações.
            </p>
          ) : null}
        </Panel>
      </div>


      <Panel
        title="Ritmo do Mês — Acumulado vs Meta"
        subtitle="Meta distribuída pelos dias úteis do mês"
        loading={isLoading}
      >
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={data?.ritmo ?? []}>
            <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="dia" {...axisProps} />
            <YAxis tickFormatter={moneyAxis} {...axisProps} width={70} />
            <Tooltip content={<ChartTooltip labelPrefix="Dia " />} />
            <Line
              type="monotone"
              dataKey="acumulado"
              name="Acumulado"
              stroke={CHART.blue}
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 5 }}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="meta"
              name="Meta"
              stroke={CHART.amber}
              strokeDasharray="6 4"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </Panel>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title="Top Vendedores" subtitle="Clique para filtrar" loading={isLoading}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data?.topVendedores ?? []} layout="vertical">
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tickFormatter={moneyAxis} {...axisProps} />
              <YAxis type="category" dataKey="vendedor" width={130} {...axisProps} />
              <Tooltip cursor={{ fill: CURSOR_FILL }} content={<ChartTooltip />} />
              <Bar
                dataKey="valor"
                name="Faturamento"
                radius={[0, 4, 4, 0]}
                className="cursor-pointer"
                onClick={(d: { vendedor?: string }) => d?.vendedor && toggleVendedor(d.vendedor)}
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
        </Panel>

        <Panel title="Ticket Médio por Vendedor" loading={isLoading}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data?.topVendedores ?? []}>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="vendedor" hide />
              <YAxis tickFormatter={moneyAxis} {...axisProps} width={70} />
              <Tooltip cursor={{ fill: CURSOR_FILL }} content={<ChartTooltip />} />
              <Bar dataKey="ticket" name="Ticket Médio" fill={CHART.purple} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title="Top 10 Itens" loading={isLoading}>
          <DataTable
            rows={data?.topItens ?? []}
            search
            searchPlaceholder="Buscar item..."
            searchFields={(r) => `${r.codigo} ${r.descricao} ${r.marca}`}
            columns={[
              { key: "codigo", header: "Código", render: (r) => r.codigo },
              { key: "desc", header: "Descrição", render: (r) => r.descricao },
              { key: "marca", header: "Marca", render: (r) => r.marca },
              { key: "qtd", header: "Qtd", align: "right", render: (r) => num(r.quantidade) },
              { key: "valor", header: "Valor", align: "right", render: (r) => brl(r.valor) },
            ]}
          />
        </Panel>

        <Panel title="Top Marcas" loading={isLoading}>
          <DataTable
            rows={data?.topMarcas ?? []}
            search
            searchPlaceholder="Buscar marca..."
            searchFields={(r) => r.marca}
            pageSize={10}
            columns={[
              { key: "marca", header: "Marca", render: (r) => r.marca },
              { key: "docs", header: "Documentos", align: "right", render: (r) => num(r.documentos) },
              { key: "valor", header: "Faturamento", align: "right", render: (r) => brl(r.valor) },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}
