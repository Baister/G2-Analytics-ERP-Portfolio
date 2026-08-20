import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BarChart3, Loader2, Lock } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { login, primeiraRotaPermitida } from "@/lib/auth";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "G2 Analytics — Inteligência Comercial" },
      {
        name: "description",
        content:
          "Painel analítico comercial da distribuidora: vendas, estoque, financeiro, CRM e impostos em tempo real.",
      },
      { property: "og:title", content: "G2 Analytics — Inteligência Comercial" },
      {
        property: "og:description",
        content: "Acesse o painel analítico comercial G2 Analytics.",
      },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(false);

  const entrar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (carregando) return;
    setErro("");
    setCarregando(true);
    try {
      const tabs = await login(senha);
      navigate({ to: primeiraRotaPermitida(tabs) });
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Falha ao autenticar");
      setCarregando(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      <div className="pointer-events-none absolute -left-32 -top-32 size-[420px] rounded-full bg-primary/20 blur-[140px]" />
      <div className="pointer-events-none absolute -bottom-40 -right-24 size-[420px] rounded-full bg-purple/15 blur-[150px]" />

      <div className="panel relative w-full max-w-sm p-8">
        <div className="flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-lg bg-primary text-lg font-bold text-primary-foreground">
            G2
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">G2 Analytics</h1>
            <p className="text-xs text-muted-foreground">Inteligência comercial da distribuidora</p>
          </div>
        </div>

        <p className="mt-6 border-l-2 border-primary pl-3 text-sm italic text-muted-foreground">
          “Dados não mentem. Bem-vindo ao lugar onde cada decisão tem um número por trás.”
        </p>

        <form onSubmit={entrar} className="mt-6 space-y-3">
          <div>
            <label className="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground">
              Senha de acesso
            </label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="password"
                value={senha}
                onChange={(e) => {
                  setSenha(e.target.value);
                  setErro("");
                }}
                placeholder="••••••••"
                className="h-11 bg-surface pl-9"
                autoFocus
              />
            </div>
            {erro ? <p className="mt-1.5 text-xs text-destructive">{erro}</p> : null}
          </div>

          <Button
            type="submit"
            disabled={carregando}
            className="h-11 w-full text-sm font-semibold"
          >
            {carregando ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Entrando…
              </>
            ) : (
              <>
                <BarChart3 className="size-4" /> Entrar
              </>
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
