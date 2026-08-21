import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();

  // O prefixo de publicação NÃO é definido aqui: o TanStack Start o deriva do
  // `base` do Vite (`deriveRouterBasepath`) e o aplica com `router.update()`,
  // sobrescrevendo qualquer `basepath` passado neste ponto. Quem manda é a
  // variável BASE_PATH do build — ver vite.config.ts.
  return createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });
};
