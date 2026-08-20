import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Search } from "lucide-react";

import { AppLayout } from "@/components/g2/AppLayout";
import { PageHeader } from "@/components/g2/PageHeader";
import { Panel } from "@/components/g2/Panel";
import { PedidoTabela, linhasExcelPedidos } from "@/components/g2/PedidoTabela";
import { usePainelPedidos } from "@/lib/api/hooks";
import type { Pedido } from "@/lib/api/types";
import { secaoFiltros } from "@/lib/export";
import type { SecaoExcel } from "@/lib/export";
import { brl, num } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/painel-pedidos")({
  head: () => ({
    meta: [
      { title: "Painel de Pedidos ao Vivo | G2 Analytics" },
      {
        name: "description",
        content: "Telão operacional com pedidos aguardando faturamento, conferência e expedidos.",
      },
      { property: "og:title", content: "Painel de Pedidos ao Vivo | G2 Analytics" },
      { property: "og:description", content: "Acompanhe a fila de expedição em tempo real." },
    ],
  }),
  component: () => (
    <AppLayout>
      <PainelPedidosPage />
    </AppLayout>
  ),
});

function PainelPedidosPage() {
  const { data, isLoading } = usePainelPedidos();
  const [q, setQ] = useState("");

  const filtrar = (lista: Pedido[]) => {
    const t = q.trim().toLowerCase();
    if (!t) return lista;
    return lista.filter((p) =>
      `${p.pedido} ${p.razaoSocial} ${p.vendedor} ${p.nf ?? ""}`.toLowerCase().includes(t),
    );
  };

  const grupos = useMemo(
    () => [
      { titulo: "Aguardando Faturamento", lista: filtrar(data?.aguardandoFaturamento ?? []) },
      { titulo: "Aguardando Conferência", lista: filtrar(data?.aguardandoConferencia ?? []) },
      { titulo: "✓ Saiu Hoje", lista: filtrar(data?.saiuHoje ?? []), saiu: true },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, q],
  );

  // Seções do Excel — montadas só no clique; cada fila usa a lista já
  // filtrada pela busca corrente da tela.
  const secoesExcel = (): SecaoExcel[] => {
    if (!data) return [];
    return [
      secaoFiltros([["Busca", q.trim() || "Nenhuma"]]),
      ...grupos.map((g) => ({
        nome: g.titulo.replace("✓ ", ""),
        linhas: linhasExcelPedidos(g.lista),
      })),
      {
        nome: "Resumo",
        linhas: data.resumo.map((r) => ({
          Status: r.status,
          Pedidos: r.pedidos,
          Valor: r.valor,
        })),
      },
    ];
  };

  return (
    <>
      <PageHeader
        title="Painel de Pedidos"
        subtitle="Telão operacional de expedição"
        excel={secoesExcel}
        right={
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-2 rounded-full border border-destructive/40 bg-destructive/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-destructive">
              <span className="live-dot size-2 rounded-full bg-destructive" /> Ao vivo
            </span>
            <span className="text-xs text-muted-foreground">atualiza a cada 30s</span>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {isLoading
          ? Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)
          : (data?.resumo ?? []).map((r, i) => (
              <div key={r.status} className="panel kpi-top p-4 text-primary">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {r.status}
                </div>
                <div className="mt-2 flex items-end justify-between">
                  <span className="text-3xl font-bold tabular-nums text-foreground">
                    {num(r.pedidos)}
                  </span>
                  <span
                    className={cn(
                      "text-sm font-semibold tabular-nums",
                      i === 0 ? "text-warning" : i === 1 ? "text-primary" : "text-success",
                    )}
                  >
                    {brl(r.valor)}
                  </span>
                </div>
              </div>
            ))}
      </div>

      <div className="relative w-full max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar pedido, cliente, vendedor ou NF..."
          className="h-9 bg-surface pl-8 text-sm"
        />
      </div>

      {grupos.map((g) => (
        <Panel key={g.titulo} title={g.titulo} subtitle={`${num(g.lista.length)} pedidos`} loading={isLoading}>
          <PedidoTabela pedidos={g.lista} saiu={g.saiu} />
        </Panel>
      ))}
    </>
  );
}
