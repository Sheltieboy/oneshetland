/**
 * rpc-exposure.node.test.ts — privileged RPCs must not be reachable with the
 * public anon key.
 *
 * WHY THIS TEST EXISTS
 * Six SECURITY DEFINER functions were callable by anyone holding the anon key,
 * which every copy of the app and every visitor to the website has. Four of
 * them take the acting identity as a PARAMETER rather than reading auth.uid(),
 * so the authorisation performed by the edge functions above them could simply
 * be walked around. Migration 20260819120000_lock_privileged_rpcs.sql closed
 * them.
 *
 * WHY IT TESTS OVER HTTP RATHER THAN INSPECTING GRANTS
 * This exercises the boundary that actually matters — internet → anon key →
 * PostgREST → function — using only public values. It needs no database
 * credentials, so it can run anywhere, and it cannot be fooled by a grant that
 * looks right but is defeated by a residual PUBLIC EXECUTE (which is exactly
 * how the earlier wallet lock failed; see KNOWN_EXPOSED below).
 *
 * SAFETY
 * Every probe uses the all-zero UUID and zero amounts. If a function were
 * reachable, it would hit a foreign-key violation or update no rows. Nothing
 * here can mutate real data. Functions that cannot be probed harmlessly are
 * deliberately not called — see KNOWN_EXPOSED.
 *
 * Run: npm test
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NIL = '00000000-0000-0000-0000-000000000000';

/** Read EXPO_PUBLIC_* from the environment, falling back to the repo .env. */
function publicConfig(): { url: string; anonKey: string } | null {
  let url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  let anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !anonKey) {
    try {
      const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)\s*=\s*(.+)\s*$/);
        if (!m) continue;
        const value = m[2].trim().replace(/^["']|["']$/g, '');
        if (m[1].endsWith('URL')) url ||= value; else anonKey ||= value;
      }
    } catch { /* no .env — handled by the skip below */ }
  }
  return url && anonKey ? { url, anonKey } : null;
}

const cfg = publicConfig();

