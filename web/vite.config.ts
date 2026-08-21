// Dois alvos de build a partir do mesmo código:
//
//   npm run build         → servidor Node (.output/server/index.mjs), usado
//                           quando se roda o projeto completo com a API local.
//   npm run build:estatico → site estático pré-renderizado, publicado no
//                           GitHub Pages. Liga VITE_DEMO=1, e aí a camada de
//                           dados responde pelos retratos em public/demo/ em
//                           vez de chamar a API.
//
// BASE_PATH existe porque o Pages serve em subpasta (/nome-do-repo/); em
// desenvolvimento fica "/".
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";

const ESTATICO = process.env["VITE_DEMO"] === "1";

// O GitHub Pages serve projeto em subpasta (/nome-do-repo/). O `base` do Vite
// resolve os assets E, no TanStack Start, também define o prefixo do roteador:
//
//   deriveRouterBasepath() → publicBase.replace(/^\/|\/$/g, "")
//
// Ou seja, os dois saem da MESMA fonte e não podem divergir. Já tentei manter
// `base: "./"` para ter assets relativos: o roteador nascia com prefixo "."
// e recusava todas as rotas — site no ar, assets carregando, e a aplicação
// exibindo a própria tela de "página não encontrada".
const BASE = process.env["BASE_PATH"] || "/";

export default defineConfig(({ command }) => ({
  base: BASE,
  server: { port: 8080 },
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@tanstack/react-query",
      "@tanstack/query-core",
    ],
  },
  plugins: [
    tailwindcss(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      // Mantém src/server.ts (wrapper SSR de erro) como server entry.
      server: { entry: "server" },
      // No alvo estático o app vira SPA: o build pré-renderiza um shell em
      // index.html e o roteamento acontece no navegador. É o que permite
      // hospedar num servidor de arquivos, sem processo Node por trás.
      ...(ESTATICO ? { spa: { enabled: true } } : {}),
      // Mesma proteção de imports que o wrapper aplicava por padrão.
      importProtection: {
        behavior: "error",
        client: { files: ["**/server/**"], specifiers: ["server-only"] },
      },
    }),
    // O nitro empacota um servidor Node em .output/. No alvo estático ele sai
    // de cena: o pré-render do TanStack precisa da saída padrão do Vite em
    // dist/, e os dois disputando o mesmo diretório fazem o build falhar.
    ...(command === "build" && !ESTATICO ? [nitro({ preset: "node-server" })] : []),
    viteReact(),
  ],
}));
