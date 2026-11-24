/**
 * Auth query hooks.
 *
 * The single source of truth for the current session in the SPA.
 * Any component that needs to know if the user is signed in calls useMe().
 * 401 from /auth/me is not an error - it means not authenticated.
 *
 * ME_QUERY_KEY lives in query-client.ts so that api.ts can reference it
 * without creating a circular dependency.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchMe, postLogin, postLogout } from "./api.js";
import { ME_QUERY_KEY } from "./query-client.js";

/** Returns the signed-in user. data is undefined while loading or when signed out. */
export function useMe() {
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
    retry: false,
    // Treat a 401 (thrown by fetchMe) as a normal "not authenticated" state.
    // The component checks isError with status=401 vs an actual network error.
    throwOnError: false,
  });
}

/** Send a magic link request. */
export function useLogin() {
  return useMutation({
    mutationFn: (email: string) => postLogin(email),
  });
}

/** Log out: call /auth/logout and remove the me query entry. */
export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postLogout,
    onSuccess: () => {
      // removeQueries drops the entry entirely so getQueryData returns undefined.
      // setQueryData(key, undefined) does not clear the entry in TanStack Query v5;
      // invalidateQueries alone only marks stale and triggers a background refetch.
      // The hard reload that follows destroys the cache anyway, but this call
      // now does what it appears to do rather than relying on the reload to cover it.
      qc.removeQueries({ queryKey: ME_QUERY_KEY });
    },
  });
}
