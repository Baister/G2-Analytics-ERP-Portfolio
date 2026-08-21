// Autenticação real contra a API (POST /auth) com perfis de acesso por aba.
// Sessão: localStorage `g2:token` (Bearer, TTL 8h no servidor) + `g2:tabs`
// (abas permitidas do perfil; "*" = todas).

import { useEffect, useState } from "react";

import { apiBase, clearAuth } from "./api/client";
import { autenticarDemo, modoDemo } from "./api/demo";

const TOKEN_KEY = "g2:token";
const TABS_KEY = "g2:tabs";

interface AuthResponse {
  access_token: string;
  token_type: string;
  tabs: string[];
}

/** Ordem canônica das telas: rota do front → aba exigida pelo perfil. */
export const ROTA_ABA = [
  { rota: "/dashboard", aba: "dashboard" },
  { rota: "/vendas", aba: "vendas" },
  { rota: "/estoque", aba: "estoque" },
  { rota: "/financeiro", aba: "financeiro" },
  { rota: "/crm", aba: "crm" },
  { rota: "/imposto", aba: "imposto" },
  { rota: "/cliente", aba: "cliente" },
  { rota: "/cliente-marca-produto", aba: "cliente" },
  { rota: "/clientes", aba: "clientes" },
  { rota: "/painel-pedidos", aba: "painel_pedidos" },
  { rota: "/painel-pedidos-cliente", aba: "painel_pedidos" },
  { rota: "/configuracoes", aba: "configuracoes" },
] as const;

export type RotaApp = (typeof ROTA_ABA)[number]["rota"];

export function isAuthed(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.localStorage.getItem(TOKEN_KEY));
}

/**
 * Autentica na API real e guarda token + abas do perfil.
 * @returns abas permitidas ("*" = todas)
 * @throws Error("Senha incorreta") em 400; Error descritiva nos demais casos.
 */
export async function login(senha: string): Promise<string[]> {
  // Site estático: não há servidor para validar a senha. Qualquer entrada
  // libera todas as abas — o controle de acesso por perfil é demonstrado de
  // verdade ao rodar o projeto completo, com a API no ar.
  if (modoDemo()) {
    const { access_token, tabs } = autenticarDemo();
    localStorage.setItem("g2:token", access_token);
    localStorage.setItem("g2:tabs", JSON.stringify(tabs));
    return tabs;
  }

  let res: Response;
  try {
    res = await fetch(`${apiBase()}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: senha }),
    });
  } catch {
    throw new Error("Não foi possível conectar ao servidor");
  }

  if (res.status === 400) throw new Error("Senha incorreta");
  if (!res.ok) {
    let detail = `Erro ${res.status} ao autenticar`;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body?.detail === "string" && body.detail) detail = body.detail;
    } catch {
      // corpo não-JSON — mantém a mensagem genérica
    }
    throw new Error(detail);
  }

  const data = (await res.json()) as AuthResponse;
  const tabs = Array.isArray(data.tabs) ? data.tabs : [];
  window.localStorage.setItem(TOKEN_KEY, data.access_token);
  window.localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
  return tabs;
}

/** Encerra a sessão e volta para a tela de login. */
export function logout(): void {
  if (typeof window === "undefined") return;
  clearAuth();
  window.location.href = "/";
}

/** Abas permitidas do perfil logado ([] fora do browser ou sem login). */
export function getTabs(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(TABS_KEY);
    const tabs = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(tabs) ? (tabs as string[]) : [];
  } catch {
    return [];
  }
}

/** O perfil logado pode ver esta aba? ("*" nas tabs libera tudo) */
export function temAcesso(aba: string): boolean {
  const tabs = getTabs();
  return tabs.includes("*") || tabs.includes(aba);
}

/** Aba canônica exigida por uma rota do front (null = rota sem gating). */
export function abaDaRota(rota: string): string | null {
  const item = ROTA_ABA.find((r) => r.rota === rota);
  return item ? item.aba : null;
}

/** Primeira rota permitida na ordem canônica ("/" se nenhuma). */
export function primeiraRotaPermitida(tabs?: string[]): RotaApp | "/" {
  const t = tabs ?? getTabs();
  const item = ROTA_ABA.find((r) => t.includes("*") || t.includes(r.aba));
  return item ? item.rota : "/";
}

/** Guarda de autenticação usada pelo AppLayout (client-only). */
export function useAuthGate() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  useEffect(() => {
    setAuthed(isAuthed());
    setReady(true);
  }, []);
  return { ready, authed };
}
