import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  ComposedChart,
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
import { FilterChips, MultiSelect } from "@/components/g2/Filters";
import { CHART, CURSOR_FILL, ChartTooltip, axisProps, moneyAxis } from "@/components/g2/charts";

import { useCrm } from "@/lib/api/hooks";
import { listaOuTodos, secaoFiltros, secaoIndicadores } from "@/lib/export";
import type { SecaoExcel } from "@/lib/export";
import { brl, dt, num, pct } from "@/lib/format";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/crm")({
  head: () => ({
    meta: [
      { title: "CRM | G2 Analytics" },
      { name: "description", content: "Funil de vendas, equipe comercial, oportunidades e carteira." },
      { property: "og:title", content: "CRM | G2 Analytics" },
      { property: "og:description", content: "Conversão, pipeline e clientes em risco." },
    ],
  }),
  component: () => (
    <AppLayout>
      <CrmPage />
    </AppLayout>
  ),
});

function CrmPage() {
  const [vendedores, setVendedores] = useState<string[]>([]);
  const [maxDias, setMaxDias] = useState("90");
  const { data, isLoading } = useCrm(vendedores);

  // Seções do Excel — montadas só no clique; "Em Risco" já sai recortada
  // pelo mesmo filtro de dias da tela (até maxDias).
  const secoesExcel = (): SecaoExcel[] => {
    if (!data) return [];
    return [
      secaoFiltros([
        ["Vendedores", listaOuTodos(vendedores)],
        ["Em risco — até (dias)", Number(maxDias)],
      ]),
      secaoIndicadores("KPIs", [
        ["Taxa de Conversão (%)", data.kpis.taxaConversao],
        ["Pipeline do Mês", data.kpis.pipeline],
        ["Faturado no Mês", data.kpis.faturadoMes],
        ["Propostas já no Caixa", data.kpis.propostasCaixa],
        ["Clientes Ativos", data.kpis.clientesAtivos],
        ["Clientes Novos", data.kpis.clientesNovos],
        ["Em Risco", data.kpis.emRisco],
        ["Clientes Inativos", data.kpis.inativos],
      ]),
      {
        nome: "Funil",
        linhas: data.funil.map((f) => ({
          Etapa: f.etapa,
          Valor: f.valor,
          "Percentual (%)": f.percentual,
        })),
      },
      {
        nome: "Evolução Semanal",
        linhas: data.semanal.map((s) => ({
          Semana: s.semana,
          Propostas: s.propostas,
          Convertidos: s.convertidos,
        })),
      },
      {
        nome: "Ranking",
        linhas: data.ranking.map((r) => ({
          Vendedor: r.vendedor,
          Propostas: r.propostas,
          Conversões: r.conversoes,
          "Taxa (%)": r.taxa,
          Valor: r.valor,
          Ticket: r.ticket,
          Cancelados: r.cancelados,
          "% Meta": r.percentualMeta,
        })),
      },
      {
        nome: "Oportunidades",
        linhas: data.oportunidades.map((o) => ({
          Nº: o.numero,
          Cliente: o.cliente,
          Vendedor: o.vendedor,
          Data: dt(o.data),
          "Dias em Aberto": o.diasAberto,
          Valor: o.valor,
        })),
      },
      {
        nome: "Top Clientes",
        linhas: data.topClientes.map((c) => ({
          Código: c.codigo,
          Cliente: c.cliente,
          Valor: c.valor,
        })),
      },
      {
        nome: "Clientes Novos",
        linhas: data.clientesNovos.map((c) => ({
          Código: c.codigo,
          Cliente: c.cliente,
          Data: dt(c.data),
          "1ª Compra": c.valor,
        })),
      },
      {
        nome: "Histograma Inatividade",
        linhas: data.histogramaInatividade.map((h) => ({ Faixa: h.faixa, Clientes: h.clientes })),
      },
      {
        nome: "Em Risco",
        linhas: data.emRisco
          .filter((r) => r.dias <= Number(maxDias))
          .map((r) => ({
            Cliente: r.cliente,
            Vendedor: r.vendedor,
            Dias: r.dias,
            // bot não expõe receita nesta lista (0 = sem dado) → célula vazia
            "Receita 12m": r.valor === 0 ? null : r.valor,
          })),
      },
      {
        nome: "Inativos",
        linhas: data.inativos.map((i) => ({
          Cliente: i.cliente,
          "Último Vendedor": i.ultimoVendedor,
          Dias: i.dias,
          "Faturamento Histórico": i.historico,
        })),
      },
    ];
  };

  return (
    <>
      <PageHeader
        title="CRM"
        subtitle="Relacionamento, funil e performance da equipe"
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
      </div>
      <FilterChips
        chips={vendedores.map((v) => ({ key: v, label: `Vendedor: ${v}` }))}
        onRemove={(k) => setVendedores((v) => v.filter((x) => x !== k))}
        onClear={() => setVendedores([])}
      />


      <KpiGrid cols={4}>
        <KpiCard loading={isLoading} label="Taxa de Conversão" value={data?.kpis.taxaConversao ?? 0} format="pct" tone="success" />
        <KpiCard loading={isLoading} label="Pipeline do Mês" value={data?.kpis.pipeline ?? 0} format="brl" tone="primary" />
        <KpiCard loading={isLoading} label="Faturado no Mês" value={data?.kpis.faturadoMes ?? 0} format="brl" tone="success" />
        <KpiCard loading={isLoading} label="Propostas já no Caixa" value={data?.kpis.propostasCaixa ?? 0} format="brl" tone="purple" />
        <KpiCard loading={isLoading} label="Clientes Ativos" value={data?.kpis.clientesAtivos ?? 0} format="int" tone="primary" />
        <KpiCard loading={isLoading} label="Clientes Novos" value={data?.kpis.clientesNovos ?? 0} format="int" tone="success" />
        <KpiCard loading={isLoading} label="Em Risco" value={data?.kpis.emRisco ?? 0} format="int" tone="warning" />
        <KpiCard loading={isLoading} label="Clientes Inativos" value={data?.kpis.inativos ?? 0} format="int" tone="danger" />
      </KpiGrid>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel
          title="Funil do Mês"
          subtitle="Do orçamento em negociação até a nota faturada"
          loading={isLoading}
        >
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data?.funil ?? []} layout="vertical">
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tickFormatter={moneyAxis} {...axisProps} />
              <YAxis type="category" dataKey="etapa" width={120} {...axisProps} />
              <Tooltip cursor={{ fill: CURSOR_FILL }} content={<ChartTooltip />} />
              <Bar dataKey="valor" name="Valor" radius={[0, 4, 4, 0]}>
                <Cell fill={CHART.blue} />
                <Cell fill={CHART.purple} />
                <Cell fill={CHART.green} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="mt-2 text-xs text-muted-foreground">
            Leitura simples: de tudo que foi orçado no mês, uma parte é fechada e outra parte já
            virou nota fiscal faturada.
          </p>
        </Panel>

        <Panel title="Evolução Semanal" subtitle="Propostas × convertidos" loading={isLoading}>
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={data?.semanal ?? []}>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="semana" {...axisProps} />
              <YAxis {...axisProps} width={40} />
              <Tooltip cursor={{ fill: CURSOR_FILL }} content={<ChartTooltip format="num" />} />
              <Bar dataKey="propostas" name="Propostas" fill={CHART.blue} radius={[4, 4, 0, 0]} />
              <Line type="monotone" dataKey="convertidos" name="Convertidos" stroke={CHART.green} strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <Panel title="Equipe de Vendas — Ranking" loading={isLoading}>
        <DataTable
          rows={data?.ranking ?? []}
          search
          searchFields={(r) => r.vendedor}
          searchPlaceholder="Buscar vendedor..."
          columns={[
            { key: "v", header: "Vendedor", render: (r) => r.vendedor },
            { key: "p", header: "Propostas", align: "right", render: (r) => num(r.propostas) },
            { key: "c", header: "Conversões", align: "right", render: (r) => num(r.conversoes) },
            { key: "t", header: "Taxa", align: "right", render: (r) => pct(r.taxa) },
            { key: "val", header: "Valor", align: "right", render: (r) => brl(r.valor) },
            { key: "tk", header: "Ticket", align: "right", render: (r) => brl(r.ticket) },
            { key: "x", header: "Cancelados", align: "right", render: (r) => num(r.cancelados) },
            {
              key: "m",
              header: "% Meta",
              align: "center",
              render: (r) => (
                <Badge
                  className={
                    r.percentualMeta >= 100
                      ? "bg-success text-success-foreground"
                      : r.percentualMeta >= 80
                        ? "bg-warning text-warning-foreground"
                        : "bg-destructive text-destructive-foreground"
                  }
                >
                  {pct(r.percentualMeta)}
                </Badge>
              ),
            },
          ]}
        />
      </Panel>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel title="Ticket por Vendedor" loading={isLoading}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data?.ranking ?? []}>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="vendedor" hide />
              <YAxis tickFormatter={moneyAxis} {...axisProps} width={66} />
              <Tooltip cursor={{ fill: CURSOR_FILL }} content={<ChartTooltip />} />
              <Bar dataKey="ticket" name="Ticket" fill={CHART.purple} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="% de Meta" subtitle="Marca de referência em 80%" loading={isLoading}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data?.ranking ?? []}>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="vendedor" hide />
              <YAxis {...axisProps} width={44} />
              <Tooltip cursor={{ fill: CURSOR_FILL }} content={<ChartTooltip format="pct" />} />
              <Bar dataKey="percentualMeta" name="% Meta" radius={[4, 4, 0, 0]}>
                {(data?.ranking ?? []).map((r) => (
                  <Cell
                    key={r.vendedor}
                    fill={r.percentualMeta >= 100 ? CHART.green : r.percentualMeta >= 80 ? CHART.amber : CHART.red}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Convertidos × Cancelados" loading={isLoading}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data?.ranking ?? []}>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="vendedor" hide />
              <YAxis {...axisProps} width={40} />
              <Tooltip cursor={{ fill: CURSOR_FILL }} content={<ChartTooltip format="num" />} />
              <Bar dataKey="conversoes" name="Convertidos" fill={CHART.green} radius={[4, 4, 0, 0]} />
              <Bar dataKey="cancelados" name="Cancelados" fill={CHART.red} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <Panel title="Oportunidades — orçamentos abertos (90 dias)" loading={isLoading}>
        <DataTable
          rows={data?.oportunidades ?? []}
          search
          searchFields={(r) => `${r.numero} ${r.cliente} ${r.vendedor}`}
          searchPlaceholder="Buscar orçamento ou cliente..."
          pageSize={10}
          columns={[
            { key: "n", header: "Nº", render: (r) => r.numero },
            { key: "c", header: "Cliente", render: (r) => r.cliente },
            { key: "v", header: "Vendedor", render: (r) => r.vendedor },
            { key: "d", header: "Data", render: (r) => dt(r.data) },
            {
              key: "a",
              header: "Aging",
              align: "center",
              render: (r) => (
                <Badge
                  variant="outline"
                  className={r.diasAberto > 60 ? "border-destructive/60 text-destructive" : "border-warning/60 text-warning"}
                >
                  aberto há {r.diasAberto}d
                </Badge>
              ),
            },
            { key: "val", header: "Valor", align: "right", render: (r) => brl(r.valor) },
          ]}
        />
      </Panel>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel title="Top 10 Clientes do Mês" loading={isLoading}>
          <DataTable
            title="Top 10 Clientes"
            rows={data?.topClientes ?? []}
            dense
            columns={[
              { key: "cod", header: "Código", render: (r) => r.codigo },
              { key: "c", header: "Cliente", render: (r) => r.cliente },
              { key: "v", header: "Valor", align: "right", render: (r) => brl(r.valor), sortValue: (r) => r.valor },
            ]}
          />
        </Panel>
        <Panel title="Clientes Novos" loading={isLoading}>
          <DataTable
            title="Clientes Novos"
            rows={data?.clientesNovos ?? []}
            dense
            columns={[
              { key: "cod", header: "Código", render: (r) => r.codigo },
              { key: "c", header: "Cliente", render: (r) => r.cliente },
              { key: "d", header: "Data", render: (r) => dt(r.data), sortValue: (r) => r.data },
              { key: "v", header: "1ª compra", align: "right", render: (r) => brl(r.valor), sortValue: (r) => r.valor },
            ]}
          />
        </Panel>
        <Panel title="Histograma de Inatividade" loading={isLoading}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data?.histogramaInatividade ?? []}>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="faixa" {...axisProps} />
              <YAxis {...axisProps} width={40} />
              <Tooltip cursor={{ fill: CURSOR_FILL }} content={<ChartTooltip format="num" />} />
              <Bar dataKey="clientes" name="Clientes" fill={CHART.amber} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel
          title="Clientes Em Risco"
          actions={
            <select
              value={maxDias}
              onChange={(e) => setMaxDias(e.target.value)}
              className="h-9 rounded-md border border-input bg-surface px-2 text-sm text-foreground"
            >
              <option value="70">até 70 dias</option>
              <option value="80">até 80 dias</option>
              <option value="90">até 90 dias</option>
            </select>

          }
          loading={isLoading}
        >
          <DataTable
            rows={(data?.emRisco ?? []).filter((r) => r.dias <= Number(maxDias))}
            pageSize={8}
            search
            searchFields={(r) => `${r.cliente} ${r.vendedor}`}
            columns={[
              { key: "c", header: "Cliente", render: (r) => r.cliente },
              { key: "v", header: "Vendedor", render: (r) => r.vendedor },
              { key: "d", header: "Dias", align: "right", render: (r) => `${r.dias}d` },
              {
                key: "val",
                header: "Receita 12m",
                align: "right",
                // bot não expõe receita nesta lista (valor sempre 0) → "—"
                render: (r) => (r.valor === 0 ? "—" : brl(r.valor)),
              },
            ]}
          />
        </Panel>

        <Panel title="Clientes Inativos" loading={isLoading}>
          <DataTable
            rows={data?.inativos ?? []}
            pageSize={8}
            search
            searchFields={(r) => `${r.cliente} ${r.ultimoVendedor}`}
            columns={[
              { key: "c", header: "Cliente", render: (r) => r.cliente },
              { key: "v", header: "Último vendedor", render: (r) => r.ultimoVendedor },
              { key: "d", header: "Dias", align: "right", render: (r) => `${r.dias}d` },
              { key: "h", header: "Faturamento histórico", align: "right", render: (r) => brl(r.historico) },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}
