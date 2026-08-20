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

const ESTATICO = process.env.VITE_DEMO === "1";

export default defineConfig(({ command }) => ({
  base: process.env.BASE_PATH || "/",
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
      // Mesma proteção de imports que o wrapper aplicava por padrão.
      importProtection: {
        behavior: "error",
        client: { files: ["**/server/**"], specifiers: ["server-only"] },
      },
    }),
    // O alvo estático pré-renderiza as 13 rotas (todas fixas, sem parâmetro)
    // e gera um 404.html apontando para o index — é o que faz link direto
    // funcionar num host que não sabe rotear SPA.
    ...(command === "build"
      ? [nitro(ESTATICO
          ? { preset: "static", prerender: { crawlLinks: true, routes: ["/"] } }
          : { preset: "node-server" })]
      : []),
    viteReact(),
  ],
}));