/** POST to /rest/v1/rpc/<fn> as anon. Returns the status and PostgREST message. */
async function callAsAnon(fn: string, body: unknown): Promise<{ status: number; message: string }> {
  const res = await fetch(`${cfg!.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: cfg!.anonKey,
      Authorization: `Bearer ${cfg!.anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  let message = '';
  try { message = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* empty body */ }
  return { status: res.status, message };
}

/**
 * Must be service-role only. Anon reaching any of these is a launch blocker.
 * Arguments are harmless: nil UUIDs and zero amounts.
 */
const MUST_BE_LOCKED: Array<{ fn: string; body: Record<string, unknown>; why: string }> = [
  {
    fn: 'validate_and_checkin_ticket',
    body: { p_raw_token: 'probe', p_event_id: NIL, p_scanner_id: NIL },
    why: 'burns a ticket and returns attendee PII, with a caller-supplied scanner id',
  },
  {
    fn: 'validate_and_checkin_ticket_by_id',
    body: { p_ticket_id: NIL, p_event_id: NIL, p_scanner_id: NIL },
    why: 'same, addressed by ticket id',
  },
  {
    fn: 'validate_backup_code',
    body: { p_backup_code: 'PROBE-PROBE', p_event_id: NIL, p_scanner_id: NIL },
    why: 'looks a ticket up across ALL events by a short human-readable code',
  },
  {
    fn: 'activate_hub_membership',
    body: { p_hub: NIL, p_user: NIL, p_type: NIL, p_period: 'year', p_payment_pence: 0, p_pi: null },
    why: 'grants a paid hub membership with no payment and no authorisation',
  },
  {
    fn: 'record_hub_donation',
    body: {
      p_campaign: NIL, p_hub: NIL, p_user: NIL, p_amount: 0, p_fee: 0, p_message: null,
      p_anon: true, p_pi: null, p_gift_aid: false, p_title: null, p_first: null,
      p_last: null, p_address: null, p_postcode: null,
    },
    why: 'writes donations and Gift Aid declarations that never happened',
  },
  {
    fn: 'increment_event_tickets_sold',
    body: { p_event_id: NIL, p_count: 0 },
    why: 'sets any event public sold counter to any value',
  },
];

/**
 * Found during Step 1 remediation and NOT yet fixed — awaiting authorisation.
 *
 * Migration 20260623010000 revoked wallet_credit/wallet_debit from `anon,
 * authenticated` but not from PUBLIC, so the residual `=X/postgres` grant left
 * both roles able to execute. The lock has been ineffective since June 2026.
 *
 * Probes below are no-ops even if they land: crediting 0 to a nonexistent user
 * violates a foreign key; debiting 0 from a nonexistent user updates no rows.
 *
 * Two further functions are exposed the same way but are deliberately NOT
 * probed because they cannot be called harmlessly:
 *   • purge_old_job_applications()  — deletes rows
 *   • _apply_vessel_edit(record)    — writes vessel data
 *
 * When these are fixed, move them into MUST_BE_LOCKED.
 */
const KNOWN_EXPOSED: Array<{ fn: string; body: Record<string, unknown>; why: string }> = [
  { fn: 'wallet_credit', body: { p_user: NIL, p_amount: 0 }, why: 'mints wallet balance for any user' },
  { fn: 'wallet_debit', body: { p_user: NIL, p_spend: 0, p_cashback: 0 }, why: 'drains any user wallet balance' },
];

before(() => {
  if (!cfg) {
    throw new Error(
      'Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (or provide a .env) to run the RPC exposure test.',
    );
  }
});

for (const { fn, body, why } of MUST_BE_LOCKED) {
  test(`anon cannot execute ${fn} — ${why}`, async () => {
    const { status, message } = await callAsAnon(fn, body);

    // 404 means PostgREST could not find that name+signature. That is NOT a
    // pass: it usually means the signature drifted and the probe stopped
    // testing anything. Fail loudly so the probe gets repaired.
    assert.notEqual(
      status, 404,
      `${fn}: PostgREST returned 404 — the signature in this test no longer matches the function. ` +
      `Repair the probe; do not assume the function is safe.`,
    );

    assert.equal(
      status, 401,
      `SECURITY REGRESSION: ${fn} answered the public anon key with HTTP ${status} ` +
      `(expected 401). This function ${why}. Re-apply the revoke from public, anon AND authenticated.`,
    );
    assert.match(
      message, /permission denied/i,
      `SECURITY REGRESSION: ${fn} returned 401 but not a permission error (${message}).`,
    );
  });
}

test('report: privileged RPCs still reachable with the anon key', async () => {
  const stillOpen: string[] = [];
  for (const { fn, body, why } of KNOWN_EXPOSED) {
    const { status } = await callAsAnon(fn, body);
    if (status !== 401) stillOpen.push(`${fn} (HTTP ${status}) — ${why}`);
  }

  if (stillOpen.length > 0) {
    console.warn(
      `\n${'='.repeat(72)}\n` +
      `  OPEN SECURITY FINDING — ${stillOpen.length} privileged RPC(s) reachable by anon\n` +
      `${'='.repeat(72)}\n` +
      stillOpen.map((s) => `  ⚠  ${s}`).join('\n') +
      `\n\n  Cause: their revoke named "anon, authenticated" but not PUBLIC, so the\n` +
      `  residual =X/postgres grant still applies. A revoke must name all three:\n` +
      `      revoke all on function public.<name>(<signature>)\n` +
      `        from public, anon, authenticated;\n` +
      `  Also exposed and not probed here (cannot be called harmlessly):\n` +
      `      purge_old_job_applications()   _apply_vessel_edit(record)\n` +
      `${'='.repeat(72)}\n`,
    );
  } else {
    console.log('  All KNOWN_EXPOSED functions are now locked — move them into MUST_BE_LOCKED.');
  }

  // Deliberately not an assertion: these are a reported finding awaiting
  // authorisation, not an accidental regression. MUST_BE_LOCKED above is what
  // fails the build.
});
