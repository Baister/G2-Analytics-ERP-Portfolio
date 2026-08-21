// Verifica o ARTEFATO que vai ao ar, não o código-fonte.
//
//   node scripts/verifica_publicacao.mjs "/nome-do-repo"
//
// Este script existe por causa de uma sequência de enganos que vale registrar,
// porque cada um parecia uma verificação legítima:
//
//   "responde HTTP 200"      → mede se o servidor entregou o arquivo, não se a
//                              aplicação subiu;
//   "os assets carregam"     → carregavam, e o roteador recusava a rota;
//   "o código-fonte confere" → conferia, e o prefixo era sobrescrito no build.
//
// A causa real só apareceu ao inspecionar o pacote publicado: o TanStack Start
// deriva o prefixo do roteador do `base` do Vite, e com `base: "./"` ele virava
// ".", que não casa com caminho nenhum. Daí a regra desta verificação: olhar o
// que foi gerado, não o que se pretendia gerar.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const CLIENTE = join(import.meta.dirname, "..", "dist", "client");
const prefixo = (process.argv[2] || "").replace(/\/+$/, "");
const semBarras = prefixo.replace(/^\/+/, "");

let falhas = 0;
const falhar = (msg) => {
  console.log(`FALHOU  ${msg}`);
  falhas++;
};
const ok = (msg) => console.log(`OK      ${msg}`);

if (!existsSync(CLIENTE)) {
  console.error(`nada para verificar: ${CLIENTE} não existe — rode o build estático antes`);
  process.exit(1);
}

const index = readFileSync(join(CLIENTE, "index.html"), "utf8");

// 1. Toda referência do documento tem de apontar para dentro do prefixo.
//    Uma URL absoluta sem ele busca na raiz do domínio e devolve 404.
const referencias = [...index.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]);
const foraDoPrefixo = referencias.filter((u) => prefixo && !u.startsWith(`${prefixo}/`));
if (foraDoPrefixo.length === 0) {
  ok(`${referencias.length} referências, todas sob ${prefixo || "/"}`);
} else {
  falhar(`referências fora do prefixo: ${[...new Set(foraDoPrefixo)].join(", ")}`);
}

// 2. O 404.html precisa ser cópia do index — é ele que o Pages devolve num
//    link direto, e é o que permite abrir /vendas sem passar pela raiz.
const naoEncontrado = join(CLIENTE, "404.html");
if (!existsSync(naoEncontrado)) falhar("404.html ausente — links diretos não funcionarão");
else if (readFileSync(naoEncontrado, "utf8") !== index) falhar("404.html difere do index.html");
else ok("404.html é cópia fiel do index.html");

// 3. O PREFIXO DO ROTEADOR gravado no pacote. É esta a verificação que teria
//    poupado o retrabalho: sem ela, tudo o mais passa e a tela mostra
//    "página não encontrada".
// O nome do pedaço que carrega essa constante é decidido pelo empacotador e
// muda entre builds — procurar só em `index-*.js` daria falso negativo.
const assets = join(CLIENTE, "assets");
let valor;
for (const arquivo of readdirSync(assets).filter((f) => f.endsWith(".js"))) {
  const achado = /TSS_ROUTER_BASEPATH:\s*[`"']([^`"']*)[`"']/.exec(
    readFileSync(join(assets, arquivo), "utf8"),
  );
  if (achado) {
    valor = achado[1];
    break;
  }
}

const esperado = semBarras || "/";
if (valor === undefined) falhar("TSS_ROUTER_BASEPATH não encontrado em nenhum pacote");
else if (valor === esperado) ok(`prefixo do roteador = ${valor || "/"}`);
else {
  falhar(
    `prefixo do roteador é "${valor}", esperado "${esperado}" — ` +
      "o roteador recusaria todas as rotas e a aplicação mostraria 404",
  );
}

// 4. O retrato de dados precisa ter viajado junto, senão os painéis abrem vazios.
const demo = join(CLIENTE, "demo");
if (!existsSync(demo)) falhar("pasta demo/ ausente — as telas ficarão sem dados");
else {
  const arquivos = readdirSync(demo).filter((f) => f.endsWith(".json"));
  if (arquivos.length >= 12) ok(`retrato de dados com ${arquivos.length} arquivos`);
  else falhar(`retrato incompleto: ${arquivos.length} arquivos (esperado 12+)`);
}

console.log(
  falhas ? `\n${falhas} verificação(ões) falharam.` : "\nArtefato pronto para publicação.",
);
process.exit(falhas ? 1 : 0);
