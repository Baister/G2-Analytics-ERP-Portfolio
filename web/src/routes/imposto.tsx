import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
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
import { FilterChips, PeriodFilter } from "@/components/g2/Filters";
import { CHART, CURSOR_FILL, ChartTooltip, PIE_COLORS, axisProps, moneyAxis } from "@/components/g2/charts";
import { PERIODO_MES_ATUAL, useImposto } from "@/lib/api/hooks";
import type { Periodo } from "@/lib/api/types";
import { periodoTexto, secaoFiltros, secaoIndicadores } from "@/lib/export";
import type { SecaoExcel } from "@/lib/export";
import { brl, dt, num, pct } from "@/lib/format";

export const Route = createFileRoute("/imposto")({
  head: () => ({
    meta: [
      { title: "Imposto | G2 Analytics" },
      { name: "description", content: "ICMS, ST, IPI, CFOP e tributação por item." },
      { property: "og:title", content: "Imposto | G2 Analytics" },
      { property: "og:description", content: "Apuração fiscal do mês e evolução de 12 meses." },
    ],
  }),
  component: () => (
    <AppLayout>
      <ImpostoPage />
    </AppLayout>
  ),
});

function ImpostoPage() {
  const [periodo, setPeriodo] = useState<Periodo>(PERIODO_MES_ATUAL);
  const { data, isLoading } = useImposto(periodo);
  const [cfop, setCfop] = useState<string | null>(null);

  const k = data?.kpis;
  const dentro = (data?.cfops ?? []).filter((c) => c.dentroEstado).reduce((s, c) => s + c.valor, 0);
  const fora = (data?.cfops ?? []).filter((c) => !c.dentroEstado).reduce((s, c) => s + c.valor, 0);

  // Seções do Excel — montadas só no clique; "CFOPs" respeita o chip ativo.
  const secoesExcel = (): SecaoExcel[] => {
    if (!data) return [];
    return [
      secaoFiltros([
        ["Período", periodoTexto(periodo)],
        ["CFOP", cfop ?? "Todos"],
      ]),
      secaoIndicadores("KPIs", [
        ["ICMS do Mês", data.kpis.icmsMes],
        ["Alíquota Efetiva (%)", data.kpis.aliquotaEfetiva],
        ["Projeção ICMS", data.kpis.projecaoIcms],
        ["Base de Cálculo", data.kpis.baseCalculo],
        ["Faturamento (NFs)", data.kpis.faturamentoNfs],
        ["Qtde NFs", data.kpis.qtdeNfs],
        ["Operações c/ ST — Outras", data.kpis.stOutras],
        ["Isentas ICMS", data.kpis.isentasIcms],
        ["ICMS-ST Destacado", data.kpis.icmsStDestacado],
        ["IPI Debitado", data.kpis.ipiDebitado],
        ["Isentas/Outras IPI", data.kpis.isentasIpi],
        ["Frete", data.kpis.frete],
      ]),
      {
        nome: "ICMS Diário",
        linhas: data.diario.map((d) => ({ Dia: d.dia, ICMS: d.icms })),
      },
      {
        nome: "Evolução 12 Meses",
        linhas: data.evolucao.map((e) => ({
          Mês: e.mes,
          ICMS: e.icms,
          "ICMS-ST": e.st,
          IPI: e.ipi,
          "Alíquota (%)": e.aliquota,
        })),
      },
      {
        nome: "CFOPs",
        linhas: data.cfops
          .filter((c) => !cfop || c.cfop === cfop)
          .map((c) => ({
            CFOP: c.cfop,
            Descrição: c.descricao,
            Origem: c.dentroEstado ? "Dentro do Estado" : "Fora do Estado",
            Valor: c.valor,
            ICMS: c.icms,
          })),
      },
      {
        nome: "CFOP 6 Meses",
        linhas: data.cfopEvolucao.map((e) => ({
          Mês: e.mes,
          "Dentro do Estado": e.dentro,
          "Fora do Estado": e.fora,
        })),
      },
      {
        nome: "Maiores NFs",
        linhas: data.maioresNfs.map((n) => ({
          NF: n.nf,
          Cliente: n.cliente,
          Data: dt(n.data),
          Valor: n.valor,
          ICMS: n.icms,
        })),
      },
      {
        nome: "Situações",
        linhas: data.situacoes.map((s) => ({ Situação: s.nome, Valor: s.valor })),
      },
      {
        nome: "Regras PIS-COFINS",
        linhas: data.regrasPisCofins.map((r) => ({
          Regra: r.regra,
          Itens: r.itens,
          Valor: r.valor,
        })),
      },
      {
        nome: "Itens x Tributação",
        linhas: data.itensTributacao.map((i) => ({
          Código: i.codigo,
          Descrição: i.descricao,
          CST: i.cst,
          NCM: i.ncm,
          "Alíquota (%)": i.aliquota,
          Valor: i.valor,
        })),
      },
    ];
  };

  return (
    <>
      <PageHeader title="Imposto" subtitle="Apuração fiscal · Agosto/2026" excel={secoesExcel} />

      <PeriodFilter periodo={periodo} onChange={setPeriodo} mesAtual={PERIODO_MES_ATUAL} />

      <FilterChips
        chips={cfop ? [{ key: "cfop", label: `CFOP: ${cfop}` }] : []}
        onRemove={() => setCfop(null)}
      />

      <KpiGrid cols={6}>
        <KpiCard loading={isLoading} label="ICMS do Mês" value={k?.icmsMes ?? 0} format="brl" tone="primary" />
        <KpiCard loading={isLoading} label="Alíquota Efetiva" value={k?.aliquotaEfetiva ?? 0} format="pct" tone="warning" />
        <KpiCard loading={isLoading} label="Projeção ICMS" value={k?.projecaoIcms ?? 0} format="brl" tone="purple" />
        <KpiCard loading={isLoading} label="Base de Cálculo" value={k?.baseCalculo ?? 0} format="brl" tone="primary" />
        <KpiCard loading={isLoading} label="Faturamento (NFs)" value={k?.faturamentoNfs ?? 0} format="brl" tone="success" />
        <KpiCard loading={isLoading} label="Qtde NFs" value={k?.qtdeNfs ?? 0} format="int" tone="neutral" />
        <KpiCard loading={isLoading} label="Operações c/ ST — Outras" value={k?.stOutras ?? 0} format="brl" tone="warning" />
        <KpiCard loading={isLoading} label="Isentas ICMS" value={k?.isentasIcms ?? 0} format="brl" tone="success" />
        <KpiCard loading={isLoading} label="ICMS-ST Destacado" value={k?.icmsStDestacado ?? 0} format="brl" tone="danger" />
        <KpiCard loading={isLoading} label="IPI Debitado" value={k?.ipiDebitado ?? 0} format="brl" tone="purple" />
        <KpiCard loading={isLoading} label="Isentas/Outras IPI" value={k?.isentasIpi ?? 0} format="brl" tone="neutral" />
        <KpiCard loading={isLoading} label="Frete" value={k?.frete ?? 0} format="brl" tone="primary" />
      </KpiGrid>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title="ICMS Dia a Dia" loading={isLoading}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data?.diario ?? []}>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="dia" {...axisProps} />
              <YAxis tickFormatter={moneyAxis} {...axisProps} width={66} />
              <Tooltip cursor={{ fill: CURSOR_FILL }} content={<ChartTooltip labelPrefix="Dia " />} />
              <Bar dataKey="icms" name="ICMS" fill={CHART.blue} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="Evolução 12 Meses" loading={isLoading}>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={data?.evolucao ?? []}>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="mes" {...axisProps} />
              <YAxis yAxisId="l" tickFormatter={moneyAxis} {...axisProps} width={66} />
              <YAxis yAxisId="r" orientation="right" {...axisProps} width={44} />
              <Tooltip content={<ChartTooltip />} />
              <Bar yAxisId="l" dataKey="icms" name="ICMS" fill={CHART.blue} radius={[4, 4, 0, 0]} />
              <Bar yAxisId="l" dataKey="st" name="ICMS-ST" fill={CHART.purple} radius={[4, 4, 0, 0]} />
              <Bar yAxisId="l" dataKey="ipi" name="IPI" fill={CHART.green} radius={[4, 4, 0, 0]} />
              <Line yAxisId="r" type="monotone" dataKey="aliquota" name="Alíquota" stroke={CHART.amber} strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel title="Dentro × Fora do Estado" loading={isLoading}>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie
                data={[
                  { nome: "Dentro do Estado", valor: dentro },
                  { nome: "Fora do Estado", valor: fora },
                ]}
                dataKey="valor"
                nameKey="nome"
                innerRadius={58}
                outerRadius={92}
                paddingAngle={2}
              >
                <Cell fill={CHART.blue} stroke="none" />
                <Cell fill={CHART.purple} stroke="none" />
              </Pie>
              <Tooltip content={<ChartTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </Panel>

        <Panel title="CFOP — evolução 6 meses" className="xl:col-span-2" loading={isLoading}>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data?.cfopEvolucao ?? []}>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="mes" {...axisProps} />
              <YAxis tickFormatter={moneyAxis} {...axisProps} width={66} />
              <Tooltip cursor={{ fill: CURSOR_FILL }} content={<ChartTooltip />} />
              <Bar dataKey="dentro" name="Dentro do Estado" fill={CHART.blue} radius={[4, 4, 0, 0]} />
              <Bar dataKey="fora" name="Fora do Estado" fill={CHART.purple} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <Panel title="Análise por CFOP — Top 10" subtitle="Clique numa linha para filtrar" loading={isLoading}>
        <DataTable
          rows={(data?.cfops ?? []).filter((c) => !cfop || c.cfop === cfop)}
          onRowClick={(r) => setCfop(cfop === r.cfop ? null : r.cfop)}
          columns={[
            { key: "c", header: "CFOP", render: (r) => r.cfop },
            { key: "d", header: "Descrição", render: (r) => r.descricao },
            {
              key: "e",
              header: "Origem",
              render: (r) => (r.dentroEstado ? "Dentro do Estado" : "Fora do Estado"),
            },
            { key: "v", header: "Valor", align: "right", render: (r) => brl(r.valor) },
            { key: "i", header: "ICMS", align: "right", render: (r) => brl(r.icms) },
          ]}
        />
      </Panel>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title="Maiores NFs do Mês" loading={isLoading}>
          <DataTable
            rows={data?.maioresNfs ?? []}
            dense
            columns={[
              { key: "nf", header: "NF", render: (r) => r.nf },
              { key: "c", header: "Cliente", render: (r) => r.cliente },
              { key: "d", header: "Data", render: (r) => dt(r.data) },
              { key: "v", header: "Valor", align: "right", render: (r) => brl(r.valor) },
              { key: "i", header: "ICMS", align: "right", render: (r) => brl(r.icms) },
            ]}
          />
        </Panel>

        <Panel title="Situações Tributárias" loading={isLoading}>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={data?.situacoes ?? []} dataKey="valor" nameKey="nome" outerRadius={96} paddingAngle={2}>
                {(data?.situacoes ?? []).map((s, i) => (
                  <Cell key={s.nome} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke="none" />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip format="pct" />} />
            </PieChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel title="Regras PIS/COFINS" loading={isLoading}>
          <DataTable
            rows={data?.regrasPisCofins ?? []}
            dense
            columns={[
              { key: "r", header: "Regra", render: (r) => r.regra },
              { key: "i", header: "Itens", align: "right", render: (r) => num(r.itens) },
              { key: "v", header: "Valor", align: "right", render: (r) => brl(r.valor) },
            ]}
          />
        </Panel>

        <Panel title="Itens × Tributação" className="xl:col-span-2" loading={isLoading}>
          <DataTable
            rows={data?.itensTributacao ?? []}
            search
            searchFields={(r) => `${r.codigo} ${r.descricao} ${r.ncm} ${r.cst}`}
            pageSize={10}
            columns={[
              { key: "c", header: "Código", render: (r) => r.codigo },
              { key: "d", header: "Descrição", render: (r) => r.descricao },
              { key: "cst", header: "CST", render: (r) => r.cst },
              { key: "n", header: "NCM", render: (r) => r.ncm },
              { key: "a", header: "Alíquota", align: "right", render: (r) => pct(r.aliquota) },
              { key: "v", header: "Valor", align: "right", render: (r) => brl(r.valor) },
            ]}
          />
        </Panel>
      </div>
    </>
  );
}
