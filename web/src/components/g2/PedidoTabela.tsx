// Tabela de pedidos do telão — compartilhada entre "Painel de Pedidos" e
// "Painel de Pedidos - Cliente" (movida de routes/painel-pedidos.tsx sem
// mudança de comportamento).
import type { Pedido } from "@/lib/api/types";
import { brl, dt } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function filaBadge(horas: number) {
  if (horas < 24) return { cls: "bg-success text-success-foreground", txt: `${Math.round(horas)}h na fila` };
  if (horas < 72)
    return {
      cls: "bg-warning text-warning-foreground",
      txt: `${Math.floor(horas / 24)}d na fila`,
    };
  return {
    cls: "bg-destructive text-destructive-foreground",
    txt: `${Math.floor(horas / 24)}d na fila`,
  };
}

/**
 * Linhas de exportação Excel de uma fila de pedidos — espelha as colunas da
 * tabela do telão, com valores CRUS (números como number; NF/Hora vazios
 * viram célula em branco).
 */
export function linhasExcelPedidos(pedidos: Pedido[]): Record<string, unknown>[] {
  return pedidos.map((p) => ({
    Pedido: p.pedido,
    "Razão Social": p.razaoSocial,
    Vendedor: p.vendedor,
    Emissão: dt(p.emissao),
    Entrega: dt(p.entrega),
    Logística: p.logistica.tipo === "retira" ? "Retira na Loja" : p.logistica.nome,
    NF: p.nf ?? null,
    Hora: p.hora ?? null,
    Valor: p.valor,
    "Horas na Fila": p.horasFila,
  }));
}

export function PedidoTabela({ pedidos, saiu }: { pedidos: Pedido[]; saiu?: boolean | undefined }) {
  if (pedidos.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Nenhum pedido nesta fila.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="bg-surface">
            {[
              "Pedido",
              "Razão Social",
              "Vendedor",
              "Emissão",
              "Entrega",
              "Logística",
              ...(saiu ? ["NF", "Hora"] : []),
              "Valor",
              saiu ? "Status" : "Fila",
            ].map((h) => (
              <th
                key={h}
                className="whitespace-nowrap border-b border-border px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pedidos.map((p) => {
            const fila = filaBadge(p.horasFila);
            return (
              <tr key={p.pedido} className="border-b border-border/60 last:border-0 hover:bg-accent/50">
                <td className="px-3 py-2.5 tabular-nums">{p.pedido}</td>
                <td className="px-3 py-2.5 text-base font-semibold text-foreground">{p.razaoSocial}</td>
                <td className="px-3 py-2.5 text-muted-foreground">{p.vendedor}</td>
                <td className="px-3 py-2.5 tabular-nums">{dt(p.emissao)}</td>
                <td
                  className={cn(
                    "px-3 py-2.5 tabular-nums",
                    p.entregaVencida && "font-semibold text-destructive",
                  )}
                >
                  {dt(p.entrega)}
                </td>
                <td className="px-3 py-2.5">
                  <Badge
                    className={
                      p.logistica.tipo === "retira"
                        ? "bg-purple/20 text-purple"
                        : "bg-primary/20 text-primary"
                    }
                  >
                    {p.logistica.tipo === "retira" ? "🏬 Retira na Loja" : `🚚 ${p.logistica.nome}`}
                  </Badge>
                </td>
                {saiu ? (
                  <>
                    <td className="px-3 py-2.5 tabular-nums">{p.nf ?? "—"}</td>
                    <td className="px-3 py-2.5 tabular-nums">{p.hora ?? "—"}</td>
                  </>
                ) : null}
                <td className="px-3 py-2.5 text-right font-semibold tabular-nums">{brl(p.valor)}</td>
                <td className="px-3 py-2.5">
                  {saiu ? (
                    <Badge className="bg-success text-success-foreground">✓ Expedido</Badge>
                  ) : (
                    <Badge className={fila.cls}>{fila.txt}</Badge>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
