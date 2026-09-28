import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { fetchSavedCardState, type SavedCardState } from '@/lib/saved-card-state';

/**
 * The signed-in user's saved card as the SERVER resolves it — the same answer
 * checkout uses — rather than `profile.has_payment_method`, which is only a
 * cache and was true for accounts with no Stripe Customer at all.
 *
 * `null` while the first answer is in flight. Re-asks whenever the screen regains
 * focus (Add / Update / Remove card are separate screens) and when the cached flag
 * changes, so removing the last card is reflected straight away.
 */
export function useSavedCard(userId: string | undefined, flag: boolean | undefined): SavedCardState | null {
  const [card, setCard] = useState<SavedCardState | null>(null);

  const load = useCallback(() => {
    if (!userId) { setCard({ state: 'none' }); return () => {}; }
    let live = true;
    fetchSavedCardState().then((s) => { if (live) setCard(s); });
    return () => { live = false; };
  }, [userId]);

  useFocusEffect(load);
  useEffect(() => load(), [load, flag]);

  return card;
}
