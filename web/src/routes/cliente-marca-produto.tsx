import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import { AppLayout } from "@/components/g2/AppLayout";
import { PageHeader } from "@/components/g2/PageHeader";
import { KpiCard, KpiGrid } from "@/components/g2/KpiCard";
import { Panel } from "@/components/g2/Panel";
import { DataTable } from "@/components/g2/DataTable";
import { FilterChips, MultiSelect, PeriodFilter } from "@/components/g2/Filters";
import { CHART, ChartTooltip, PIE_COLORS } from "@/components/g2/charts";
import { PERIODO_MES_ATUAL, useCmp } from "@/lib/api/hooks";
import type { Periodo } from "@/lib/api/types";
import { listaOuTodos, periodoTexto, secaoFiltros, secaoIndicadores } from "@/lib/export";
import type { SecaoExcel } from "@/lib/export";
import { brl, num, pct } from "@/lib/format";

export const Route = createFileRoute("/cliente-marca-produto")({
  head: () => ({
    meta: [
      { title: "Cliente × Marca × Produto | G2 Analytics" },
      {
        name: "description",
        content:
          "Análise cruzada de vendas líquidas por cliente, marca e produto com margem, ticket médio e devoluções.",
      },
      { property: "og:title", content: "Cliente × Marca × Produto | G2 Analytics" },
      {
        property: "og:description",
        content: "Cruzamento analítico de clientes, marcas e produtos da distribuidora.",
      },
    ],
  }),
  component: () => (
    <AppLayout>
      <ClienteMarcaProdutoPage />
    </AppLayout>
  ),
});

