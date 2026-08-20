import { CheckCircle2, Target, TrendingUp } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { ProgressoVendedor } from "@/lib/api/types";
import { brl, pct } from "@/lib/format";

/** Faixa de atingimento — usada em cores, badges e no gráfico diário. */
export function statusMeta(percentual: number) {
  if (percentual >= 100)
    return { label: "Meta atingida", tone: "success" as const, color: "var(--color-chart-2)" };
  if (percentual >= 80)
    return { label: "Próximo da meta", tone: "warning" as const, color: "var(--color-chart-3)" };
  return { label: "Abaixo da meta", tone: "danger" as const, color: "var(--color-chart-4)" };
}

const barClass: Record<"success" | "warning" | "danger", string> = {
  success: "[&>div]:bg-success",
  warning: "[&>div]:bg-warning",
  danger: "[&>div]:bg-destructive",
};

const textClass: Record<"success" | "warning" | "danger", string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
};

export function MetaProgressRow({ item }: { item: ProgressoVendedor }) {
  const s = statusMeta(item.percentual);
  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-foreground">{item.vendedor}</span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            textClass[s.tone],
          )}
        >
          {s.tone === "success" ? (
            <CheckCircle2 className="size-3" />
          ) : (
            <TrendingUp className="size-3" />
          )}
          {s.label}
        </span>
        <span className={cn("ml-auto text-sm font-bold tabular-nums", textClass[s.tone])}>
          {pct(item.percentual)}
        </span>
      </div>
      <Progress
        value={Math.min(100, item.percentual)}
        className={cn("h-2.5 bg-muted", barClass[s.tone])}
      />
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Realizado <span className="font-medium text-foreground">{brl(item.realizado)}</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <Target className="size-3" />
          Meta <span className="font-medium text-foreground">{brl(item.meta)}</span>
        </span>
      </div>
    </div>
  );
}
