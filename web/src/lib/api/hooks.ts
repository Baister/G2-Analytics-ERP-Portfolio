// Hooks de dados — API REAL (FastAPI, porta 8765).
// Cada hook busca o payload cru do bot e o converte com o adaptador da aba;
// as telas consomem exatamente o mesmo contrato de antes (assinaturas idênticas).
// Convenção: dentro de src/lib/api/** só imports RELATIVOS.

import { useEffect, useRef, useState } from "react";

import type {
  ClientePerfil,
  ClienteResumo,
  ClientesCarteira,
  CmpData,
  CmpFiltros,
  CrmData,
  DashboardData,
  EstoqueData,
  Filtros,
  FinanceiroData,
  ImpostoData,
  MetasConfig,
  PainelPedidos,
  Periodo,
  VendasData,
} from "./types";
import { apiFetch, postJson } from "./client";
import { CMP_FILTROS_PADRAO, FILTROS_PADRAO, PERIODO_MES_ATUAL } from "./periodo";
import { adaptCmp } from "./adapters/cmp";
import { adaptDashboard } from "./adapters/dashboard";
import { adaptVendas } from "./adapters/vendas";
import { adaptEstoque } from "./adapters/estoque";
import { adaptFinanceiro } from "./adapters/financeiro";
import { adaptCrm } from "./adapters/crm";
import { adaptImposto } from "./adapters/imposto";
import { adaptClientePerfil, adaptClientesBusca } from "./adapters/cliente";
import { adaptClientesCarteira } from "./adapters/clientes";
import { adaptPainelPedidos } from "./adapters/painel";
import { adaptMetas, metasParaPayload } from "./adapters/metas";

export { CMP_FILTROS_PADRAO, FILTROS_PADRAO, PERIODO_MES_ATUAL };

/** Intervalo único de atualização periódica de toda a aplicação. */
export const REFRESH_MS = 60000;
/** Painel de pedidos (telão) atualiza mais rápido. */
export const REFRESH_PEDIDOS_MS = 30000;

