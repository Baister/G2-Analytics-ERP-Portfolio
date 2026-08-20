import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { AppLayout } from "@/components/g2/AppLayout";
import { PageHeader } from "@/components/g2/PageHeader";
import { linhasExcelPedidos } from "@/components/g2/PedidoTabela";
import { usePainelPedidos } from "@/lib/api/hooks";
import type { Pedido } from "@/lib/api/types";
import { secaoFiltros } from "@/lib/export";
import type { SecaoExcel } from "@/lib/export";
import { num } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// Recorte deste telão (visual "praça de alimentação" fornecido pelo usuário):
// SÓ pedidos RETIRA NA LOJA, registrados HOJE dentro do expediente.
// A hora de registro é o "primeiro rastro do dia" calculado pelo hub
// (min entre o primeiro evento do log e o DtHrEdit — o ERP não guarda a
// hora de criação; ver hub/server.py). Pedido sem hora apurável fica fora.
const HORA_INICIO = "08:00";
const HORA_FIM = "18:00";

export const Route = createFileRoute("/painel-pedidos-cliente")({
  head: () => ({
    meta: [
      { title: "Painel de Pedidos - Cliente | G2 Analytics" },
      {
        name: "description",
        content:
          "Telão de retirada: pedidos de hoje (08h-18h) aguardando conferência, faturamento e expedidos.",
      },
      { property: "og:title", content: "Painel de Pedidos - Cliente | G2 Analytics" },
      { property: "og:description", content: "Acompanhe a retirada dos pedidos do dia em tempo real." },
    ],
  }),
  component: () => (
    <AppLayout>
      <PainelPedidosClientePage />
    </AppLayout>
  ),
});

type ColunaTom = "warning" | "primary" | "success";

const TOM: Record<ColunaTom, { head: string; card: string; ring: string; texto: string }> = {
  warning: {
    head: "bg-warning text-warning-foreground",
    card: "border-warning/40 bg-warning/10",
    ring: "bg-warning text-warning-foreground",
    texto: "text-warning",
  },
  primary: {
    head: "bg-primary text-primary-foreground",
    card: "border-primary/40 bg-primary/10",
    ring: "bg-primary text-primary-foreground",
    texto: "text-primary",
  },
  success: {
    head: "bg-success text-success-foreground",
    card: "border-success/40 bg-success/10",
    ring: "bg-success text-success-foreground",
    texto: "text-success",
  },
};

function Senha({ pedido }: { pedido: string }) {
  const digitos = pedido.replace(/\D/g, "");
  return digitos.slice(-4).padStart(4, "0");
}

function PedidoCard({ p, tom }: { p: Pedido; tom: ColunaTom }) {
  const t = TOM[tom];
  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-xl border-2 px-4 py-3 shadow-sm transition-transform duration-200 hover:scale-[1.01]",
        t.card,
      )}
    >
      <span
        className={cn(
          "grid min-w-[74px] place-items-center rounded-lg px-2 py-1.5 text-2xl font-black tabular-nums tracking-wider",
          t.ring,
        )}
      >
        <Senha pedido={p.pedido} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-lg font-bold uppercase leading-tight text-foreground">
          {p.razaoSocial}
        </div>
        <div className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
          🏬 Retira na Loja · {p.vendedor}
        </div>
      </div>
    </li>
  );
}

function Coluna({
  titulo,
  tom,
  pedidos,
  loading,
}: {
  titulo: string;
  tom: ColunaTom;
  pedidos: Pedido[];
  loading: boolean;
}) {
  const t = TOM[tom];
  return (
    <section className="panel flex min-h-[320px] flex-col overflow-hidden">
      <header className={cn("flex items-center justify-between px-4 py-3", t.head)}>
        <h2 className="text-base font-black uppercase tracking-wider">{titulo}</h2>
        <span className="rounded-full bg-black/15 px-2.5 py-0.5 text-sm font-bold tabular-nums">
          {num(pedidos.length)}
        </span>
      </header>
      <ul className="flex-1 space-y-2.5 overflow-y-auto p-3">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)
        ) : pedidos.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Fila vazia</p>
        ) : (
          pedidos.map((p) => <PedidoCard key={p.pedido} p={p} tom={tom} />)
        )}
      </ul>
    </section>
  );
}

