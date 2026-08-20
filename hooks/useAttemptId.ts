import { useEffect, useRef } from 'react';
import { newCheckoutAttemptId } from '@/lib/checkout-attempt';

/**
 * One payment reference per logical purchase, minted where the customer commits.
 *
 * WHY IT LIVES IN THE SCREEN AND NOT IN THE API HELPER
 *
 * lib/local-api.ts used to mint its own id inside payWithWallet(), on every
 * call. That covers a dropped connection retried by the HTTP layer — same body,
 * same id — but not the case that actually happens, which is somebody tapping
 * "Pay" twice. The second tap re-entered the function, minted a fresh id, and
 * the server had no way to know it was the same purchase.
 *
 * So the id is held across renders for as long as the purchase is the same:
 *
 *   first tap → mint, remember
 *   retry     → the SAME id, so the server resolves it to the first attempt
 *   change the amount, the tier, the item → a different purchase, a new id
 *
 * The id comes from expo-crypto via newCheckoutAttemptId(), which fails loudly
 * rather than falling back to Math.random — a guessable payment reference is
 * one somebody else can collide with.
 *
 * @param resetKey Anything that means "this is now a different purchase".
 */
export function useAttemptId(resetKey: unknown): () => string {
  const ref = useRef<string | null>(null);

  useEffect(() => {
    ref.current = null;
  }, [resetKey]);

  // Lazy, so opening a screen and backing out does not burn references.
  return () => {
    if (!ref.current) ref.current = newCheckoutAttemptId();
    return ref.current;
  };
}
