import { useEffect, useRef, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  BarChart3,
  Boxes,
  ClipboardList,
  Layers,
  LayoutDashboard,
  LogOut,
  Moon,
  Percent,
  Settings,
  ShoppingCart,
  Sun,
  User,
  Users,
  Wallet,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/api/client";
import { logout, temAcesso } from "@/lib/auth";
import { useTheme } from "@/lib/theme";

const ITENS = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, aba: "dashboard" },
  { to: "/vendas", label: "Vendas", icon: BarChart3, aba: "vendas" },
  { to: "/estoque", label: "Estoque", icon: Boxes, aba: "estoque" },
  { to: "/financeiro", label: "Financeiro", icon: Wallet, aba: "financeiro" },
  { to: "/crm", label: "CRM", icon: ShoppingCart, aba: "crm" },
  { to: "/imposto", label: "Imposto", icon: Percent, aba: "imposto" },
  { to: "/cliente", label: "Cliente", icon: User, aba: "cliente" },
  { to: "/cliente-marca-produto", label: "Cliente × Marca × Produto", icon: Layers, aba: "cliente" },
  { to: "/clientes", label: "Clientes", icon: Users, aba: "clientes" },
  { to: "/painel-pedidos", label: "Painel Pedidos", icon: ClipboardList, aba: "painel_pedidos" },
  { to: "/painel-pedidos-cliente", label: "Painel Pedidos - Cliente", icon: ClipboardList, aba: "painel_pedidos" },
  { to: "/configuracoes", label: "Configurações", icon: Settings, aba: "configuracoes" },
] as const;

/** Formato de GET /status (api/server.py). */
interface BotInfo {
  status: string;
  ultimo_update: string;
  erro_msg?: string | null;
  segundos_para_o_proximo: number | null;
}

const BOT_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  vendas: "Vendas",
  estoque: "Estoque",
  financeiro: "Financeiro",
  crm: "CRM",
  imposto: "Imposto",
  clientes: "Clientes",
};

const STATUS_MS = 60_000;

function fmtTempo(s: number) {
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
}

/** Minutos desde um horário "HH:MM:SS" de hoje (tolera virada de dia). */
function minutosDesde(horario: string): number | null {
  const m = /^(\d{2}):(\d{2}):(\d{2})/.exec(horario);
  if (!m) return null;
  const agora = new Date();
  const upd = new Date(agora);
  upd.setHours(Number(m[1]), Number(m[2]), Number(m[3]), 0);
  let diff = agora.getTime() - upd.getTime();
  if (diff < 0) diff += 86_400_000;
  return Math.floor(diff / 60_000);
}

function textoBot(info: BotInfo, fetchAge: number): string {
  if (info.status === "executando") return "atualizando…";
  if (typeof info.segundos_para_o_proximo === "number") {
    const restante = Math.max(0, info.segundos_para_o_proximo - fetchAge);
    return restante === 0 ? "em breve" : fmtTempo(restante);
  }
  if (info.ultimo_update && info.ultimo_update !== "—") {
    const min = minutosDesde(info.ultimo_update);
    if (min !== null) return `há ${min}min`;
  }
  return "aguardando";
}

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { theme, toggle } = useTheme();
  const [bots, setBots] = useState<Record<string, BotInfo>>({});
  const [fetchAge, setFetchAge] = useState(0);
  const fetchTimeRef = useRef(Date.now());

  useEffect(() => {
    let ativo = true;
    const buscar = () => {
      apiFetch<{ bots: Record<string, BotInfo> }>("/status")
        .then((d) => {
          if (!ativo) return;
          setBots(d?.bots ?? {});
          fetchTimeRef.current = Date.now();
          setFetchAge(0);
        })
        .catch(() => {
          // mantém o último estado conhecido
        });
    };
    buscar();
    const pollId = setInterval(buscar, STATUS_MS);
    const tickId = setInterval(() => {
      if (ativo) setFetchAge(Math.floor((Date.now() - fetchTimeRef.current) / 1000));
    }, 1000);
    return () => {
      ativo = false;
      clearInterval(pollId);
      clearInterval(tickId);
    };
  }, []);

  const itensVisiveis = ITENS.filter((item) => temAcesso(item.aba));
  const entradasBots = Object.entries(bots);

  return (
    <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col self-start overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 border-b border-sidebar-border px-4 py-4">
        <div className="grid size-8 place-items-center rounded-md bg-sidebar-primary text-sm font-bold text-sidebar-primary-foreground">
          G2
        </div>
        <div>
          <div className="text-sm font-semibold leading-tight text-sidebar-foreground">G2 Analytics</div>
          <div className="text-[11px] text-sidebar-muted">Inteligência Comercial</div>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {itensVisiveis.map((item) => {
          const ativo = pathname === item.to;
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                ativo
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground shadow-[inset_2px_0_0_0_var(--color-sidebar-primary)]"
                  : "text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
              )}
            >
              <item.icon className={cn("size-4", ativo && "text-sidebar-primary")} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <div className="mb-2 flex items-center gap-2">
          <span className="live-dot size-2 rounded-full bg-success" />
          <span className="text-[10px] font-semibold uppercase tracking-wider text-sidebar-muted">
            Bots · próx. atualização
          </span>
        </div>
        <ul className="space-y-1">
          {entradasBots.length === 0 ? (
            <li className="text-[11px] text-sidebar-muted opacity-60">carregando…</li>
          ) : (
            entradasBots.map(([nome, info]) => (
              <li key={nome} className="flex justify-between text-[11px] text-sidebar-muted">
                <span>{BOT_LABELS[nome] ?? nome}</span>
                <span className="tabular-nums text-sidebar-foreground/80">{textoBot(info, fetchAge)}</span>
              </li>
            ))
          )}
        </ul>
        <button
          onClick={toggle}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-sidebar-border py-2 text-xs text-sidebar-muted transition-colors hover:border-sidebar-primary/60 hover:bg-sidebar-accent hover:text-sidebar-primary"
        >
          {theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
          {theme === "dark" ? "Tema claro" : "Tema escuro"}
        </button>
        <button
          onClick={() => logout()}
          className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-sidebar-border py-2 text-xs text-sidebar-muted transition-colors hover:border-destructive/60 hover:bg-destructive/10 hover:text-destructive"
        >
          <LogOut className="size-3.5" /> Sair
        </button>
      </div>
    </aside>
  );
}
