// Prepara a saída do build estático para hospedagem em subpasta.
//
//   node scripts/preparar_pages.mjs "/nome-do-repo/"
//
// O build estático gera `dist/client/_shell.html` com assets em caminho
// relativo. Três ajustes fazem isso virar um site publicável:
//
//   1. `_shell.html` → `index.html`, que é o que um servidor de arquivos
//      procura ao receber um pedido de diretório;
//   2. injeção de `<base href="/nome-do-repo/">`, para que os caminhos
//      relativos resolvam a partir da raiz do site e não do caminho atual —
//      sem isso, abrir /repo/vendas direto faria o navegador pedir os assets
//      em /repo/vendas/assets/;
//   3. cópia para `404.html`: o GitHub Pages não sabe rotear uma aplicação de
//      página única, então devolve o 404 para qualquer link direto. Servindo o
//      mesmo shell, o roteador assume no navegador e a rota abre normalmente.

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const CLIENTE = join(import.meta.dirname, "..", "dist", "client");
const prefixo = process.argv[2] || "/";

const shell = join(CLIENTE, "_shell.html");
const indice = join(CLIENTE, "index.html");

if (!existsSync(shell) && !existsSync(indice)) {
  console.error(`nada para preparar: ${shell} não existe — rode antes o build estático`);
  process.exit(1);
}
if (existsSync(shell)) renameSync(shell, indice);

let html = readFileSync(indice, "utf8");

// O build com base relativa emite parte das referências como "/./assets/…" —
// absolutas, e por isso imunes ao <base href>: num site em subpasta elas
// apontariam para a raiz do domínio e dariam 404. Normaliza para relativas,
// que é o que o <base> sabe resolver.
const antes = html;
html = html.replace(/(src|href)="\/\.\//g, '$1="./');
html = html.replace(/(src|href)="\/(favicon[^"]*)"/g, '$1="./$2"');
if (html !== antes) {
  console.log("  referências absolutas normalizadas para relativas");
}

if (/<base\s/i.test(html)) {
  html = html.replace(/<base\s[^>]*>/i, `<base href="${prefixo}">`);
} else if (/<head[^>]*>/i.test(html)) {
  html = html.replace(/(<head[^>]*>)/i, `$1<base href="${prefixo}">`);
} else {
  console.error("não achei <head> no shell — o build mudou de formato");
  process.exit(1);
}

writeFileSync(indice, html, "utf8");
copyFileSync(indice, join(CLIENTE, "404.html"));

console.log(`site pronto em dist/client — base "${prefixo}", index.html e 404.html gerados`);
