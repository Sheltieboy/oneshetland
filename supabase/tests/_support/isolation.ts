/**
 * isolation.ts — fail-closed guards for every Notices & Alerts acceptance lane.
 *
 * An acceptance test may talk ONLY to the throwaway local backend (loopback host). Anything that names the production Supabase project, a hosted Supabase
 * domain or the live website is refused BEFORE a request is made, and a checkout that is linked to a hosted Supabase project (supabase/.temp/project-ref)
 * is refused outright, because `supabase db query --linked` would then reach it.
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_MARKERS = ['nkrtmakxygkvxuxriiil', 'supabase.co', 'supabase.com', 'oneshetland.com'];
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function assertIsolatedUrl(label: string, raw: string): void {
  let host = '';
  try { host = new URL(raw).hostname.toLowerCase(); } catch { throw new Error(`ISOLATION: ${label} is not a valid URL (${raw.slice(0, 40)}); refusing to run`); }
  if (!LOOPBACK.has(host)) throw new Error(`ISOLATION: ${label} points at ${host}, not the local acceptance backend; refusing to run`);
  const bad = PRODUCTION_MARKERS.find((m) => raw.toLowerCase().includes(m));
  if (bad) throw new Error(`ISOLATION: ${label} contains "${bad}"; refusing to run`);
}

/** No environment value may name production or a hosted service (a stray EXPO_PUBLIC_/NEXT_PUBLIC_ variable would otherwise be picked up by a helper). */
export function assertNoProductionEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [k, v] of Object.entries(env)) {
    if (!v || !/(SUPABASE|SITE|URL|HOST|DSN|DATABASE)/i.test(k)) continue;
    const bad = PRODUCTION_MARKERS.find((m) => v.toLowerCase().includes(m));
    if (bad) throw new Error(`ISOLATION: environment variable ${k} names "${bad}"; unset it before running an acceptance lane`);
  }
}

/** A checkout linked to a hosted project can reach it through `supabase ... --linked`. */
export function assertNotLinked(root = ROOT): void {
  for (const f of ['supabase/.temp/project-ref', 'supabase/.temp/linked-project.json'])
    if (existsSync(join(root, f))) throw new Error(`ISOLATION: ${f} exists, so this checkout is linked to a hosted Supabase project; remove it before running an acceptance lane`);
}

export function assertIsolated(urls: Record<string, string>): void {
  assertNoProductionEnv(); assertNotLinked();
  for (const [k, v] of Object.entries(urls)) assertIsolatedUrl(k, v);
}
