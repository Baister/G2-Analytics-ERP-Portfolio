import { Check, CalendarRange, ChevronsUpDown, Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { Periodo } from "@/lib/api/types";

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * Filtro multi-seleção com busca. Selecionar um item NÃO substitui os anteriores.
 */
export function MultiSelect({
  label,
  values,
  onChange,
  options,
  allLabel,
  className,
  width = "w-[220px]",
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  options: FilterOption[];
  allLabel: string;
  className?: string;
  width?: string;
}) {
  const toggle = (v: string) =>
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);

  const resumo =
    values.length === 0
      ? allLabel
      : values.length === 1
        ? values[0]
        : `${values.length} selecionados`;

  return (
    <div className={className}>
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </label>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            className={cn("h-9 justify-between bg-surface text-sm font-normal", width)}
          >
            <span className={cn("truncate", values.length === 0 && "text-muted-foreground")}>
              {resumo}
            </span>
            <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[260px] p-0" align="start">
          <Command>
            <CommandInput placeholder={`Pesquisar ${label.toLowerCase()}...`} />
            <CommandList>
              <CommandEmpty>Nenhum resultado.</CommandEmpty>
              <CommandGroup>
                {options.map((o) => {
                  const sel = values.includes(o.value);
                  return (
                    <CommandItem key={o.value} value={o.label} onSelect={() => toggle(o.value)}>
                      <div
                        className={cn(
                          "mr-2 flex size-4 items-center justify-center rounded-[4px] border",
                          sel ? "border-primary bg-primary text-primary-foreground" : "border-input",
                        )}
                      >
                        {sel ? <Check className="size-3" /> : null}
                      </div>
                      <span className="truncate">{o.label}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
          {values.length > 0 ? (
            <div className="border-t p-1">
              <button
                onClick={() => onChange([])}
                className="w-full rounded-sm px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Limpar seleção
              </button>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Filtro de período com data inicial, data final e atalho "Mês Atual".
 * Com `onBuscar`, as datas só são APLICADAS ao clicar na lupa (o pai mantém
 * rascunho × aplicado) — para consultas caras não dispararem a cada tecla. */
export function PeriodFilter({
  periodo,
  onChange,
  mesAtual,
  onBuscar,
  className,
}: {
  periodo: Periodo;
  onChange: (p: Periodo) => void;
  /** Período correspondente ao mês vigente (vem da camada de dados). */
  mesAtual: Periodo;
  /** Presente → renderiza a lupa que confirma/aplica o período. */
  onBuscar?: () => void;
  className?: string;
}) {
  const isMesAtual = periodo.inicio === mesAtual.inicio && periodo.fim === mesAtual.fim;
  return (
    <div className={cn("flex flex-wrap items-end gap-3", className)}>
      <div>
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Data inicial
        </label>
        <Input
          type="date"
          value={periodo.inicio}
          max={periodo.fim}
          onChange={(e) => onChange({ ...periodo, inicio: e.target.value })}
          className="h-9 w-[160px] bg-surface text-sm"
        />
      </div>
      <div>
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Data final
        </label>
        <Input
          type="date"
          value={periodo.fim}
          min={periodo.inicio}
          onChange={(e) => onChange({ ...periodo, fim: e.target.value })}
          className="h-9 w-[160px] bg-surface text-sm"
        />
      </div>
      {onBuscar ? (
        <Button
          variant="default"
          className="h-9 gap-2"
          aria-label="Aplicar período"
          title="Aplicar o período selecionado"
          onClick={onBuscar}
        >
          <Search className="size-4" />
          Buscar
        </Button>
      ) : null}
      <Button
        variant={isMesAtual ? "default" : "outline"}
        className="h-9 gap-2"
        onClick={() => onChange(mesAtual)}
      >
        <CalendarRange className="size-4" />
        Mês Atual
      </Button>
    </div>
  );
}

export interface Chip {
  key: string;
  label: string;
}

export function FilterChips({
  chips,
  onRemove,
  onClear,
}: {
  chips: Chip[];
  onRemove: (key: string) => void;
  onClear?: () => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">Filtros ativos:</span>
      {chips.map((c) => (
        <Badge
          key={c.key}
          variant="outline"
          className="cursor-pointer gap-1 border-primary/60 bg-primary/10 text-foreground hover:bg-primary/20"
          onClick={() => onRemove(c.key)}
        >
          {c.label}
          <X className="size-3" />
        </Badge>
      ))}
      {onClear ? (
        <button
          onClick={onClear}
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          limpar tudo
        </button>
      ) : null}
    </div>
  );
}
