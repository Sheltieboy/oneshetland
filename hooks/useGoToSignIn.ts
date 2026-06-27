import { useRouter, usePathname } from 'expo-router';

/**
 * Returns a function that sends the user to sign-in, remembering where they are
 * so they land back on this screen after signing in (instead of Home).
 *
 *   const goToSignIn = useGoToSignIn();
 *   ...
 *   if (!profile) { goToSignIn(); return; }            // returns to current screen
 *   if (!profile) { goToSignIn(`/local-business-detail?id=${id}`); return; }  // explicit
 *
 * Pass an explicit `next` when the current pathname alone can't restore the
 * screen (e.g. a screen that needs a query string like ?id=…). Otherwise the
 * current pathname is used.
 */
export function useGoToSignIn() {
  const router = useRouter();
  const pathname = usePathname();
  return (next?: string) =>
    router.push({ pathname: '/(auth)/sign-in', params: { next: next ?? pathname } });
}
