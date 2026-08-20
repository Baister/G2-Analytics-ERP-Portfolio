import { Children, isValidElement, useMemo, type ReactElement, type ReactNode } from "react";
import { Maximize2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export type SheetRow = Record<string, unknown>;

const COL_LETTERS = (i: number) => {
  let s = "";
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
};

const fmtCell = (v: unknown) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number")
    return Number.isInteger(v)
      ? v.toLocaleString("pt-BR")
      : v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (typeof v === "boolean") return v ? "Sim" : "Não";
  if (typeof v === "string") return v;
  return "";
};

/** Grade estilo Excel com cabeçalhos de linha/coluna. */
export function SpreadsheetGrid({
  rows,
  headers,
  className,
}: {
  rows: SheetRow[];
  headers?: string[] | undefined;
  className?: string | undefined;
}) {
  const cols = useMemo(() => {
    if (headers?.length) return headers;
    const set = new Set<string>();
    rows.forEach((r) =>
      Object.entries(r).forEach(([k, v]) => {
        if (v === null || ["number", "string", "boolean", "undefined"].includes(typeof v)) set.add(k);
      }),
    );
    return [...set];
  }, [rows, headers]);

  if (!rows.length || !cols.length)
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Sem dados para exibir.
      </div>
    );

  return (
    <div className={cn("h-full overflow-auto rounded-md border border-border", className)}>
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10">
          <tr className="bg-surface">
            <th className="w-10 border border-border bg-muted px-2 py-1 text-[10px] font-semibold text-muted-foreground" />
            {cols.map((c, i) => (
              <th
                key={c}
                className="border border-border bg-muted px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                <span className="mr-1 opacity-60">{COL_LETTERS(i)}</span>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="hover:bg-accent/40">
              <td className="border border-border bg-muted px-2 py-1 text-center text-[10px] text-muted-foreground">
                {ri + 1}
              </td>
              {cols.map((c) => {
                const v = r[c];
                return (
                  <td
                    key={c}
                    className={cn(
                      "whitespace-nowrap border border-border px-2 py-1 text-foreground",
                      typeof v === "number" && "text-right tabular-nums",
                    )}
                  >
                    {fmtCell(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Botão + modal de visualização ampliada com planilha ao lado. */
export function ExpandDialog({
  title,
  children,
  rows,
  headers,
  className,
}: {
  title: string;
  children: ReactNode;
  rows: SheetRow[];
  headers?: string[] | undefined;
  className?: string | undefined;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="Expandir"
          aria-label={`Expandir ${title}`}
          className={cn("size-7 shrink-0 text-muted-foreground hover:text-foreground", className)}
        >
          <Maximize2 className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="flex h-[90vh] max-w-[95vw] flex-col gap-3 sm:max-w-[95vw]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="min-h-0 overflow-auto rounded-md border border-border p-4">{children}</div>
          <div className="min-h-0">
            <SpreadsheetGrid rows={rows} headers={headers} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Extrai o array de dados de gráficos Recharts declarados nos filhos. */
export function extractChartData(node: ReactNode): SheetRow[] {
  let found: SheetRow[] | null = null;
  const walk = (n: ReactNode) => {
    if (found) return;
    Children.forEach(n, (child) => {
      if (found || !isValidElement(child)) return;
      const props = (child as ReactElement<Record<string, unknown>>).props ?? {};
      const data = props["data"];
      if (Array.isArray(data) && data.length && typeof data[0] === "object" && data[0] !== null) {
        found = data as SheetRow[];
        return;
      }
      walk(props["children"] as ReactNode);
    });
  };
  walk(node);
  return found ?? [];
}