export interface QueryResult<T> {
  data: T | undefined;
  isLoading: boolean;
  error: Error | null;
  /** true enquanto QUALQUER fetch está em voo (não só o primeiro) —
   * usado p/ indicar consultas longas (ex.: período personalizado). */
  isFetching?: boolean;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/** Chave estável de refetch derivada dos filtros. */
function filtroKey(f: Filtros): string {
  return [
    f.vendedores.join(","),
    f.marcas.join(","),
    f.grupos.join(","),
    f.periodo.inicio,
    f.periodo.fim,
  ].join("|");
}

interface ApiQueryOpts {
  /** Refetch automático a cada N ms (mantém o data anterior durante o fetch). */
  intervalMs?: number;
  /** false → não dispara fetch algum (retorno neutro). */
  enabled?: boolean;
  /** Atrasa o primeiro fetch de cada key (debounce de busca). */
  debounceMs?: number;
  /** true → mudança de key zera data e religa isLoading (busca/perfil). */
  resetOnKeyChange?: boolean;
}

/**
 * Motor genérico dos hooks de dados.
 * - isLoading: true só até o primeiro resultado; refetch (intervalo ou troca de
 *   filtros) mantém o data anterior na tela ("keep-last-good").
 * - erro em refetch com data já carregado NÃO vira `error` — preserva o último
 *   payload bom; `error` só aparece quando ainda não há nada para mostrar.
 * - guarda de corrida: resposta de uma key antiga é descartada.
 */
function useApiQuery<T>(
  fetcher: () => Promise<T>,
  key: string,
  opts: ApiQueryOpts = {},
): QueryResult<T> {
  const { intervalMs, enabled = true, debounceMs, resetOnKeyChange = false } = opts;

  const [data, setData] = useState<T | undefined>(undefined);
  const [isLoading, setLoading] = useState(enabled);
  const [error, setError] = useState<Error | null>(null);
  const [isFetching, setFetching] = useState(false);

  // fetcher muda a cada render (closure sobre filtros); o ref evita relançar o
  // effect — só key/opts disparam refetch.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const dataRef = useRef<T | undefined>(undefined);
  dataRef.current = data;

  const genRef = useRef(0);

  useEffect(() => {
    // Invalida qualquer resposta em voo da configuração anterior.
    const gen = ++genRef.current;

    if (!enabled) {
      setLoading(false);
      return;
    }

    if (resetOnKeyChange) {
      dataRef.current = undefined;
      setData(undefined);
      setError(null);
      setLoading(true);
    }

    const run = async () => {
      setFetching(true);
      try {
        const result = await fetcherRef.current();
        if (gen !== genRef.current) return; // resposta velha — descarta
        dataRef.current = result;
        setData(result);
        setError(null);
      } catch (e) {
        if (gen !== genRef.current) return;
        // keep-last-good: só expõe o erro quando ainda não há data.
        if (dataRef.current === undefined) setError(toError(e));
      } finally {
        if (gen === genRef.current) {
          setLoading(false);
          setFetching(false);
        }
      }
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (debounceMs && debounceMs > 0) {
      timeout = setTimeout(() => void run(), debounceMs);
    } else {
      void run();
    }

    let interval: ReturnType<typeof setInterval> | undefined;
    if (intervalMs && intervalMs > 0) {
      interval = setInterval(() => void run(), intervalMs);
    }

    return () => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (interval !== undefined) clearInterval(interval);
    };
  }, [key, enabled, intervalMs, debounceMs, resetOnKeyChange]);

  return { data, isLoading, error, isFetching };
}

export function useDashboard(filtros: Filtros = FILTROS_PADRAO): QueryResult<DashboardData> {
  // Período personalizado → endpoint filtrado (o bot roda as MESMAS queries
  // do ciclo com a janela pedida, ~1-2 min) e SEM auto-refresh: dado
  // histórico não muda e re-executar a bateria a cada 60s puniria o banco.
  const custom =
    filtros.periodo.inicio !== PERIODO_MES_ATUAL.inicio ||
    filtros.periodo.fim !== PERIODO_MES_ATUAL.fim;
  return useApiQuery(
    async () => {
      const urlDash = custom
        ? `/dados/dashboard/filtered?dt_de=${filtros.periodo.inicio}&dt_ate=${filtros.periodo.fim}`
        : "/dados/dashboard";
      // Mês atual → payload do ciclo (RAM) + /dados/vendas p/ porGrupo;
      // /metas alinha a meta com as abas Vendas/CRM — opcional (catch → null).
      const [dash, vendas, metas] = await Promise.all([
        apiFetch(urlDash),
        custom ? Promise.resolve(null) : apiFetch("/dados/vendas").catch(() => null),
        apiFetch("/metas").catch(() => null),
      ]);
      return adaptDashboard(dash, vendas, filtros, metas);
    },
    filtroKey(filtros),
    { intervalMs: custom ? 0 : REFRESH_MS },
  );
}

export function useVendas(filtros: Filtros = FILTROS_PADRAO): QueryResult<VendasData> {
  return useApiQuery(
    async () => {
      // /metas alimenta Ritmo do Mês e progresso por vendedor; opcional.
      const [vendas, metas] = await Promise.all([
        apiFetch("/dados/vendas"),
        apiFetch("/metas").catch(() => null),
      ]);
      return adaptVendas(vendas, metas, filtros);
    },
    filtroKey(filtros),
    { intervalMs: REFRESH_MS },
  );
}

export function useEstoque(): QueryResult<EstoqueData> {
  return useApiQuery(
    async () => adaptEstoque(await apiFetch("/dados/estoque")),
    "estoque",
    { intervalMs: REFRESH_MS },
  );
}

export function useFinanceiro(periodo: Periodo = PERIODO_MES_ATUAL): QueryResult<FinanceiroData> {
  // Fase 1: o backend entrega um recorte fixo — `periodo` é ignorado no fetch,
  // mas fica na key para refazer a busca quando a tela trocar o período.
  return useApiQuery(
    async () => adaptFinanceiro(await apiFetch("/dados/financeiro")),
    `financeiro|${periodo.inicio}|${periodo.fim}`,
    { intervalMs: REFRESH_MS },
  );
}

export function useCrm(vendedores: string[] = []): QueryResult<CrmData> {
  return useApiQuery(
    async () => {
      // O payload do CRM já traz a dimensão de vendedor em todas as listas,
      // então o recorte acontece no adaptador — sem ida ao servidor. Trocar de
      // vendedor fica instantâneo, e o mesmo payload serve a todas as
      // seleções (uma consulta por vendedor selecionado seria desperdício).
      // /metas habilita o percentual de meta no ranking; opcional.
      const [crm, metas] = await Promise.all([
        apiFetch("/dados/crm"),
        apiFetch("/metas").catch(() => null),
      ]);
      return adaptCrm(crm, vendedores, metas);
    },
    `crm|${vendedores.join(",")}`,
    { intervalMs: REFRESH_MS },
  );
}

export function useImposto(periodo: Periodo = PERIODO_MES_ATUAL): QueryResult<ImpostoData> {
  // Fase 1: `periodo` ignorado no fetch (backend entrega o mês corrente).
  return useApiQuery(
    async () => adaptImposto(await apiFetch("/dados/imposto")),
    `imposto|${periodo.inicio}|${periodo.fim}`,
    { intervalMs: REFRESH_MS },
  );
}

export function useClienteBusca(termo: string): QueryResult<ClienteResumo[]> {
  const t = termo.trim();
  const habilitada = t.length >= 2;

  // O hook interno é SEMPRE chamado (ordem de hooks estável); com menos de
  // 2 caracteres nada é buscado e o retorno neutro sobrescreve o resultado.
  const q = useApiQuery<ClienteResumo[]>(
    async () =>
      adaptClientesBusca(await apiFetch(`/dados/cliente?busca=${encodeURIComponent(t)}`)),
    `busca|${t}`,
    { enabled: habilitada, debounceMs: 400, resetOnKeyChange: true },
  );

  if (!habilitada) return { data: [], isLoading: false, error: null };
  return q;
}

export function useClientePerfil(codigo: string | null): QueryResult<ClientePerfil | null> {
  const habilitado = codigo != null && codigo !== "";

  const q = useApiQuery<ClientePerfil | null>(
    async () =>
      adaptClientePerfil(await apiFetch(`/dados/cliente?cod=${encodeURIComponent(codigo ?? "")}`)),
    `perfil|${codigo ?? ""}`,
    { enabled: habilitado, resetOnKeyChange: true },
  );

  if (!habilitado) return { data: null, isLoading: false, error: null };
  return q;
}

export function useClientesCarteira(): QueryResult<ClientesCarteira> {
  return useApiQuery(
    async () => adaptClientesCarteira(await apiFetch("/dados/clientes")),
    "clientes_carteira",
    { intervalMs: REFRESH_MS },
  );
}

/** Chave estável dos filtros do CMP (espelho de filtroKey). */
function cmpKey(f: CmpFiltros): string {
  return [
    "cmp",
    f.periodo.inicio,
    f.periodo.fim,
    f.clientes.join(","),
    f.vendedores.join(","),
    f.marcas.join(","),
  ].join("|");
}

export function useCmp(filtros: CmpFiltros = CMP_FILTROS_PADRAO): QueryResult<CmpData> {
  // Consulta on-demand (sem intervalMs): o servidor agrega os itens de venda na
  // hora e mantém micro-cache de 60s; o debounce coalesce cliques em sequência
  // nos MultiSelects (cada mudança de filtro é uma consulta nova ao banco).
  return useApiQuery(
    async () => {
      const qs = new URLSearchParams({
        dt_de: filtros.periodo.inicio,
        dt_ate: filtros.periodo.fim,
      });
      if (filtros.clientes.length) qs.set("clientes", filtros.clientes.join(","));
      if (filtros.vendedores.length) qs.set("vendedores", filtros.vendedores.join(","));
      if (filtros.marcas.length) qs.set("marcas", filtros.marcas.join(","));
      return adaptCmp(await apiFetch(`/dados/cliente-marca-produto?${qs.toString()}`));
    },
    cmpKey(filtros),
    { debounceMs: 500 },
  );
}

export function usePainelPedidos(): QueryResult<PainelPedidos> {
  return useApiQuery(
    async () => adaptPainelPedidos(await apiFetch("/dados/painel-pedidos")),
    "painel_pedidos",
    { intervalMs: REFRESH_PEDIDOS_MS },
  );
}

/**
 * Roster de vendedores derivado do payload cru de /dados/vendas — garante uma
 * linha de meta por vendedor ativo mesmo sem meta salva. Nomes SEMPRE trimados
 * (o banco traz espaços à direita).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nomesVendedores(rawVendas: any): string[] | undefined {
  if (!rawVendas) return undefined;
  const nomes: string[] = [];
  const vistos = new Set<string>();
  for (const lista of [
    rawVendas.kpis_por_vendedor,
    rawVendas.por_vendedor,
    rawVendas.top_vendedores,
  ]) {
    if (!Array.isArray(lista)) continue;
    for (const row of lista) {
      const nome = typeof row?.Vendedor === "string" ? row.Vendedor.trim() : "";
      const k = nome.toLowerCase();
      if (!nome || vistos.has(k)) continue;
      vistos.add(k);
      nomes.push(nome);
    }
  }
  return nomes.length ? nomes : undefined;
}

export function useMetas() {
  // `data` é SEMPRE um MetasConfig definido — a tela de Configurações faz
  // `salvar({ ...data, ... })` antes mesmo do primeiro load terminar.
  const [metas, setMetas] = useState<MetasConfig>({ metaEmpresa: 0, metasVendedores: [] });
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const genRef = useRef(0);

  const carregar = async () => {
    const gen = ++genRef.current;
    try {
      // /dados/vendas fornece o roster de nomes; opcional (sem ele, o
      // adaptador lista só as metas já salvas).
      const [rawMetas, rawVendas] = await Promise.all([
        apiFetch("/metas"),
        apiFetch("/dados/vendas").catch(() => null),
      ]);
      if (gen !== genRef.current) return;
      setMetas(adaptMetas(rawMetas, nomesVendedores(rawVendas)));
      setError(null);
    } catch (e) {
      if (gen !== genRef.current) return;
      setError(toError(e));
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  };

  const carregarRef = useRef(carregar);
  carregarRef.current = carregar;

  useEffect(() => {
    void carregarRef.current();
  }, []);

  const salvar = (next: MetasConfig) => {
    // Otimista: a tela reflete o valor salvo imediatamente; o POST confirma e
    // o refetch ressincroniza com o servidor (inclusive em falha).
    setMetas(next);
    postJson<{ ok?: boolean }>("/metas", metasParaPayload(next))
      .then((res) => {
        if (res?.ok === true) {
          setError(null);
          return carregarRef.current();
        }
        throw new Error("Falha ao salvar as metas");
      })
      .catch((e: unknown) => {
        setError(toError(e));
        void carregarRef.current();
      });
  };

  return { data: metas, isLoading, error, salvar };
}
