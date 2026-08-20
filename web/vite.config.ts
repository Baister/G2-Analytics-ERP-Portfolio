// Config vanilla (sem o wrapper @lovable.dev/vite-tanstack-config) com alvo Node.
// Reproduz só o essencial do wrapper, na mesma ordem de plugins:
//   tailwindcss → tsConfigPaths → tanstackStart → nitro (build) → viteReact
// Diferenças intencionais:
//   - preset nitro "node-server" (o wrapper usava cloudflare-module) →
//     `npm run build` gera .output/server/index.mjs, executável com
//     `node .output/server/index.mjs` (respeita a env PORT).
//   - sem telemetria/loggers Lovable, sem plugins de sandbox.
// O alias "@" → ./src vem do tsConfigPaths (tsconfig.json → paths).
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";

export default defineConfig(({ command }) => ({
  server: { port: 8080 }, // preserva a porta dev do wrapper
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
    ...(command === "build" ? [nitro({ preset: "node-server" })] : []),
    viteReact(),
  ],
}));
