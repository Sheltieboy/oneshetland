/**
 * scripts/test-safety/env.mjs — the environment every test lane starts its tests in (Fetch v2, Step 13).
 *
 * Built from an allow-list, not inherited: Supabase, Stripe, Expo, Google and database variables in the developer's shell never reach a
 * test. The guard is loaded into every test process and every child through NODE_OPTIONS.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'guard.mjs');
const KEEP = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_[A-Z]+|TERM|COLORTERM|NO_COLOR|FORCE_COLOR|CI|FETCH_WEB_ROOT|ISOLATED_ONLY)$/;

export function cleanEnv(lane, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (KEEP.test(k) && v !== undefined) env[k] = v;
  // Offline/isolated lanes get a placeholder CLI token, so even an unguarded CLI could not authenticate. The opt-in read-only lane
  // needs the developer's own CLI login (keychain) for `supabase db query --linked`, so it gets none.
  const token = lane === 'production-readonly' ? {} : { SUPABASE_ACCESS_TOKEN: 'invalid-offline-run' };
  return { ...env, ONESHETLAND_TEST_LANE: lane, NODE_OPTIONS: `--import=${GUARD}`, ...token, ...extra };
}
