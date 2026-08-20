// Cliente HTTP da API real (FastAPI, porta 8765).
// Convenção: dentro de src/lib/api/** só imports RELATIVOS — este módulo
// precisa rodar standalone (smoke test com tsx), fora do bundler.

import { modoDemo, responderDemo } from "./demo";

const TOKEN_KEY = "g2:token";
const TABS_KEY = "g2:tabs";

/**
 * URL base da API. Usa VITE_API_URL quando definida; senão assume a porta
 * 8765 na MESMA máquina que serve o front (padrão do projeto).
 */
export function apiBase(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const configurada = env?.["VITE_API_URL"];
  if (configurada) return configurada.replace(/\/+$/, "");
  if (typeof window !== "undefined") {
    return `http://${window.location.hostname}:8765`;
  }
  return "http://localhost:8765";
}

/** Token de sessão salvo pelo login (null fora do browser ou sem login). */
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

/** Limpa token e abas do perfil (usado em logout e em 401). */
export function clearAuth(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(TABS_KEY);
}

async function extrairDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    const detail = body?.detail;
    if (typeof detail === "string" && detail) return detail;
    if (detail != null) return JSON.stringify(detail);
  } catch {
    // corpo não-JSON — cai na mensagem genérica
  }
  return `Erro ${res.status} na API`;
}

/**
 * fetch autenticado contra a API real.
 * - Injeta `Authorization: Bearer <token>` (localStorage `g2:token`).
 * - 401 → limpa a sessão e redireciona para a tela de login.
 * - !ok → lança Error com o `detail` do JSON de erro, se houver.
 */
export async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  // No site estático não existe API: a chamada é atendida pelo retrato local.
  // O desvio fica AQUI, num único ponto, para que hooks, adaptadores e telas
  // não saibam da diferença — é a mesma razão pela qual a camada de dados é
  // isolada em adaptadores.
  if (modoDemo()) {
    if (init?.method === "POST") return { ok: true } as T;
    return responderDemo<T>(path);
  }

  const headers = new Headers(init?.headers);
  const token = getToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(`${apiBase()}${path}`, { ...init, headers });

  if (res.status === 401) {
    clearAuth();
    if (typeof window !== "undefined") {
      window.location.href = "/";
    }
    throw new Error("Sessão expirada — faça login novamente");
  }
  if (!res.ok) {
    throw new Error(await extrairDetail(res));
  }
  return (await res.json()) as T;
}

/** POST JSON autenticado (mesmo contrato de erros do apiFetch). */
export async function postJson<T = any>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