function ClienteMarcaProdutoPage() {
  const [periodo, setPeriodo] = useState<Periodo>(PERIODO_MES_ATUAL);
  const [clientes, setClientes] = useState<string[]>([]);
  const [vendedores, setVendedores] = useState<string[]>([]);
  const [marcas, setMarcas] = useState<string[]>([]);

  const filtros = useMemo(
    () => ({ periodo, clientes, vendedores, marcas }),
    [periodo, clientes, vendedores, marcas],
  );
  const { data, isLoading } = useCmp(filtros);

  const nomeCliente = (cod: string) =>
    data?.clientes.find((c) => c.codigo === cod)?.nome ?? cod;
  const nomeVendedor = (cod: string) =>
    data?.vendedores.find((v) => v.codigo === cod)?.nome ?? cod;

  const chips = useMemo(() => {
    const c: { key: string; label: string }[] = [];
    clientes.forEach((v) => c.push({ key: `cliente:${v}`, label: `Cliente: ${nomeCliente(v)}` }));
    vendedores.forEach((v) => c.push({ key: `vendedor:${v}`, label: `Vendedor: ${nomeVendedor(v)}` }));
    marcas.forEach((m) => c.push({ key: `marca:${m}`, label: `Marca: ${m}` }));
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientes, vendedores, marcas, data?.clientes, data?.vendedores]);

  const removeChip = (key: string) => {
    const [tipo, valor] = key.split(/:(.+)/);
    const remove = (v: string[]) => v.filter((x) => x !== valor);
    if (tipo === "cliente") setClientes(remove);
    if (tipo === "vendedor") setVendedores(remove);
    if (tipo === "marca") setMarcas(remove);
  };

  const toggleMarca = (marca: string) =>
    setMarcas((v) => (v.includes(marca) ? v.filter((x) => x !== marca) : [...v, marca]));

  const k = data?.kpis;

  const secoesExcel = (): SecaoExcel[] => {
    if (!data) return [];
    return [
      secaoFiltros([
        ["Período", periodoTexto(periodo)],
        ["Clientes", listaOuTodos(clientes.map(nomeCliente))],
        ["Vendedores", listaOuTodos(vendedores.map(nomeVendedor))],
        ["Marcas", listaOuTodos(marcas, "Todas")],
      ]),
      secaoIndicadores("Indicadores", [
        ["Margem de Lucro (%)", data.kpis.margemLucro],
        ["Ticket Médio Produto", data.kpis.ticketMedioProduto],
        ["Qtde. Vendas Líq.", data.kpis.qtdeVendasLiq],
        ["Venda Líquida", data.kpis.vendaLiquida],
        ["Devolução", data.kpis.devolucao],
        ["Frete (não recorta marca)", data.kpis.frete],
      ]),
      {
        nome: "Por Cliente",
        linhas: data.porCliente.map((r) => ({
          Código: r.codigo,
          Cliente: r.cliente,
          "Venda Líq.": r.vendaLiquida,
          "Margem Lucro Bruto": r.margemLucroBruto,
          "Qtde. Vendas": r.quantidade,
          "Tkt. Médio Produto": r.ticketMedioProduto,
        })),
      },
      {
        nome: "Por Marca",
        linhas: data.porMarca.map((r) => ({
          Marca: r.marca,
          "Venda Líq.": r.vendaLiquida,
          "Custo Rep. Líq.": r.custoReposicaoLiq,
          "Margem (%)": r.margem,
          "Qtde. Itens": r.quantidade,
          "Tkt. Médio": r.ticketMedio,
        })),
      },
      {
        nome: "Por Item",
        linhas: data.porItem.map((r) => ({
          COD: r.codigo,
          Item: r.item,
          "Venda Líq.": r.vendaLiquida,
          "Qtde.": r.quantidade,
          "Margem (%)": r.margem,
          Marca: r.marca,
        })),
      },
    ];
  };

  return (
    <>
      <PageHeader
        title="Cliente × Marca × Produto"
        subtitle="Cruzamento analítico de venda líquida, margem e quantidade"
        excel={secoesExcel}
      />

      <PeriodFilter periodo={periodo} onChange={setPeriodo} mesAtual={PERIODO_MES_ATUAL} />

      <div className="flex flex-wrap items-end gap-3">
        <MultiSelect
          label="Cliente"
          values={clientes}
          onChange={setClientes}
          allLabel="Todos os clientes"
          width="w-[260px]"
          options={(data?.clientes ?? []).map((c) => ({
            value: c.codigo,
            label: `${c.codigo} · ${c.nome}`,
          }))}
        />
        <MultiSelect
          label="Vendedor"
          values={vendedores}
          onChange={setVendedores}
          allLabel="Todos os vendedores"
          options={(data?.vendedores ?? []).map((v) => ({ value: v.codigo, label: v.nome }))}
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
          setClientes([]);
          setVendedores([]);
          setMarcas([]);
        }}
      />

      <KpiGrid cols={4}>
        <KpiCard loading={isLoading} label="Margem de Lucro" value={k?.margemLucro ?? 0} format="pct" tone="success" />
        <KpiCard loading={isLoading} label="Tkt. Médio Produto" value={k?.ticketMedioProduto ?? 0} format="brl" tone="purple" />
        <KpiCard loading={isLoading} label="Qtde. Vendas Líq." value={k?.qtdeVendasLiq ?? 0} format="int" tone="primary" />
        <KpiCard loading={isLoading} label="Venda Líq. (R$)" value={k?.vendaLiquida ?? 0} format="brl" tone="primary" />
        <KpiCard loading={isLoading} label="Devolução (R$)" value={k?.devolucao ?? 0} format="brl" tone="danger" />
        <KpiCard
          loading={isLoading}
          label="Frete"
          value={k?.frete ?? 0}
          format="brl"
          tone="warning"
          hint="não considera filtro de marca"
        />
      </KpiGrid>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel
          title="Cliente por Venda Produto (R$)"
          subtitle="Clique no cabeçalho para ordenar"
          className="xl:col-span-2"
          loading={isLoading}
        >
          <DataTable
            title="Cliente por Venda Produto"
            rows={data?.porCliente ?? []}
            search
            searchPlaceholder="Buscar cliente ou código..."
            searchFields={(r) => `${r.codigo} ${r.cliente}`}
            pageSize={10}
            columns={[
              {
                key: "codigo",
                header: "Código Cliente",
                render: (r) => (
                  <div>
                    <div className="font-medium tabular-nums text-foreground">{r.codigo}</div>
                    <div className="text-xs text-muted-foreground">{r.cliente}</div>
                  </div>
                ),
                sortValue: (r) => r.codigo,
              },
              {
                key: "vendaLiquida",
                header: "Venda Líq. (R$)",
                align: "right",
                render: (r) => brl(r.vendaLiquida),
                sortValue: (r) => r.vendaLiquida,
              },
              {
                key: "margemLucroBruto",
                header: "Margem Lucro Bruto",
                align: "right",
                render: (r) => brl(r.margemLucroBruto),
                sortValue: (r) => r.margemLucroBruto,
              },
              {
                key: "quantidade",
                header: "Qtde. Vendas",
                align: "right",
                render: (r) => num(r.quantidade, 0),
                sortValue: (r) => r.quantidade,
              },
              {
                key: "ticketMedioProduto",
                header: "Tkt. Médio Produto",
                align: "right",
                render: (r) => brl(r.ticketMedioProduto),
                sortValue: (r) => r.ticketMedioProduto,
              },
            ]}
          />
        </Panel>

        <Panel
          title="Marca × Qtde. Vendas"
          subtitle="Clique numa fatia para filtrar a página"
          loading={isLoading}
        >
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={data?.marcaQuantidade ?? []}
                dataKey="quantidade"
                nameKey="marca"
                innerRadius={70}
                outerRadius={110}
                paddingAngle={2}
                className="cursor-pointer"
                onClick={(d: { marca?: string }) => d?.marca && toggleMarca(d.marca)}
              >
                {(data?.marcaQuantidade ?? []).map((m, i) => (
                  <Cell
                    key={m.marca}
                    stroke="none"
                    fill={marcas.includes(m.marca) ? CHART.green : PIE_COLORS[i % PIE_COLORS.length]}
                  />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip format="num" />} />
            </PieChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title="Marca / Venda / Custo Líquido" loading={isLoading}>
          <DataTable
            title="Marca / Venda / Custo Líquido"
            rows={data?.porMarca ?? []}
            search
            searchPlaceholder="Buscar marca..."
            searchFields={(r) => r.marca}
            pageSize={10}
            columns={[
              { key: "marca", header: "Marca", render: (r) => r.marca, sortValue: (r) => r.marca },
              {
                key: "vendaLiquida",
                header: "Venda Líq.",
                align: "right",
                render: (r) => brl(r.vendaLiquida),
                sortValue: (r) => r.vendaLiquida,
              },
              {
                key: "custoReposicaoLiq",
                header: "Custo Rep. Líq.",
                align: "right",
                render: (r) => brl(r.custoReposicaoLiq),
                sortValue: (r) => r.custoReposicaoLiq,
              },
              {
                key: "margem",
                header: "Margem (%)",
                align: "right",
                render: (r) => (
                  <span className={r.margem >= 20 ? "text-success" : "text-warning"}>
                    {pct(r.margem)}
                  </span>
                ),
                sortValue: (r) => r.margem,
              },
              {
                key: "quantidade",
                header: "Qtde. Itens",
                align: "right",
                render: (r) => num(r.quantidade, 0),
                sortValue: (r) => r.quantidade,
              },
              {
                key: "ticketMedio",
                header: "Tkt. Médio (R$)",
                align: "right",
                render: (r) => brl(r.ticketMedio),
                sortValue: (r) => r.ticketMedio,
              },
            ]}
          />
        </Panel>

        <Panel title="Item / Venda / Qtde. Líquida (R$)" loading={isLoading}>
          <DataTable
            title="Item / Venda / Qtde. Líquida"
            rows={data?.porItem ?? []}
            search
            searchPlaceholder="Buscar item, código ou marca..."
            searchFields={(r) => `${r.codigo} ${r.item} ${r.marca}`}
            pageSize={10}
            columns={[
              { key: "codigo", header: "COD", render: (r) => r.codigo, sortValue: (r) => r.codigo },
              { key: "item", header: "Item", render: (r) => r.item, sortValue: (r) => r.item },
              {
                key: "vendaLiquida",
                header: "Venda Líq.",
                align: "right",
                render: (r) => brl(r.vendaLiquida),
                sortValue: (r) => r.vendaLiquida,
              },
              {
                key: "quantidade",
                header: "Qtde.",
                align: "right",
                render: (r) => num(r.quantidade, 0),
                sortValue: (r) => r.quantidade,
              },
              {
                key: "margem",
                header: "Margem",
                align: "right",
                render: (r) => pct(r.margem),
                sortValue: (r) => r.margem,
              },
              { key: "marca", header: "Marca", render: (r) => r.marca, sortValue: (r) => r.marca },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}
