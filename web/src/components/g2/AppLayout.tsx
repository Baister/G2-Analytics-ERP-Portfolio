import type { ReactNode } from "react";
import { useEffect } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";

import { AppSidebar } from "./AppSidebar";
import { abaDaRota, primeiraRotaPermitida, temAcesso, useAuthGate } from "@/lib/auth";

export function AppLayout({ children }: { children: ReactNode }) {
  const { ready, authed } = useAuthGate();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const aba = abaDaRota(pathname);

  useEffect(() => {
    if (!ready) return;
    if (!authed) {
      navigate({ to: "/" });
      return;
    }
    // Rota fora do perfil → manda para a primeira aba permitida.
    if (aba && !temAcesso(aba)) navigate({ to: primeiraRotaPermitida() });
  }, [ready, authed, aba, navigate]);

  const liberado = ready && authed && (!aba || temAcesso(aba));
  if (!liberado) {
    return <div className="min-h-screen bg-background" />;
  }

  return (
    <div className="flex min-h-screen w-full bg-background">
      <AppSidebar />
      <main className="flex-1 overflow-x-hidden">
        {/* id estável usado pelas exportações (PDF/Imagem/Excel) — não remover. */}
        <div id="conteudo-pagina" className="mx-auto flex max-w-[1600px] flex-col gap-5 p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
