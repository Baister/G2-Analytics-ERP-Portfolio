import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
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
import { CHART, CURSOR_FILL, ChartTooltip, axisProps, moneyAxis } from "@/components/g2/charts";
import { PeriodFilter } from "@/components/g2/Filters";
import { PERIODO_MES_ATUAL, useFinanceiro } from "@/lib/api/hooks";
import { periodoTexto, secaoFiltros, secaoIndicadores } from "@/lib/export";
import type { SecaoExcel } from "@/lib/export";
import { brl, dt, num, pct } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { FinanceiroData, FocoLinha, Periodo, TituloVencimento } from "@/lib/api/types";

export const Route = createFileRoute("/financeiro")({
  head: () => ({
    meta: [
      { title: "Financeiro | G2 Analytics" },
      { name: "description", content: "Contas a receber, inadimplência, boletos, cartão e limites." },
      { property: "og:title", content: "Financeiro | G2 Analytics" },
      { property: "og:description", content: "Títulos, vencimentos e limite de crédito por cliente." },
    ],
  }),
  component: () => (
    <AppLayout>
      <FinanceiroPage />
    </AppLayout>
  ),
});

const corVencimento = (s: TituloVencimento["situacao"]) =>
  s === "atrasado" ? CHART.red : s === "proximo" ? CHART.amber : CHART.green;