function Relogio() {
  const [hora, setHora] = useState("--:--:--");
  useEffect(() => {
    const tick = () => setHora(new Date().toLocaleTimeString("pt-BR"));
    tick();
    const i = setInterval(tick, 1000);
    return () => clearInterval(i);
  }, []);
  return <span className="text-2xl font-black tabular-nums text-foreground">{hora}</span>;
}

function hojeISO(): string {
  const d = new Date();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mes}-${dia}`;
}

function PainelPedidosClientePage() {
  const { data, isLoading } = usePainelPedidos();

  // Só Retira na Loja, registrado HOJE dentro do expediente (08:00-18:00).
  const doTelao = (lista: Pedido[]) =>
    lista.filter(
      (p) =>
        p.logistica.tipo === "retira" &&
        p.registroISO === hojeISO() &&
        p.registroHora !== undefined &&
        p.registroHora >= HORA_INICIO &&
        p.registroHora < HORA_FIM,
    );

  // Ordenação pedida pelo usuário (2026-08-11): Conferência em FIFO (quem
  // espera há mais tempo primeiro); Faturamento e Saiu com o mais recente
  // primeiro. Chave = hora ("HH:MM", lexicográfica é segura); desempate pelo
  // nº do pedido (numérico).
  const nroPedido = (p: Pedido) => parseInt(p.pedido.replace(/\D/g, ""), 10) || 0;
  const ordena = (lista: Pedido[], hora: (p: Pedido) => string, asc: boolean) =>
    [...lista].sort((a, b) => {
      const cmp = hora(a).localeCompare(hora(b)) || nroPedido(a) - nroPedido(b);
      return asc ? cmp : -cmp;
    });

  const conferencia = ordena(
    doTelao(data?.aguardandoConferencia ?? []),
    (p) => p.registroHora ?? "",
    true, // mais antigo → mais recente
  );
  const faturamento = ordena(
    doTelao(data?.aguardandoFaturamento ?? []),
    (p) => p.registroHora ?? "",
    false, // mais recente → mais antigo
  );
  const saiu = ordena(
    doTelao(data?.saiuHoje ?? []),
    (p) => p.hora ?? "", // horário de conclusão
    false, // saiu por último primeiro
  );

  const secoesExcel = (): SecaoExcel[] => {
    if (!data) return [];
    return [
      secaoFiltros([
        ["Recorte", "Retira na Loja"],
        ["Registro", `Hoje, ${HORA_INICIO} às ${HORA_FIM}`],
      ]),
      { nome: "Aguardando Conferência", linhas: linhasExcelPedidos(conferencia) },
      { nome: "Aguardando Faturamento", linhas: linhasExcelPedidos(faturamento) },
      { nome: "Saiu Hoje", linhas: linhasExcelPedidos(saiu) },
    ];
  };

  return (
    <>
      <PageHeader
        title="Painel de Pedidos - Cliente"
        subtitle={`Retira na Loja · pedidos de hoje das ${HORA_INICIO} às ${HORA_FIM}`}
        excel={secoesExcel}
        right={
          <div className="flex items-center gap-4">
            <Relogio />
            <span className="flex items-center gap-2 rounded-full border border-destructive/40 bg-destructive/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-destructive">
              <span className="live-dot size-2 rounded-full bg-destructive" /> Ao vivo
            </span>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Coluna
          titulo="Aguardando Conferência"
          tom="warning"
          loading={isLoading}
          pedidos={conferencia}
        />
        <Coluna
          titulo="Aguardando Faturamento"
          tom="primary"
          loading={isLoading}
          pedidos={faturamento}
        />
        <Coluna titulo="✓ Saiu Hoje" tom="success" loading={isLoading} pedidos={saiu} />
      </div>
    </>
  );
}
