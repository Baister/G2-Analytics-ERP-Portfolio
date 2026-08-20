import { useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, ChevronsUpDown, ChevronDown, ChevronUp, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ExpandDialog, type SheetRow } from "@/components/g2/ExpandView";

export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right" | "center";
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => number | string;
}

export function DataTable<T>({
  rows,
  columns,
  search,
  searchPlaceholder = "Buscar...",
  searchFields,
  pageSize,
  loading,
  empty = "Nenhum registro encontrado.",
  onRowClick,
  dense,
  toolbar,
  title = "Tabela",
  nested,
}: {
  rows: T[];
  columns: Column<T>[];
  search?: boolean;
  searchPlaceholder?: string;
  searchFields?: (row: T) => string;
  pageSize?: number;
  loading?: boolean;
  empty?: string;
  onRowClick?: (row: T) => void;
  dense?: boolean;
  toolbar?: ReactNode;
  title?: string;
  nested?: boolean;
}) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ key: string; dir: "desc" | "asc" } | null>(null);

  const filtered = useMemo(() => {
    if (!q.trim() || !searchFields) return rows;
    const t = q.trim().toLowerCase();
    return rows.filter((r) => searchFields(r).toLowerCase().includes(t));
  }, [rows, q, searchFields]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return filtered;
    const getVal = (row: T): number | string => {
      if (col.sortValue) return col.sortValue(row);
      const raw = (row as Record<string, unknown>)[col.key];
      if (typeof raw === "number" || typeof raw === "string") return raw;
      const node = col.render(row);
      return typeof node === "number" || typeof node === "string" ? node : "";
    };
    const factor = sort.dir === "desc" ? -1 : 1;
    return [...filtered].sort((a, b) => {
      const av = getVal(a);
      const bv = getVal(b);
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * factor;
      return String(av).localeCompare(String(bv), "pt-BR", { numeric: true }) * factor;
    });
  }, [filtered, sort, columns]);

  const size = pageSize ?? (sorted.length || 1);
  const pages = Math.max(1, Math.ceil(sorted.length / size));
  const current = Math.min(page, pages - 1);
  const visible = pageSize ? sorted.slice(current * size, current * size + size) : sorted;

  const toggleSort = (key: string) => {
    setPage(0);
    setSort((s) =>
      !s || s.key !== key ? { key, dir: "desc" } : s.dir === "desc" ? { key, dir: "asc" } : null,
    );
  };

  const sheetRows: SheetRow[] = useMemo(
    () =>
      sorted.map((row) => {
        const o: SheetRow = {};
        columns.forEach((c) => {
          if (c.sortValue) o[c.header] = c.sortValue(row);
          else {
            const raw = (row as Record<string, unknown>)[c.key];
            if (typeof raw === "number" || typeof raw === "string") o[c.header] = raw;
            else {
              const node = c.render(row);
              o[c.header] = typeof node === "number" || typeof node === "string" ? node : "";
            }
          }
        });
        return o;
      }),
    [sorted, columns],
  );

  if (loading) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="flex flex-col gap-3">
      {(search || toolbar || !nested) && (
        <div className="flex flex-wrap items-center gap-2">
          {!nested ? (
            <ExpandDialog title={title} rows={sheetRows} headers={columns.map((c) => c.header)}>
              <DataTable
                rows={sorted}
                columns={columns}
                dense={dense ?? false}
                nested
                {...(onRowClick ? { onRowClick } : {})}
              />
            </ExpandDialog>
          ) : null}
          {search ? (
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(0);
                }}
                placeholder={searchPlaceholder}
                className="h-9 bg-surface pl-8 text-sm"
              />
            </div>
          ) : null}
          {toolbar}
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-surface">
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    "whitespace-nowrap border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
                    c.align === "right" && "text-right",
                    c.align === "center" && "text-center",
                    (!c.align || c.align === "left") && "text-left",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(c.key)}
                    title="Ordenar"
                    className={cn(
                      "group inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-foreground",
                      c.align === "right" && "flex-row-reverse",
                      sort?.key === c.key && "text-foreground",
                    )}
                  >
                    {c.header}
                    {sort?.key === c.key ? (
                      sort.dir === "desc" ? (
                        <ChevronDown className="size-3.5" />
                      ) : (
                        <ChevronUp className="size-3.5" />
                      )
                    ) : (
                      <ChevronsUpDown className="size-3.5 opacity-0 transition-opacity group-hover:opacity-60" />
                    )}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-muted-foreground">
                  {empty}
                </td>
              </tr>
            ) : (
              visible.map((row, i) => (
                <tr
                  key={i}
                  onClick={() => onRowClick?.(row)}
                  className={cn(
                    "border-b border-border/60 transition-colors last:border-0 hover:bg-accent/50",
                    onRowClick && "cursor-pointer",
                  )}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn(
                        "px-3 tabular-nums",
                        dense ? "py-1.5" : "py-2.5",
                        c.align === "right" && "text-right",
                        c.align === "center" && "text-center",
                      )}
                    >
                      {c.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pageSize && filtered.length > size ? (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {current * size + 1}–{Math.min(filtered.length, (current + 1) * size)} de{" "}
            {filtered.length}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <span>
              {current + 1} / {pages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
