/**
 * QueryClient singleton and the me query key.
 *
 * Lives in its own module so that api.ts can import the client without
 * creating a circular dependency. The dependency graph is:
 *
 *   query-client.ts  (no imports from this SPA)
 *       ^--- api.ts  (imports queryClient + ME_QUERY_KEY)
 *       ^--- auth.ts (imports ME_QUERY_KEY)
 *       ^--- main.tsx (imports queryClient to pass to QueryClientProvider)
 *
 * Previously ME_QUERY_KEY lived in auth.ts and queryClient was defined in
 * main.tsx. Moving both here breaks the cycle that would otherwise form
 * when api.ts needs to reach the client.
 */
import { QueryClient } from "@tanstack/react-query";

export const ME_QUERY_KEY = ["auth", "me"] as const;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 30_000,
    },
  },
});
