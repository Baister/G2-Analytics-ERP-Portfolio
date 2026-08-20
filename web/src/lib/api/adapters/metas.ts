// Adaptador Metas — converte GET /metas no contrato MetasConfig da tela de
// Configurações e monta o corpo EXATO do POST /metas.
//
// Fonte: hub/server.py — GET /metas devolve
//   { meta_mensal_total: float, metas_individuais: {nome: meta}, ultima_atualizacao }
// e o POST valida com o modelo Pydantic MetasPayload:
//   { meta_mensal_total: float, metas_individuais: dict[str, float] }
// (campo é meta_mensal_total — "meta_mensal" seria rejeitado com 422).
//
// Regras:
//   - nomes de vendedor sempre .trim() (banco traz espaços à direita); match
//     entre roster e metas salvas é por nome trim + lowercase.
//   - nomesVendedores (opcional) = roster atual: garante uma linha por vendedor
//     mesmo sem meta salva (meta 0), na ordem do roster.
//   - metas salvas de vendedores FORA do roster são preservadas no fim da lista
//     (ordem alfabética) — assim um novo POST não apaga metas históricas.

import type { MetasConfig } from "../types";
import { clean, num } from "./shared";

// Payload cru do GET /metas — shape validado contra o server, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export function adaptMetas(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  nomesVendedores?: string[],
): MetasConfig {
  const d: Row = raw ?? {};

  // Metas salvas — chave normalizada (trim + lowercase), nome exibido limpo.
  const salvas = new Map<string, { vendedor: string; meta: number }>();
  for (const [nome, meta] of Object.entries(d.metas_individuais ?? {})) {
    const limpo = clean(nome);
    if (limpo) salvas.set(limpo.toLowerCase(), { vendedor: limpo, meta: num(meta) });
  }

  const linhas: MetasConfig["metasVendedores"] = [];
  const usados = new Set<string>();

  // 1) Roster atual — uma linha por vendedor, com meta salva ou 0.
  for (const nome of nomesVendedores ?? []) {
    const limpo = clean(nome);
    const k = limpo.toLowerCase();
    if (!limpo || usados.has(k)) continue;
    usados.add(k);
    linhas.push({ vendedor: limpo, meta: salvas.get(k)?.meta ?? 0 });
  }

  // 2) Metas salvas fora do roster (ou tudo, sem roster) — preservadas no fim.
  const extras = [...salvas.values()]
    .filter((e) => !usados.has(e.vendedor.toLowerCase()))
    .sort((a, b) => a.vendedor.localeCompare(b.vendedor, "pt-BR"));

  return {
    metaEmpresa: num(d.meta_mensal_total ?? d.meta_mensal),
    metasVendedores: [...linhas, ...extras],
  };
}

/** Corpo exato do POST /metas (modelo Pydantic MetasPayload do server.py). */
export function metasParaPayload(cfg: MetasConfig): {
  meta_mensal_total: number;
  metas_individuais: Record<string, number>;
} {
  const metas_individuais: Record<string, number> = {};
  for (const linha of cfg?.metasVendedores ?? []) {
    const nome = clean(linha?.vendedor);
    if (nome) metas_individuais[nome] = num(linha?.meta);
  }
  return { meta_mensal_total: num(cfg?.metaEmpresa), metas_individuais };
}
