import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { brl, num, pct } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";

export type Tone = "primary" | "success" | "danger" | "warning" | "purple" | "neutral";

const toneText: Record<Tone, string> = {
  primary: "text-primary",
  success: "text-success",
  danger: "text-destructive",
  warning: "text-warning",
  purple: "text-purple",
  neutral: "text-muted-foreground",
};

export function formatValue(
  value: number | string,
  format: "brl" | "num" | "pct" | "text" | "int",
) {
  if (format === "text") return String(value);
  const v = Number(value);
  if (format === "brl") return brl(v);
  if (format === "pct") return pct(v);
  if (format === "int") return num(v, 0);
  return num(v, 0);
}

interface KpiCardProps {
  label: string;
  value: number | string;
  format?: "brl" | "num" | "pct" | "text" | "int";
  hint?: string;
  tone?: Tone;
  icon?: ReactNode;
  loading?: boolean;
  className?: string;
}

export function KpiCard({
  label,
  value,
  format = "num",
  hint,
  tone = "primary",
  icon,
  loading,
  className,
}: KpiCardProps) {
  if (loading) {
    return (
      <div className="panel p-4">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-3 h-7 w-32" />
        <Skeleton className="mt-2 h-3 w-16" />
      </div>
    );
  }

  // Cor dinâmica do valor: negativo sempre alerta; caso contrário segue o tom do card.
  const numeric = typeof value === "number" ? value : Number(value);
  const valueTone =
    Number.isFinite(numeric) && numeric < 0 ? toneText.danger : toneText[tone];

  return (
    <div className={cn("panel kpi-top p-4 transition-colors hover:border-primary/50", toneText[tone], className)}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {icon ? <span className="opacity-70">{icon}</span> : null}
      </div>
      <div className={cn("mt-2 text-[22px] font-semibold leading-tight tabular-nums", valueTone)}>
        {formatValue(value, format)}
      </div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function KpiGrid({ children, cols = 4 }: { children: ReactNode; cols?: number }) {
  const map: Record<number, string> = {
    3: "sm:grid-cols-2 lg:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
    5: "sm:grid-cols-2 lg:grid-cols-5",
    6: "sm:grid-cols-3 lg:grid-cols-6",
  };
  return <div className={cn("grid grid-cols-1 gap-3", map[cols] ?? map[4])}>{children}</div>;
}
