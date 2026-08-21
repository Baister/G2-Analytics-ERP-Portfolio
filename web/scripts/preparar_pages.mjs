// Prepara a saída do build estático para o GitHub Pages.
//
//   node scripts/preparar_pages.mjs "/nome-do-repo/"
//
// O build já resolve os caminhos: `BASE_PATH` alimenta o `base` do Vite, que
// por sua vez define o prefixo do roteador no TanStack Start. Aqui sobram dois
// acertos finais:
//
//   1. `_shell.html` → `index.html`, que é o que um servidor de arquivos
//      procura ao receber um pedido de diretório;
//   2. cópia para `404.html`: o GitHub Pages não sabe rotear uma aplicação de
//      página única e devolve o 404 para qualquer link direto. Servindo o mesmo
//      shell, o roteador assume no navegador e a rota abre normalmente.
//
// Mais os favicons, que o gerador emite sem o prefixo.

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const CLIENTE = join(import.meta.dirname, "..", "dist", "client");
const prefixo = (process.argv[2] || "/").replace(/\/+$/, "");

const shell = join(CLIENTE, "_shell.html");
const indice = join(CLIENTE, "index.html");

if (!existsSync(shell) && !existsSync(indice)) {
  console.error(`nada para preparar: ${shell} não existe — rode antes o build estático`);
  process.exit(1);
}
if (existsSync(shell)) renameSync(shell, indice);

let html = readFileSync(indice, "utf8");

if (prefixo) {
  const antes = html;
  html = html.replace(/(src|href)="\/(favicon[^"]*)"/g, `$1="${prefixo}/$2"`);
  if (html !== antes) console.log("  favicons ajustados para o prefixo");
}

writeFileSync(indice, html, "utf8");
copyFileSync(indice, join(CLIENTE, "404.html"));

console.log(
  `site pronto em dist/client — prefixo "${prefixo || "/"}", index.html e 404.html gerados`,
);
