import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Save } from "lucide-react";
import { toast } from "sonner";

import { AppLayout } from "@/components/g2/AppLayout";
import { PageHeader } from "@/components/g2/PageHeader";
import { Panel } from "@/components/g2/Panel";
import { useMetas } from "@/lib/api/hooks";
import type { MetasConfig } from "@/lib/api/types";
import { brl } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/configuracoes")({
  head: () => ({
    meta: [
      { title: "Configurações de Metas | G2 Analytics" },
      {
        name: "description",
        content: "Defina a meta mensal da empresa e as metas individuais por vendedor.",
      },
      { property: "og:title", content: "Configurações de Metas | G2 Analytics" },
      {
        property: "og:description",
        content: "As metas alimentam os painéis de Dashboard, Vendas e CRM.",
      },
    ],
  }),
  component: () => (
    <AppLayout>
      <ConfiguracoesPage />
    </AppLayout>
  ),
});

/** Converte "1.500.000,00" -> 1500000 */
function parseBRL(s: string) {
  const limpo = s.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  const n = Number(limpo);
  return Number.isFinite(n) ? n : 0;
}

function fmtInput(v: number) {
  return new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    v,
  );
}

function ConfiguracoesPage() {
  const { data, isLoading, error, salvar } = useMetas();
  const [empresa, setEmpresa] = useState("");
  const [vendedores, setVendedores] = useState<MetasConfig["metasVendedores"]>([]);
  const [salvoEmpresa, setSalvoEmpresa] = useState(false);
  const [salvoVend, setSalvoVend] = useState(false);

  useEffect(() => {
    if (!isLoading && data) {
      setEmpresa(fmtInput(data.metaEmpresa));
      setVendedores(data.metasVendedores);
    }
  }, [isLoading, data]);

  // salvar() é otimista (POST assíncrono); falha aparece via `error` do hook —
  // o refetch do próprio hook já ressincroniza os valores exibidos.
  useEffect(() => {
    if (error) toast.error(`Não foi possível salvar: ${error.message}`);
  }, [error]);

  const somaVendedores = vendedores.reduce((a, v) => a + v.meta, 0);

  const salvarEmpresa = () => {
    salvar({ ...data, metaEmpresa: parseBRL(empresa) });
    setSalvoEmpresa(true);
    toast.success("Meta mensal da empresa salva");
    setTimeout(() => setSalvoEmpresa(false), 2500);
  };

  const salvarVendedores = () => {
    salvar({ ...data, metasVendedores: vendedores });
    setSalvoVend(true);
    toast.success("Metas individuais salvas");
    setTimeout(() => setSalvoVend(false), 2500);
  };

  if (isLoading) return <Skeleton className="h-96 w-full" />;

  return (
    <>
      <PageHeader title="Configurações" subtitle="Metas comerciais do período" />

      <div className="rounded-md border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-foreground">
        As metas definidas aqui alimentam os indicadores das abas{" "}
        <strong>Dashboard</strong>, <strong>Vendas</strong> e <strong>CRM</strong>.
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[380px_1fr]">
        <Panel title="Meta Mensal da Empresa" subtitle="Valor em reais (formato brasileiro)">
          <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Meta do mês
          </label>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-sm text-muted-foreground">R$</span>
            <Input
              value={empresa}
              onChange={(e) => setEmpresa(e.target.value)}
              onBlur={() => setEmpresa(fmtInput(parseBRL(empresa)))}
              className="h-10 bg-surface text-right tabular-nums"
              inputMode="decimal"
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Equivale a {brl(parseBRL(empresa))}
          </p>
          <Button className="mt-4 w-full" onClick={salvarEmpresa}>
            {salvoEmpresa ? <Check className="size-4" /> : <Save className="size-4" />}
            {salvoEmpresa ? "Meta salva" : "Salvar meta da empresa"}
          </Button>
        </Panel>

        <Panel
          title="Metas Individuais por Vendedor"
          subtitle={`Soma das metas: ${brl(somaVendedores)}`}
          actions={
            <Button size="sm" onClick={salvarVendedores}>
              {salvoVend ? <Check className="size-4" /> : <Save className="size-4" />}
              {salvoVend ? "Salvo" : "Salvar todas"}
            </Button>
          }
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {vendedores.map((v, i) => (
              <div
                key={v.vendedor}
                className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2"
              >
                <span className="flex-1 truncate text-sm text-foreground">{v.vendedor}</span>
                <span className="text-xs text-muted-foreground">R$</span>
                <Input
                  value={fmtInput(v.meta)}
                  onChange={(e) => {
                    const meta = parseBRL(e.target.value);
                    setVendedores((prev) =>
                      prev.map((x, idx) => (idx === i ? { ...x, meta } : x)),
                    );
                  }}
                  className="h-8 w-36 bg-background text-right tabular-nums"
                  inputMode="decimal"
                />
              </div>
            ))}
          </div>
          {salvoVend ? (
            <p className="mt-3 flex items-center gap-2 text-xs text-success">
              <Check className="size-3.5" /> Metas atualizadas com sucesso.
            </p>
          ) : null}
        </Panel>
      </div>
    </>
  );
}
