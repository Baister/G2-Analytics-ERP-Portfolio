// Adaptador Metas — GET /metas → contrato MetasConfig da tela de Configurações,
// e o corpo exato do POST /metas.
//
// GET /metas devolve { meta_mensal_total, metas_individuais: {nome: meta} } e o
// POST valida esse mesmo par (meta_mensal_total é o nome do campo; qualquer
// outro volta 422). Metas ficam num arquivo do servidor, não no banco: são
// configuração do usuário, não dado apurado.
//
// O que este adaptador resolve, e o servidor não:
//   - uma linha por vendedor do roster ATUAL, mesmo sem meta salva (meta 0);
//     sem isso um vendedor novo nunca apareceria na tela para receber meta;
//   - metas salvas de quem saiu do roster ficam no fim da lista, em ordem
//     alfabética — o POST reescreve o arquivo inteiro, então deixá-las de fora
//     apagaria silenciosamente o histórico;
//   - nome sempre trimado e sem repetição: a tela usa o nome como chave de
//     React, e chave duplicada quebra a renderização da grade.

import type { MetasConfig } from "../types";
import { clean, num } from "./shared";

// Payload cru — shape validado contra a API, sem tipagem estática.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

const asRows = (x: unknown): Row[] => (Array.isArray(x) ? (x as Row[]) : []);

/**
 * Roster de nomes a exibir. Aceita as duas formas com que o adaptador é
 * chamado: uma lista de nomes já pronta, ou o payload cru de /dados/vendas —
 * de onde saem os vendedores do mês (`vendedores`, com `progresso_vendedores`
 * e `top_vendedores` como reserva quando a tabela de vendedores não veio).
 */
function roster(fonte: unknown): string[] {
  if (Array.isArray(fonte)) return fonte.map(clean);

  const d: Row = fonte ?? {};
  const nomes = asRows(d.vendedores).map((r) => clean(r?.nome));
  if (nomes.length) return nomes;
  for (const lista of [d.progresso_vendedores, d.top_vendedores]) {
    for (const r of asRows(lista)) nomes.push(clean(r?.vendedor));
  }
  return nomes;
}

export function adaptMetas(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  // Lista de nomes OU payload cru de /dados/vendas. Sem ela, a tela lista
  // apenas as metas já salvas.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vendedores?: string[] | any,
): MetasConfig {
  const d: Row = raw ?? {};

  // Metas salvas — chave normalizada (trim + lowercase), nome exibido limpo.
  const salvas = new Map<string, { vendedor: string; meta: number }>();
  for (const [nome, meta] of Object.entries(d.metas_individuais ?? {})) {
    const limpo = clean(nome);
    if (limpo) salvas.set(limpo.toLowerCase(), { vendedor: limpo, meta: num(meta) });
  }

  // 1) Roster atual, na ordem em que o servidor o entrega.
  const linhas: MetasConfig["metasVendedores"] = [];
  const usados = new Set<string>();
  for (const nome of roster(vendedores)) {
    const k = nome.toLowerCase();
    if (!nome || usados.has(k)) continue;
    usados.add(k);
    linhas.push({ vendedor: nome, meta: salvas.get(k)?.meta ?? 0 });
  }

  // 2) Metas salvas fora do roster (ou todas, quando não há roster).
  const extras = [...salvas.entries()]
    .filter(([k]) => !usados.has(k))
    .map(([, linha]) => linha)
    .sort((a, b) => a.vendedor.localeCompare(b.vendedor, "pt-BR"));

  return {
    metaEmpresa: num(d.meta_mensal_total),
    metasVendedores: [...linhas, ...extras],
  };
}

/** Corpo exato do POST /metas. */
export function metasParaPayload(cfg: MetasConfig): {
  meta_mensal_total: number;
  metas_individuais: Record<string, number>;
} {
  const metas_individuais: Record<string, number> = {};
  for (const linha of cfg?.metasVendedores ?? []) {
    const nome = clean(linha?.vendedor);
    // num() garante número finito: o servidor recusa o corpo inteiro (422) se
    // um único valor for NaN/Infinity, e o campo é digitado à mão na tela.
    if (nome) metas_individuais[nome] = num(linha?.meta);
  }
  return { meta_mensal_total: num(cfg?.metaEmpresa), metas_individuais };
}
