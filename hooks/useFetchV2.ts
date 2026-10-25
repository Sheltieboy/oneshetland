/**
 * hooks/useFetchV2.ts — Fetch v2 screen plumbing (Step 12).
 *
 * useFetchAccess  asks the server flag (fetch_v2_enabled) every time a Fetch screen comes into view. It fails closed: no answer, an error
 *                 or false all mean "coming soon". There is no local flag.
 * useFetchLoad    loads a screen's data through lib/fetch-api.ts, reloads when the screen regains focus or the app comes back to the
 *                 foreground, and polls while it is in view (no table subscriptions — the same safe approach as the website). If the
 *                 server says Fetch is no longer for this member, the screen leaves Fetch for the Fetch home, which shows why.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import type { FetchResult } from '@/lib/fetch-api';
import { FETCH_HOME, accessFrom, lostAccess, type Access } from '@/lib/fetch/mobile';

export function useFetchAccess(enabled = true): { access: Access; recheck: () => void } {
  const [access, setAccess] = useState<Access>('checking');
  const check = useCallback(() => {
    if (!enabled) { setAccess('off'); return; }
    supabase.rpc('fetch_v2_enabled').then((r) => setAccess(accessFrom(r)), () => setAccess('off'));
  }, [enabled]);
  useFocusEffect(check);
  return { access, recheck: check };
}

export function useFetchLoad<T>(load: () => Promise<FetchResult<T>>, opts: { pollMs?: number } = {}) {
  const router = useRouter();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    const r = await loadRef.current().catch(() => null);
    setLoading(false);
    if (!r) { setError({ code: 'server_error', message: "We couldn't reach OneShetland. Pull down to try again." }); return; }
    if (!r.ok) {
      setError({ code: r.code, message: r.message });
      if (lostAccess(r.code)) router.replace(FETCH_HOME as never);
      return;
    }
    setError(null); setData(r.data);
  }, [router]);

  useFocusEffect(useCallback(() => {
    refresh();
    if (!opts.pollMs) return undefined;
    const t = setInterval(() => { if (AppState.currentState === 'active') refresh(); }, opts.pollMs);
    return () => clearInterval(t);
  }, [refresh, opts.pollMs]));

  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') refresh(); });
    return () => sub.remove();
  }, [refresh]);

  return { data, error, loading, refresh };
}
