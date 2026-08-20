import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  ComposedChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { AppLayout } from "@/components/g2/AppLayout";
import { PageHeader } from "@/components/g2/PageHeader";
import { KpiCard, KpiGrid } from "@/components/g2/KpiCard";
import { Panel } from "@/components/g2/Panel";
import { DataTable } from "@/components/g2/DataTable";
import { FilterChips } from "@/components/g2/Filters";
import { CHART, CURSOR_FILL, ChartTooltip, PIE_COLORS, axisProps, moneyAxis } from "@/components/g2/charts";
import { useEstoque } from "@/lib/api/hooks";
import { secaoFiltros, secaoIndicadores } from "@/lib/export";
import type { SecaoExcel } from "@/lib/export";
import { brl, num, pct } from "@/lib/format";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/estoque")({
  head: () => ({
    meta: [
      { title: "Estoque | G2 Analytics" },
      { name: "description", content: "Curva ABC, cobertura, estoque parado e itens por marca." },
      { property: "og:title", content: "Estoque | G2 Analytics" },
      { property: "og:description", content: "Controle de estoque e curva ABC da distribuidora." },
    ],
  }),
  component: () => (
    <AppLayout>
      <EstoquePage />
    </AppLayout>
  ),
});

function EstoquePage() {
  const { data, isLoading } = useEstoque();
  const [classe, setClasse] = useState<string | null>(null);
  const [marca, setMarca] = useState<string | null>(null);

  const itens = (data?.itens ?? []).filter(
    (i) => (!classe || i.classe === classe) && (!marca || i.marca === marca),
  );

  const chips = [
    ...(classe ? [{ key: "classe", label: `Classe: ${classe}` }] : []),
    ...(marca ? [{ key: "marca", label: `Marca: ${marca}` }] : []),
  ];

  // Seções do Excel — montadas só no clique; "Itens" usa a lista COMPLETA já
  // recortada pelo cross-filter (classe/marca), não a página da tabela.
  const secoesExcel = (): SecaoExcel[] => {
    if (!data) return [];
    return [
      secaoFiltros([
        ["Classe", classe ?? "Todas"],
        ["Marca", marca ?? "Todas"],
      ]),
      secaoIndicadores("KPIs", [
        ["Valor em Estoque", data.kpis.valorEstoque],
        ["Qtd em Estoque", data.kpis.qtdEstoque],
        ["SKUs", data.kpis.skus],
        ["Abaixo do Mínimo", data.kpis.abaixoMinimo],
        ["Sem Estoque", data.kpis.semEstoque],
        ["Estoque Parado", data.kpis.estoqueParado],
        ["Cobertura Média (dias)", data.kpis.coberturaMedia],
      ]),
      {
        nome: "Curva ABC",
        linhas: data.abc.map((a) => ({
          Classe: a.classe,
          Itens: a.itens,
          "% das Vendas": a.percentualVendas,
          "Valor em Estoque": a.valorEstoque,
        })),
      },
      {
        nome: "Valor por Marca",
        linhas: data.valorPorMarca.map((m) => ({ Marca: m.marca, Valor: m.valor })),
      },
      {
        nome: "Evolução",
        linhas: data.evolucao.map((e) => ({
          Mês: e.mes,
          Valor: e.valor,
          Quantidade: e.quantidade,
        })),
      },
      {
        nome: "Itens",
        linhas: itens.map((i) => ({
          Código: i.codigo,
          Descrição: i.descricao,
          Marca: i.marca,
          Classe: i.classe,
          Quantidade: i.quantidade,
          Disponível: i.disponivel,
          // 9999 = sentinela "sem venda registrada" (mantida para ordenação)
          "Dias sem Venda": i.diasSemVenda,
          Custo: i.custo,
          Valor: i.valor,
        })),
      },
    ];
  };

  return (
    <>
      <PageHeader
        title="Estoque"
        subtitle="Posição atual, curva ABC e evolução de 12 meses"
        excel={secoesExcel}
      />

      <FilterChips
        chips={chips}
        onRemove={(k) => (k === "classe" ? setClasse(null) : setMarca(null))}
        onClear={() => {
          setClasse(null);
          setMarca(null);
        }}
      />

      <KpiGrid cols={4}>
        <KpiCard loading={isLoading} label="Valor em Estoque" value={data?.kpis.valorEstoque ?? 0} format="brl" tone="primary" />
        <KpiCard loading={isLoading} label="Qtd em Estoque" value={data?.kpis.qtdEstoque ?? 0} format="int" tone="primary" />
        <KpiCard loading={isLoading} label="SKUs" value={data?.kpis.skus ?? 0} format="int" tone="purple" />
        <KpiCard loading={isLoading} label="Abaixo do Mínimo" value={data?.kpis.abaixoMinimo ?? 0} format="int" tone="warning" />
        <KpiCard loading={isLoading} label="Sem Estoque" value={data?.kpis.semEstoque ?? 0} format="int" tone="danger" />
        <KpiCard loading={isLoading} label="Estoque Parado" value={data?.kpis.estoqueParado ?? 0} format="brl" tone="danger" hint="Imobilizado +90 dias sem venda" />
        <KpiCard loading={isLoading} label="Cobertura Média" value={`${num(data?.kpis.coberturaMedia ?? 0, 1)} dias`} format="text" tone="success" />
      </KpiGrid>

      <h2 className="mt-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Curva ABC — últimos 90 dias
      </h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {(data?.abc ?? []).map((a, i) => (
          <button
            key={a.classe}
            onClick={() => setClasse(classe === a.classe ? null : a.classe)}
            className={`panel p-4 text-left transition-colors hover:border-primary/60 ${classe === a.classe ? "border-primary" : ""}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground">Classe {a.classe}</span>
              <Badge
                variant="outline"
                style={{ color: PIE_COLORS[i], borderColor: PIE_COLORS[i] }}
              >
                {pct(a.percentualVendas)} das vendas
              </Badge>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Itens</div>
                <div className="font-semibold tabular-nums">{num(a.itens)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">R$ em estoque</div>
                <div className="font-semibold tabular-nums">{brl(a.valorEstoque)}</div>
              </div>
            </div>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel title="Distribuição por Classe" loading={isLoading}>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={data?.abc ?? []}
                dataKey="valorEstoque"
                nameKey="classe"
                innerRadius={62}
                outerRadius={98}
                paddingAngle={2}
                onClick={(d: { classe?: string }) => d?.classe && setClasse(d.classe)}
                className="cursor-pointer"
              >
                {(data?.abc ?? []).map((a, i) => (
                  <Cell key={a.classe} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke="none" />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip labelPrefix="Classe " />} />
            </PieChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Valor por Marca — Top 10" subtitle="Clique para filtrar a tabela" className="xl:col-span-2" loading={isLoading}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={data?.valorPorMarca ?? []} layout="vertical">
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tickFormatter={moneyAxis} {...axisProps} />
              <YAxis type="category" dataKey="marca" width={110} {...axisProps} />
              <Tooltip cursor={{ fill: CURSOR_FILL }} content={<ChartTooltip />} />
              <Bar
                dataKey="valor"
                name="Valor em estoque"
                radius={[0, 4, 4, 0]}
                className="cursor-pointer"
                onClick={(d: { marca?: string }) => d?.marca && setMarca(d.marca)}
              >
                {(data?.valorPorMarca ?? []).map((m) => (
                  <Cell key={m.marca} fill={marca === m.marca ? CHART.green : CHART.blue} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <Panel title="Evolução do Estoque — 12 meses" loading={isLoading}>
        <ResponsiveContainer width="100%" height={280}>
          <ComposedChart data={data?.evolucao ?? []}>
            <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="mes" {...axisProps} />
            <YAxis yAxisId="l" tickFormatter={moneyAxis} {...axisProps} width={70} />
            <YAxis yAxisId="r" orientation="right" {...axisProps} width={60} />
            <Tooltip content={<ChartTooltip />} />
            <Bar yAxisId="l" dataKey="valor" name="Valor" fill={CHART.blue} radius={[4, 4, 0, 0]} />
            <Line
              yAxisId="r"
              type="monotone"
              dataKey="quantidade"
              name="Quantidade"
              stroke={CHART.amber}
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </Panel>

      <Panel title="Itens em Estoque" subtitle={`${num(itens.length)} itens`} loading={isLoading}>
        <DataTable
          rows={itens}
          search
          searchPlaceholder="Buscar por código, descrição ou marca..."
          searchFields={(r) => `${r.codigo} ${r.descricao} ${r.marca}`}
          pageSize={12}
          columns={[
            { key: "codigo", header: "Código", render: (r) => r.codigo },
            { key: "desc", header: "Descrição", render: (r) => r.descricao },
            { key: "marca", header: "Marca", render: (r) => r.marca },
            { key: "qtd", header: "Qtd", align: "right", render: (r) => num(r.quantidade) },
            { key: "disp", header: "Disponível", align: "right", render: (r) => num(r.disponivel) },
            {
              key: "dias",
              header: "Dias s/ venda",
              align: "right",
              render: (r) => (
                <span className={r.diasSemVenda > 90 ? "text-destructive" : r.diasSemVenda > 45 ? "text-warning" : ""}>
                  {/* 9999 = sentinela "sem venda registrada" (mantida no dado p/ ordenação) */}
                  {r.diasSemVenda >= 9999 ? "nunca" : num(r.diasSemVenda)}
                </span>
              ),
            },
            { key: "custo", header: "Custo", align: "right", render: (r) => brl(r.custo) },
            { key: "valor", header: "Valor", align: "right", render: (r) => brl(r.valor) },
          ]}
        />
      </Panel>
    </>
  );
}
