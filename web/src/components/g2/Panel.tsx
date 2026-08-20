import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ExpandDialog, extractChartData } from "@/components/g2/ExpandView";

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
  loading,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  loading?: boolean;
}) {
  const chartData = extractChartData(children);

  return (
    <section className={cn("panel flex flex-col", className)}>
      {(title || actions || chartData.length > 0) && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            {chartData.length > 0 ? (
              <ExpandDialog title={title ?? "Gráfico"} rows={chartData}>
                <div className="h-full min-h-[420px]">{children}</div>
              </ExpandDialog>
            ) : null}
            <div>
              {title ? <h2 className="text-sm font-semibold text-foreground">{title}</h2> : null}
              {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
            </div>
          </div>
          {actions}
        </header>
      )}
      <div className={cn("flex-1 p-4", bodyClassName)}>
        {loading ? <Skeleton className="h-full min-h-[220px] w-full" /> : children}
      </div>
    </section>
  );
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mt-2 flex items-baseline gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground">{children}</h2>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}