function FinanceiroPage() {
  const [periodo, setPeriodo] = useState<Periodo>(PERIODO_MES_ATUAL);
  const { data, isLoading } = useFinanceiro(periodo);
  const [dia, setDia] = useState<TituloVencimento | null>(null);
  const [foco, setFoco] = useState<FinanceiroData["foco"][number] | null>(null);

  const inad = data?.kpis.inadimplencia ?? 0;
  const inadTone = inad < 5 ? "success" : inad <= 15 ? "warning" : "danger";

  // Seções do Excel — montadas só no clique, com os filtros correntes.
  const secoesExcel = (): SecaoExcel[] => {
    if (!data) return [];
    const rotuloSituacao: Record<TituloVencimento["situacao"], string> = {
      atrasado: "Atrasado",
      proximo: "Próximo",
      futuro: "Futuro",
    };
    const focoSecao = (tipo: "Boleto" | "Cartão"): SecaoExcel => ({
      nome: `Foco ${tipo}`,
      linhas: (data.foco.find((f) => f.tipo === tipo)?.clientes ?? []).map((c) => ({
        Cliente: c.cliente,
        Documento: c.documento,
        // Dias cru: positivo = vencido; negativo = a vencer.
        Dias: c.dias,
        Situação: c.dias > 0 ? "Vencido" : "A vencer",
        Valor: c.valor,
      })),
    });
    return [
      secaoFiltros([["Período", periodoTexto(periodo)]]),
      secaoIndicadores("KPIs", [
        ["Total a Receber", data.kpis.aReceberValor],
        ["Títulos a Receber (qtd)", data.kpis.aReceberQtd],
        ["Títulos Vencidos", data.kpis.vencidos],
        ["A Vencer", data.kpis.aVencer],
        ["Recebido no Mês", data.kpis.recebidoMes],
        ["Inadimplência (%)", data.kpis.inadimplencia],
      ]),
      {
        nome: "Status dos Títulos",
        linhas: data.statusTitulos.map((s) => ({
          Status: s.nome,
          "Qtd. Títulos": s.quantidade,
          Valor: s.valor,
        })),
      },
      {
        // Achatado: uma linha por título de cada dia de vencimento.
        nome: "Vencimentos 30 Dias",
        linhas: data.vencimentos.flatMap((v) =>
          v.clientes.map((c) => ({
            Data: dt(v.data),
            Dia: v.dia,
            Cliente: c.cliente,
            Documento: c.documento,
            Valor: c.valor,
            Situação: rotuloSituacao[v.situacao],
          })),
        ),
      },
      {
        nome: "Foco Resumo",
        linhas: data.foco.map((f) => ({
          Tipo: f.tipo,
          "Em Aberto": f.emAberto,
          Vencidos: f.vencidos,
          "A Vencer 30d": f.aVencer30,
          "Recebido no Mês (títulos)": f.recebidoMes,
        })),
      },
      focoSecao("Boleto"),
      focoSecao("Cartão"),
      {
        nome: "Limites de Crédito",
        linhas: data.limites.map((l) => ({
          Código: l.codigo,
          Cliente: l.cliente,
          Limite: l.limite,
          Utilizado: l.utilizado,
          "Utilização (%)": l.utilizacao,
          Situação: l.utilizacao >= 90 ? "EXCEDIDO" : l.utilizacao >= 70 ? "RISCO" : "OK",
        })),
      },
    ];
  };

  return (
    <>
      <PageHeader
        title="Financeiro"
        subtitle="Contas a receber e saúde da carteira"
        excel={secoesExcel}
      />

      <PeriodFilter periodo={periodo} onChange={setPeriodo} mesAtual={PERIODO_MES_ATUAL} />

      <KpiGrid cols={5}>
        <KpiCard
          loading={isLoading}
          label="Total a Receber"
          value={`${num(data?.kpis.aReceberQtd ?? 0)} títulos`}
          format="text"
          tone="primary"
        />
        <KpiCard loading={isLoading} label="Títulos Vencidos" value={`${num(data?.kpis.vencidosQtd ?? 0)} títulos`} format="text" tone="danger" />
        <KpiCard loading={isLoading} label="A Vencer" value={`${num(data?.kpis.aVencerQtd ?? 0)} títulos`} format="text" tone="success" />
        <KpiCard loading={isLoading} label="Recebido no Mês" value={`${num(data?.kpis.recebidoMesQtd ?? 0)} títulos`} format="text" tone="purple" />
        <KpiCard loading={isLoading} label="Inadimplência" value={inad} format="pct" tone={inadTone} />
      </KpiGrid>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel title="Status dos Títulos" loading={isLoading}>
          <div className="relative">
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={data?.statusTitulos ?? []}
                  dataKey="quantidade"
                  nameKey="nome"
                  innerRadius={72}
                  outerRadius={104}
                  paddingAngle={2}
                >
                  <Cell fill={CHART.green} stroke="none" />
                  <Cell fill={CHART.red} stroke="none" />
                </Pie>
                <Tooltip content={<ChartTooltip format="num" />} />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-[11px] uppercase text-muted-foreground">Total</span>
              <span className="text-base font-semibold tabular-nums">
                {num(data?.kpis.aReceberQtd ?? 0)} títulos
              </span>
            </div>
          </div>
        </Panel>

        <Panel
          title="Vencimentos — Próximos 30 Dias"
          subtitle="Clique numa barra para ver os clientes do dia"
          className="xl:col-span-2"
          loading={isLoading}
        >
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={data?.vencimentos ?? []}>
              <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="dia" {...axisProps} />
              <YAxis tickFormatter={moneyAxis} {...axisProps} width={70} />
              <Tooltip cursor={{ fill: CURSOR_FILL }} content={<ChartTooltip labelPrefix="Dia " />} />
              <Bar
                dataKey="valor"
                name="A receber"
                radius={[4, 4, 0, 0]}
                className="cursor-pointer"
                onClick={(d: unknown) => setDia(d as TituloVencimento)}
              >
                {(data?.vencimentos ?? []).map((v) => (
                  <Cell key={v.data + v.dia} fill={corVencimento(v.situacao)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <h2 className="mt-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Foco Boleto &amp; Cartão
      </h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {(data?.foco ?? []).map((f) => (
          <Panel
            key={f.tipo}
            title={f.tipo}
            actions={<Badge variant="outline" className="border-warning/60 text-warning">{f.badge}</Badge>}
            loading={isLoading}
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { l: "Em Aberto", v: f.emAberto, c: "text-primary" },
                { l: "Vencidos", v: f.vencidos, c: "text-destructive" },
                { l: "A Vencer 30d", v: f.aVencer30, c: "text-warning" },
                { l: "Recebido no Mês", v: f.recebidoMes, c: "text-success" },
              ].map((m) => (
                <div key={m.l} className="rounded-md border border-border bg-surface p-3">
                  <div className="text-[11px] uppercase text-muted-foreground">{m.l}</div>
                  <div className={`mt-1 text-sm font-semibold tabular-nums ${m.c}`}>
                    {/* recebidoMes é CONTAGEM de títulos, não valor em R$ */}
                    {m.l === "Recebido no Mês" ? `${num(m.v)} títulos` : brl(m.v)}
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={() => setFoco(f)}
              className="mt-3 text-xs text-primary underline-offset-2 hover:underline"
            >
              ver clientes →
            </button>
          </Panel>
        ))}
      </div>

      <Panel title="Limite de Crédito por Cliente" loading={isLoading}>
        <DataTable
          title="Limite de Crédito"
          rows={data?.limites ?? []}
          search
          searchPlaceholder="Buscar cliente..."
          searchFields={(r) => `${r.codigo} ${r.cliente}`}
          pageSize={10}
          columns={[
            { key: "cod", header: "Código", render: (r) => r.codigo },
            { key: "cliente", header: "Cliente", render: (r) => r.cliente },
            { key: "limite", header: "Limite", align: "right", render: (r) => brl(r.limite) },
            { key: "util", header: "Utilizado", align: "right", render: (r) => brl(r.utilizado) },
            {
              key: "barra",
              header: "Utilização",
              render: (r) => {
                const cor =
                  r.utilizacao >= 90 ? "bg-destructive" : r.utilizacao >= 70 ? "bg-warning" : "bg-success";
                return (
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-32 overflow-hidden rounded-full bg-secondary">
                      <div className={`h-full ${cor}`} style={{ width: `${Math.min(100, r.utilizacao)}%` }} />
                    </div>
                    <span className="w-14 text-xs tabular-nums">{pct(r.utilizacao)}</span>
                  </div>
                );
              },
            },
            {
              key: "status",
              header: "Situação",
              align: "center",
              render: (r) =>
                r.utilizacao >= 90 ? (
                  <Badge className="bg-destructive text-destructive-foreground">EXCEDIDO</Badge>
                ) : r.utilizacao >= 70 ? (
                  <Badge className="bg-warning text-warning-foreground">RISCO</Badge>
                ) : (
                  <Badge variant="outline" className="border-success/60 text-success">OK</Badge>
                ),
            },
          ]}
        />
      </Panel>

      <Dialog open={!!dia} onOpenChange={(o) => !o && setDia(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Vencimentos de {dia ? dt(dia.data) : ""}</DialogTitle>
          </DialogHeader>
          <DataTable
            nested
            rows={dia?.clientes ?? []}
            columns={[
              { key: "c", header: "Cliente", render: (r) => r.cliente },
              { key: "d", header: "Documento", render: (r) => r.documento },
              { key: "v", header: "Valor", align: "right", render: (r) => brl(r.valor) },
            ]}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={!!foco} onOpenChange={(o) => !o && setFoco(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{foco?.tipo} — clientes com títulos</DialogTitle>
          </DialogHeader>
          <DataTable
            nested
            rows={(foco?.clientes ?? []) as FocoLinha[]}
            search
            searchFields={(r) => `${r.cliente} ${r.documento}`}
            pageSize={8}
            columns={[
              { key: "c", header: "Cliente", render: (r) => r.cliente },
              { key: "d", header: "Documento", render: (r) => r.documento },
              {
                key: "dias",
                header: "Dias",
                align: "right",
                render: (r) => (
                  <span className={r.dias > 0 ? "text-destructive" : "text-muted-foreground"}>
                    {r.dias > 0 ? `${r.dias}d vencido` : `${Math.abs(r.dias)}d a vencer`}
                  </span>
                ),
              },
              { key: "v", header: "Valor", align: "right", render: (r) => brl(r.valor) },
            ]}
          />
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={() => setFoco(null)}>
              Fechar
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
