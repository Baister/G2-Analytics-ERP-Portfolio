// Verifica a derivação do prefixo de publicação a partir do <base href>.
//
//   npx tsx scripts/verifica_basepath.ts
//
// Existe porque este foi um defeito de produção com sintoma enganoso: o
// servidor respondia 200, todos os assets carregavam, e mesmo assim a tela
// mostrava "página não encontrada" — o roteador comparava a URL do navegador
// (`/nome-do-repo/`) com as rotas registradas (`/`) e não achava nenhuma.
// Verificar só o código HTTP não pega isso.

import process from "node:process";

import { basepathDoDocumento } from "../src/lib/basepath";

const casos: Array<[string | undefined, string, string]> = [
  ["https://usuario.github.io/meu-repo/", "/meu-repo", "Pages em subpasta"],
  ["https://usuario.github.io/meu-repo", "/meu-repo", "subpasta sem barra final"],
  ["https://usuario.github.io/meu-repo///", "/meu-repo", "barras extras"],
  ["http://localhost:8790/", "/", "servidor local na raiz"],
  // Só chega aqui quando existe <base href>; `basepathAtual` devolve "/" antes
  // disso quando a tag não existe (ver o comentário lá).
  ["http://localhost:8790/vendas", "/vendas", "base href apontando para subpasta"],
  [undefined, "/", "sem document (pré-render)"],
  ["não-é-url", "/", "valor inválido não pode derrubar a aplicação"],
];

let falhas = 0;
for (const [entrada, esperado, descricao] of casos) {
  const obtido = basepathDoDocumento(entrada);
  const ok = obtido === esperado;
  if (!ok) falhas++;
  console.log(
    `${ok ? "OK     " : "FALHOU "} ${descricao.padEnd(34)} ${String(entrada)} → ${obtido}` +
      (ok ? "" : ` (esperado ${esperado})`),
  );
}

console.log(falhas ? `\n${falhas} caso(s) falharam.` : `\nTodos os ${casos.length} casos passaram.`);
process.exit(falhas ? 1 : 0);
