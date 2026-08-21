/**
 * Prefixo em que a aplicação está publicada.
 *
 * Num servidor próprio ela vive na raiz; no GitHub Pages, numa subpasta com o
 * nome do repositório. O prefixo é lido do `<base href>` do documento — que o
 * `scripts/preparar_pages.mjs` injeta no build estático — em vez de fixado em
 * tempo de compilação. Assim o mesmo bundle serve os dois casos, com uma única
 * fonte da verdade para o caminho.
 *
 * Sem isso o site carrega, os assets carregam e o roteador mostra "página não
 * encontrada": ele compara a URL do navegador (`/nome-do-repo/`) com as rotas
 * registradas (`/`) e não acha nenhuma. É uma falha silenciosa — o servidor
 * responde 200 e só a tela denuncia. Verificar o código HTTP não a detecta.
 */
export function basepathDoDocumento(baseURI: string | undefined): string {
  if (!baseURI) return "/";
  try {
    // Sem barra final: o roteador compara segmento a segmento, e "/app/" não
    // casa com "/app/vendas".
    return new URL(baseURI).pathname.replace(/\/+$/, "") || "/";
  } catch {
    // Um <base href> malformado não pode derrubar a aplicação inteira.
    return "/";
  }
}

/** Prefixo do documento atual (ou "/" fora do navegador, como no pré-render).
 *
 * Só considera o prefixo quando existe uma tag `<base href>` de verdade. Sem
 * ela, `document.baseURI` é a própria URL da página — e abrir /vendas direto
 * faria o prefixo virar "/vendas", quebrando todas as rotas no servidor
 * próprio, onde a aplicação vive na raiz.
 */
export function basepathAtual(): string {
  if (typeof document === "undefined") return "/";
  if (!document.querySelector("base[href]")) return "/";
  return basepathDoDocumento(document.baseURI);
}
