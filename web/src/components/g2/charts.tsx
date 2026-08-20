import type { ReactNode } from "react";

import type { DimensaoValor } from "@/lib/api/types";
import { brl, brlShort, num, pct } from "@/lib/format";

export const CHART = {
  blue: "var(--color-chart-1)",
  green: "var(--color-chart-2)",
  amber: "var(--color-chart-3)",
  red: "var(--color-chart-4)",
  purple: "var(--color-chart-5)",
  grid: "var(--color-border)",
  axis: "var(--color-muted-foreground)",
};

/** Realce de hover neutro, válido nos dois temas. */
export const CURSOR_FILL = "color-mix(in oklab, var(--color-foreground) 6%, transparent)";

export const PIE_COLORS = [CHART.blue, CHART.green, CHART.amber, CHART.red, CHART.purple];

export const axisProps = {
  stroke: CHART.axis,
  tick: { fill: CHART.axis, fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: CHART.grid },
};

export const moneyAxis = (v: number) => brlShort(v);

/** Tooltip analítico das fatias por marca / grupo. */
export function DimensionTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: { payload?: DimensaoValor }[];
}) {
  const d = payload?.[0]?.payload;
  if (!active || !d) return null;
  const linhas: [string, string][] = [
    ["Venda Líquida", brl(d.vendaLiquida)],
    ["Custo de Reposição", brl(d.custoReposicao)],
    ["Lucro Bruto", brl(d.lucroBruto)],
    ["Margem", pct(d.margem)],
    ["Quantidade", num(d.quantidade)],
  ];
  return (
    <div className="min-w-[230px] rounded-md border border-border bg-popover px-3 py-2 shadow-xl">
      <div className="mb-1.5 text-xs font-semibold text-foreground">{d.nome}</div>
      <div className="space-y-0.5">
        {linhas.map(([k, v]) => (
          <div key={k} className="flex items-center gap-4 text-xs">
            <span className="text-muted-foreground">{k}</span>
            <span className="ml-auto font-semibold tabular-nums text-foreground">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}


type TooltipEntry = { name?: string; value?: number | string; color?: string; dataKey?: string };

export function ChartTooltip({
  active,
  payload,
  label,
  labelPrefix = "",
  format = "brl",
  extra,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  labelPrefix?: string;
  format?: "brl" | "num" | "pct";
  extra?: ReactNode;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const fmt = (v: number) => (format === "brl" ? brl(v) : format === "pct" ? pct(v) : num(v));

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 shadow-xl">
      <div className="mb-1 text-xs font-medium text-foreground">
        {labelPrefix}
        {label}
      </div>
      <div className="space-y-0.5">
        {payload.map((p, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="size-2 rounded-full" style={{ background: p.color }} />
            <span className="text-muted-foreground">{p.name}</span>
            <span className="ml-auto font-semibold tabular-nums text-foreground">
              {typeof p.value === "number"
                ? p.dataKey === "aliquota" || p.dataKey === "taxa"
                  ? pct(p.value)
                  : fmt(p.value)
                : String(p.value ?? "")}
            </span>
          </div>
        ))}
      </div>
      {extra}
    </div>
  );
}
