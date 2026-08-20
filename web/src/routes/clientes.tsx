import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { AppLayout } from "@/components/g2/AppLayout";
import { PageHeader } from "@/components/g2/PageHeader";
import { KpiCard, KpiGrid } from "@/components/g2/KpiCard";
import { Panel } from "@/components/g2/Panel";
import { DataTable } from "@/components/g2/DataTable";
import { CHART, CURSOR_FILL, ChartTooltip, PIE_COLORS, axisProps, moneyAxis } from "@/components/g2/charts";
import { useClientesCarteira } from "@/lib/api/hooks";
import { secaoFiltros, secaoIndicadores } from "@/lib/export";
import type { SecaoExcel } from "@/lib/export";
import { brl, dt, num, pct } from "@/lib/format";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/clientes")({
  head: () => ({
    meta: [
      { title: "Clientes | G2 Analytics" },
      { name: "description", content: "Carteira de clientes, segmentação por recência e curva ABC." },
      { property: "og:title", content: "Clientes | G2 Analytics" },
      { property: "og:description", content: "Receita 12m, concentração e top 50 clientes." },
    ],
  }),
  component: () => (
    <AppLayout>
      <ClientesPage />
    </AppLayout>
  ),
});

function ClientesPage() {
  const { data, isLoading } = useClientesCarteira();
  const conc = data?.kpis.concentracaoTop10 ?? 0;

  // Seções do Excel — montadas só no clique (a tela não tem filtros; a seção
  // Filtros registra apenas o recorte fixo e o carimbo de exportação).
  const secoesExcel = (): SecaoExcel[] => {
    if (!data) return [];
    return [
      secaoFiltros([["Recorte", "Carteira dos últimos 12 meses"]]),
      secaoIndicadores("KPIs", [
        ["Compradores 12m", data.kpis.compradores12m],
        ["Ativos no Mês", data.kpis.ativosMes],
        ["Novos no Mês", data.kpis.novosMes],
        ["Receita 12m", data.kpis.receita12m],
        ["Ticket Médio", data.kpis.ticketMedio],
        ["Concentração Top 10 (%)", data.kpis.concentracaoTop10],
      ]),
      {
        nome: "Segmentação",
        linhas: data.segmentacao.map((s) => ({ Faixa: s.faixa, Clientes: s.clientes })),
      },
      {
        nome: "Curva ABC",
        linhas: data.abc.map((c) => ({
          Classe: c.classe,
          Clientes: c.clientes,
          Receita: c.receita,
          "% da Receita": c.percentual,
        })),
      },
      {
        nome: "Ativos por Mês",
        linhas: data.ativosPorMes.map((m) => ({ Mês: m.mes, "Clientes Ativos": m.ativos })),
      },
      {
        nome: "Top 50",
        linhas: data.top50.map((c) => ({
          Código: c.codigo,
          Cliente: c.cliente,
          ABC: c.abc,
          Receita: c.receita,
          Pedidos: c.pedidos,
          Ticket: c.ticket,
          "Última Compra": dt(c.ultimaCompra),
          Situação: c.recencia,
        })),
      },
    ];
  };

  return (
    <>
      <PageHeader
        title="Clientes"
        subtitle="Visão de carteira dos últimos 12 meses"
        excel={secoesExcel}
      />

      <KpiGrid cols={6}>
        <KpiCard loading={isLoading} label="Compradores 12m" value={data?.kpis.compradores12m ?? 0} format="int" tone="primary" />
        <KpiCard loading={isLoading} label="Ativos no Mês" value={data?.kpis.ativosMes ?? 0} format="int" tone="success" />
        <KpiCard loading={isLoading} label="Novos no Mês" value={data?.kpis.novosMes ?? 0} format="int" tone="purple" />
        <KpiCard loading={isLoading} label="Receita 12m" value={data?.kpis.receita12m ?? 0} format="brl" tone="primary" />
        <KpiCard loading={isLoading} label="Ticket Médio" value={data?.kpis.ticketMedio ?? 0} format="brl" tone="neutral" />
        <KpiCard
          loading={isLoading}
          label="Concentração Top 10"
          value={conc}
          format="pct"
          tone={conc > 50 ? "danger" : conc > 35 ? "warning" : "success"}
        />
      </KpiGrid>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel title="Segmentação por Recência" loading={isLoading}>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={data?.segmentacao ?? []} dataKey="clientes" nameKey="faixa" innerRadius={56} outerRadius={94} paddingAngle={2}>
                {(data?.segmentacao ?? []).map((s, i) => (
                  <Cell key={s.faixa} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke="none" />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip format="num" />} />
            </PieChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Curva ABC de Clientes" loading={isLoading}>
          <div className="grid gap-3">
            {(data?.abc ?? []).map((c) => (
              <div key={c.classe} className="rounded-md border border-border bg-surface p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">Classe {c.classe}</span>
                  <Badge variant="outline">{num(c.clientes)} clientes</Badge>
                </div>
                <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                  <span>{pct(c.percentual)} da receita</span>
                  <span className="tabular-nums">{brl(c.receita)}</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Clientes Ativos por Mês" loading={isLoading}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data?.ativosPorMes ?? []}>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="mes" {...axisProps} />
              <YAxis {...axisProps} width={44} />
              <Tooltip cursor={{ fill: CURSOR_FILL }} content={<ChartTooltip format="num" />} />
              <Bar dataKey="ativos" name="Clientes ativos" fill={CHART.blue} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <Panel title="Top 50 Clientes por Receita" loading={isLoading}>
        <DataTable
          rows={data?.top50 ?? []}
          search
          searchPlaceholder="Buscar cliente ou código..."
          searchFields={(r) => `${r.codigo} ${r.cliente}`}
          pageSize={12}
          columns={[
            { key: "cod", header: "Código", render: (r) => r.codigo },
            { key: "c", header: "Cliente", render: (r) => r.cliente },
            { key: "abc", header: "ABC", align: "center", render: (r) => <Badge variant="outline">{r.abc}</Badge> },
            { key: "r", header: "Receita", align: "right", render: (r) => brl(r.receita) },
            { key: "p", header: "Pedidos", align: "right", render: (r) => num(r.pedidos) },
            { key: "t", header: "Ticket", align: "right", render: (r) => brl(r.ticket) },
            { key: "u", header: "Última compra", render: (r) => dt(r.ultimaCompra) },
            {
              key: "s",
              header: "Situação",
              align: "center",
              render: (r) => {
                const map = {
                  Ativo: "bg-success text-success-foreground",
                  Atenção: "bg-warning text-warning-foreground",
                  "Em risco": "bg-warning text-warning-foreground",
                  Inativo: "bg-destructive text-destructive-foreground",
                } as Record<string, string>;
                return <Badge className={map[r.recencia] ?? ""}>{r.recencia}</Badge>;
              },
            },
          ]}
        />
      </Panel>
    </>
  );
}
