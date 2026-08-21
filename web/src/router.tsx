import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { basepathAtual } from "./lib/basepath";

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    // Onde a aplicação está publicada — raiz no servidor próprio, subpasta no
    // GitHub Pages. Ver src/lib/basepath.ts.
    basepath: basepathAtual(),
  });

  return router;
};
