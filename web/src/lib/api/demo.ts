// Modo demonstração — a aplicação inteira sem backend nenhum.
//
// Existe para o site estático publicado: um recrutador abre o link e navega
// pelos doze painéis sem instalar Python, sem banco e sem VPN. Os payloads são
// os MESMOS que a API devolve, gerados por `api/dados/exportar_demo.py` a
// partir do banco sintético e salvos em `web/public/demo/`.
//
// O que muda em relação a rodar o projeto completo: aqui os dados são um
// retrato, então os filtros que o servidor calcula (período e dimensão) caem
// para o retrato do mês corrente. Tudo que é client-side — busca, ordenação,
// paginação, filtro cruzado por clique, expandir, tema e exportação — funciona
// igual.
//
// Convenção: dentro de src/lib/api/** só imports RELATIVOS.

/** Ligado no build estático (`VITE_DEMO=1`). */
export function modoDemo(): boolean {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return env?.["VITE_DEMO"] === "1";
}

/** Prefixo público do site (GitHub Pages serve em subpasta). */
function base(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  return (env?.["BASE_URL"] ?? "/").replace(/\/+$/, "");
}

/** path da API → arquivo baixado. `/dados/crm` vira `demo/dados-crm.json`. */
function arquivoPara(caminho: string): string {
  const semQuery = (caminho.split("?")[0] ?? "").replace(/^\/+/, "");
  return `${base()}/demo/${semQuery.replace(/\//g, "-")}.json`;
}

const cache = new Map<string, unknown>();

async function carregar(arquivo: string): Promise<unknown> {
  if (cache.has(arquivo)) return cache.get(arquivo);
  const res = await fetch(arquivo);
  if (!res.ok) throw new Error(`payload de demonstração ausente: ${arquivo}`);
  const dado = await res.json();
  cache.set(arquivo, dado);
  return dado;
}

/**
 * Responde a uma chamada de API com o retrato correspondente.
 *
 * Endpoints com parâmetro têm tratamento próprio: o perfil de cliente e a
 * busca saem de um único arquivo indexado por código, e os endpoints filtrados
 * caem para o retrato sem filtro.
 */
export async function responderDemo<T = unknown>(caminho: string): Promise<T> {
  const [rotaBruta, query = ""] = caminho.split("?");
  const rota = rotaBruta ?? caminho;
  const params = new URLSearchParams(query);

  // Perfil e busca de clientes: um arquivo só, com tudo indexado.
  if (rota === "/dados/cliente") {
    const base = (await carregar(arquivoPara("/dados/cliente"))) as {
      lista: Array<{ codigo: string; nome: string; razao: string }>;
      perfis: Record<string, unknown>;
    };
    const cod = params.get("cod");
    if (cod) {
      const perfil = base.perfis[cod];
      return (perfil ?? { erro: `cliente '${cod}' não encontrado` }) as T;
    }
    const termo = (params.get("busca") ?? "").trim().toLowerCase();
    if (!termo) return { modo: "vazio" } as T;
    const achados = base.lista.filter(
      (c) =>
        c.nome.toLowerCase().includes(termo) ||
        c.razao.toLowerCase().includes(termo) ||
        c.codigo.toLowerCase().includes(termo),
    );
    return { modo: "busca", clientes: achados.slice(0, 20) } as T;
  }

  // Período personalizado e recortes por dimensão são calculados no servidor;
  // no retrato estático caem para o mês corrente.
  if (rota === "/dados/dashboard/filtered") {
    return (await carregar(arquivoPara("/dados/dashboard"))) as T;
  }

  return (await carregar(arquivoPara(rota))) as T;
}

/** Sessão fictícia: qualquer senha entra e libera todas as abas. */
export function autenticarDemo(): { access_token: string; tabs: string[] } {
  return { access_token: "demo", tabs: ["*"] };
}
