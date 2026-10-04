/**
 * lib/discovery-fixtures.ts — which records are test / acceptance fixtures, for an ADMINISTRATOR's app.
 *
 * The database withholds listed fixtures (ZZ TEST …, the Anderson & Co demo seed) from everyone except administrators and
 * the fixture's owner. An administrator therefore sees them mixed in with genuine content, so every discovery surface
 * marks them with <TestBadge/> ("TEST · ADMIN ONLY").
 *
 * The ids come from admin_discovery_fixture_ids(): the same explicit list that hides them publicly — never a name
 * pattern. It returns rows ONLY for an administrator; for anyone else it returns nothing (and refuses a signed-out
 * caller), so the public never learns which records are tests, and the set below is simply empty for them.
 */
import { useEffect, useState } from 'react';
import { supabase } from './supabase';
import { useAuth } from '@/context/AuthContext';

export interface FixtureIds { business: ReadonlySet<string>; hub: ReadonlySet<string> }
export const NO_FIXTURES: FixtureIds = { business: new Set(), hub: new Set() };

let cache: { uid: string; at: number; ids: FixtureIds } | null = null;
let inflight: { uid: string; p: Promise<FixtureIds> } | null = null;
const TTL_MS = 5 * 60_000;

/** Never throws: any failure (signed out, offline, function missing) is "no fixtures to label". */
export function fetchFixtureIds(userId: string | null | undefined): Promise<FixtureIds> {
  if (!userId) return Promise.resolve(NO_FIXTURES);
  if (cache && cache.uid === userId && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.ids);
  if (inflight && inflight.uid === userId) return inflight.p;     // many rows asking at once share one request
  const p = (async (): Promise<FixtureIds> => {
    try {
      const { data, error } = await supabase.rpc('admin_discovery_fixture_ids');
      if (error || !Array.isArray(data)) return NO_FIXTURES;
      const business = new Set<string>(); const hub = new Set<string>();
      for (const r of data as { entity: string; entity_id: string }[]) (r.entity === 'hub' ? hub : business).add(r.entity_id);
      const ids = { business, hub };
      cache = { uid: userId, at: Date.now(), ids };
      return ids;
    } catch { return NO_FIXTURES; }
    finally { inflight = null; }
  })();
  inflight = { uid: userId, p };
  return p;
}

/** For screens: the fixture ids for the current person (empty for everyone but an administrator). */
export function useFixtureIds(): FixtureIds {
  const { profile } = useAuth();
  const [ids, setIds] = useState<FixtureIds>(NO_FIXTURES);
  useEffect(() => {
    let alive = true;
    void fetchFixtureIds(profile?.id).then((v) => { if (alive) setIds(v); });
    return () => { alive = false; };
  }, [profile?.id]);
  return ids;
}
