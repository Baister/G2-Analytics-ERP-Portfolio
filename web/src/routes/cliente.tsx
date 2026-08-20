import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, Search } from "lucide-react";
import {
  Area,
  AreaChart,
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
import { CHART, CURSOR_FILL, ChartTooltip, PIE_COLORS, axisProps, moneyAxis } from "@/components/g2/charts";
import { useClienteBusca, useClientePerfil } from "@/lib/api/hooks";
import type { ClientePerfil } from "@/lib/api/types";
import { secaoFiltros, secaoIndicadores } from "@/lib/export";
import type { SecaoExcel } from "@/lib/export";
import { brl, dt, num } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";

export const Route = createFileRoute("/cliente")({
  head: () => ({
    meta: [
      { title: "Cliente 360º | G2 Analytics" },
      {
        name: "description",
        content: "Perfil completo do cliente: compras, produtos, títulos e orçamentos.",
      },
      { property: "og:title", content: "Cliente 360º | G2 Analytics" },
      { property: "og:description", content: "Busque um cliente e veja o histórico completo." },
    ],
  }),
  component: () => (
    <AppLayout>
      <ClientePage />
    </AppLayout>
  ),
});

const situacaoClasse: Record<string, string> = {
  Ativo: "bg-success text-success-foreground",
  Atenção: "bg-warning text-warning-foreground",
  "Em risco": "bg-warning text-warning-foreground",
  Inativo: "bg-destructive text-destructive-foreground",
};

/** Seções do Excel do perfil 360º — função pura sobre o perfil carregado. */
function secoesExcelPerfil(p: ClientePerfil): SecaoExcel[] {
  return [
    secaoFiltros(
      [
        ["Nome", p.nome],
        ["Razão Social", p.razao],
        ["Código", p.codigo],
        ["CNPJ", p.cnpj],
        ["Cidade", p.cidade],
        ["UF", p.uf],
        ["Situação", p.situacao],
        ["Dias desde a última compra", p.diasUltimaCompra],
        ["Limite de Crédito", p.limiteCredito],
        ["Limite Utilizado", p.limiteUtilizado],
      ],
      "Cadastro",
    ),
    secaoIndicadores("KPIs 12m", [
      ["Total Comprado 12m", p.kpis.totalComprado],
      ["Pedidos", p.kpis.pedidos],
      ["Ticket Médio", p.kpis.ticket],
      ["Devoluções", p.kpis.devolucoes],
      ["Última Compra", dt(p.kpis.ultimaCompra)],
      ["Frequência (dias)", p.kpis.frequenciaDias],
    ]),
    {
      nome: "Evolução",
      linhas: p.evolucao.map((e) => ({ Mês: e.mes, Faturamento: e.valor })),
    },
    {
      nome: "Top Produtos",
      linhas: p.topProdutos.map((t) => ({
        Produto: t.descricao,
        Quantidade: t.quantidade,
        Valor: t.valor,
      })),
    },
    {
      nome: "Marcas",
      linhas: p.marcas.map((m) => ({ Marca: m.marca, Valor: m.valor })),
    },
    {
      nome: "Vendedores",
      linhas: p.vendedores.map((v) => ({
        Vendedor: v.vendedor,
        Período: v.periodo,
        Atual: v.atual ? "Sim" : "Não",
      })),
    },
    {
      nome: "Últimas Compras",
      linhas: p.compras.map((c) => ({
        Documento: c.documento,
        Data: dt(c.data),
        Valor: c.valor,
        Devolução: c.devolucao ? "Sim" : "Não",
      })),
    },
    {
      nome: "Orçamentos",
      linhas: p.orcamentos.map((o) => ({
        Nº: o.numero,
        Data: dt(o.data),
        "Dias em Aberto": o.dias,
        Valor: o.valor,
      })),
    },
    {
      nome: "Títulos",
      linhas: p.titulos.map((t) => ({
        Documento: t.documento,
        Vencimento: dt(t.vencimento),
        Situação: t.vencido ? "Vencido" : "A vencer",
        Valor: t.valor,
      })),
    },
  ];
}

function ClientePage() {
  const [termo, setTermo] = useState("");
  const [codigo, setCodigo] = useState<string | null>(null);
  const { data: resultados, isLoading: buscando } = useClienteBusca(termo);
  const { data: perfil, isLoading: carregando } = useClientePerfil(codigo);

  if (codigo) {
    return (
      <>
        <PageHeader
          title="Perfil do Cliente"
          subtitle="Visão 360º dos últimos 12 meses"
          excel={() => (perfil ? secoesExcelPerfil(perfil) : [])}
          right={
            <Button variant="outline" size="sm" onClick={() => setCodigo(null)}>
              <ArrowLeft className="size-4" /> Voltar
            </Button>
          }
        />
        {carregando || !perfil ? (
          <Skeleton className="h-96 w-full" />
        ) : (
          <PerfilCliente p={perfil} />
        )}
      </>
    );
  }

  return (
    <>
      {/* Sem perfil aberto não há o que exportar — [] cai no toast "Nada para exportar". */}
      <PageHeader
        title="Cliente"
        subtitle="Busque por nome, razão social, código ou CNPJ"
        excel={() => []}
      />

      <Panel>
        <div className="relative max-w-xl">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={termo}
            onChange={(e) => setTermo(e.target.value)}
            placeholder="Ex.: Comercial Aurora, 10234 ou 12.345.678/0001-90"
            className="h-11 bg-surface pl-9"
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Digite ao menos 2 caracteres para localizar clientes da carteira.
        </p>
      </Panel>

      {buscando ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : (resultados ?? []).length === 0 ? (
        <Panel>
          <p className="py-8 text-center text-sm text-muted-foreground">
            {termo.trim().length < 2
              ? "Nenhuma busca realizada ainda."
              : "Nenhum cliente encontrado para este termo."}
          </p>
        </Panel>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {(resultados ?? []).map((c) => (
            <button
              key={c.codigo}
              onClick={() => setCodigo(c.codigo)}
              className="panel p-4 text-left transition-colors hover:border-primary/60"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-semibold text-foreground">{c.nome}</span>
                <Badge variant="outline">{c.codigo}</Badge>
              </div>
              <div className="mt-1 truncate text-xs text-muted-foreground">{c.razao}</div>
              <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                <span>{c.cnpj}</span>
                <span>{c.cidade ? `${c.cidade}/${c.uf}` : c.uf}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function PerfilCliente({ p }: { p: ClientePerfil }) {
  const utilizacao = p.limiteCredito > 0 ? (p.limiteUtilizado / p.limiteCredito) * 100 : 0;

  return (
    <>
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-foreground">{p.nome}</h2>
              <Badge className={situacaoClasse[p.situacao] ?? ""}>{p.situacao}</Badge>
              <Badge variant="outline">Cód. {p.codigo}</Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{p.razao}</p>
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <span>CNPJ: {p.cnpj}</span>
              <span>{p.cidade ? `${p.cidade}/${p.uf}` : p.uf}</span>
              <span>Última compra há {num(p.diasUltimaCompra)} dias</span>
            </div>
          </div>
          <div className="w-full max-w-xs rounded-md border border-border bg-surface p-3">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Limite de crédito</span>
              <span className="tabular-nums text-foreground">{brl(p.limiteCredito)}</span>
            </div>
            <Progress value={Math.min(100, utilizacao)} className="mt-2 h-2" />
            <div className="mt-1 flex justify-between text-xs text-muted-foreground">
              <span>Utilizado {brl(p.limiteUtilizado)}</span>
              <span
                className={
                  utilizacao >= 90
                    ? "text-destructive"
                    : utilizacao >= 70
                      ? "text-warning"
                      : "text-success"
                }
              >
                {num(utilizacao, 1)}%
              </span>
            </div>
          </div>
        </div>
      </Panel>

      <KpiGrid cols={6}>
        <KpiCard label="Total Comprado 12m" value={p.kpis.totalComprado} format="brl" tone="primary" />
        <KpiCard label="Pedidos" value={p.kpis.pedidos} format="int" tone="neutral" />
        <KpiCard label="Ticket Médio" value={p.kpis.ticket} format="brl" tone="success" />
        <KpiCard label="Devoluções" value={p.kpis.devolucoes} format="brl" tone="danger" />
        <KpiCard label="Última Compra" value={dt(p.kpis.ultimaCompra)} format="text" tone="neutral" />
        <KpiCard
          label="Frequência"
          value={`a cada ${num(p.kpis.frequenciaDias)}d`}
          format="text"
          tone="purple"
        />
      </KpiGrid>

      <Panel title="Evolução de Compras — 12 meses">
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={p.evolucao}>
            <defs>
              <linearGradient id="gradCli" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART.blue} stopOpacity={0.5} />
                <stop offset="100%" stopColor={CHART.blue} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="mes" {...axisProps} />
            <YAxis {...axisProps} tickFormatter={moneyAxis} width={64} />
            <Tooltip content={<ChartTooltip />} />
            <Area
              type="monotone"
              dataKey="valor"
              name="Faturamento"
              stroke={CHART.blue}
              strokeWidth={2}
              fill="url(#gradCli)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </Panel>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title="Top 10 Produtos">
          <DataTable
            rows={p.topProdutos}
            dense
            columns={[
              { key: "d", header: "Produto", render: (r) => r.descricao },
              { key: "q", header: "Qtd", align: "right", render: (r) => num(r.quantidade) },
              { key: "v", header: "Valor", align: "right", render: (r) => brl(r.valor) },
            ]}
          />
        </Panel>

        <Panel title="Participação por Marca">
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={p.marcas}
                dataKey="valor"
                nameKey="marca"
                innerRadius={58}
                outerRadius={100}
                paddingAngle={2}
              >
                {p.marcas.map((m, i) => (
                  <Cell key={m.marca} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke="none" />
                ))}
              </Pie>
              <Tooltip content={<ChartTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title="Histórico de Vendedores">
          <DataTable
            rows={p.vendedores}
            dense
            columns={[
              { key: "v", header: "Vendedor", render: (r) => r.vendedor },
              { key: "p", header: "Período", render: (r) => r.periodo },
              {
                key: "a",
                header: "",
                align: "right",
                render: (r) =>
                  r.atual ? <Badge className="bg-success text-success-foreground">ATUAL</Badge> : null,
              },
            ]}
          />
        </Panel>

        <Panel title="Últimas 15 Compras">
          <DataTable
            rows={p.compras}
            dense
            columns={[
              { key: "d", header: "Documento", render: (r) => r.documento },
              { key: "dt", header: "Data", render: (r) => dt(r.data) },
              {
                key: "v",
                header: "Valor",
                align: "right",
                render: (r) => (
                  <span className={r.devolucao ? "text-destructive" : ""}>
                    {r.devolucao ? `- ${brl(r.valor)}` : brl(r.valor)}
                  </span>
                ),
              },
            ]}
          />
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel title="Orçamentos em Aberto">
          <DataTable
            rows={p.orcamentos}
            dense
            empty="Nenhum orçamento em aberto."
            columns={[
              { key: "n", header: "Nº", render: (r) => r.numero },
              { key: "d", header: "Data", render: (r) => dt(r.data) },
              {
                key: "a",
                header: "Aging",
                align: "center",
                render: (r) => (
                  <Badge
                    className={
                      r.dias > 60
                        ? "bg-destructive text-destructive-foreground"
                        : r.dias > 30
                          ? "bg-warning text-warning-foreground"
                          : ""
                    }
                    variant={r.dias > 30 ? "default" : "outline"}
                  >
                    aberto há {num(r.dias)}d
                  </Badge>
                ),
              },
              { key: "v", header: "Valor", align: "right", render: (r) => brl(r.valor) },
            ]}
          />
        </Panel>

        <Panel title="Títulos em Aberto">
          <DataTable
            rows={p.titulos}
            dense
            empty="Nenhum título em aberto."
            columns={[
              { key: "d", header: "Documento", render: (r) => r.documento },
              {
                key: "v",
                header: "Vencimento",
                render: (r) => (
                  <span className={r.vencido ? "font-medium text-destructive" : ""}>
                    {dt(r.vencimento)}
                  </span>
                ),
              },
              {
                key: "s",
                header: "Situação",
                align: "center",
                render: (r) =>
                  r.vencido ? (
                    <Badge className="bg-destructive text-destructive-foreground">Vencido</Badge>
                  ) : (
                    <Badge variant="outline">A vencer</Badge>
                  ),
              },
              { key: "val", header: "Valor", align: "right", render: (r) => brl(r.valor) },
            ]}
          />
        </Panel>
      </div>

      <Panel title="Resumo de Compras por Mês" subtitle="Quantidade de documentos por período">
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={p.evolucao}>
            <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="mes" {...axisProps} />
            <YAxis {...axisProps} tickFormatter={moneyAxis} width={64} />
            <Tooltip cursor={{ fill: CURSOR_FILL }} content={<ChartTooltip />} />
            <Bar dataKey="valor" name="Faturamento" fill={CHART.purple} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Panel>
    </>
  );
}
