/**
 * rpc-exposure.node.test.ts — server-only RPCs must not be reachable with the
 * public anon key.
 *
 * WHY THIS TEST EXISTS
 * Two separate migrations set out to make privileged SECURITY DEFINER functions
 * service-role only, and both silently failed for the same reason: a Postgres
 * function ACL carries a leading `=X/owner`, an EXECUTE grant to PUBLIC, and a
 * revoke that names only some roles leaves the rest reachable.
 *
 *   20260623010000  revoked wallet_credit/wallet_debit from `anon,
 *                   authenticated` but not PUBLIC → both roles kept EXECUTE
 *                   through PUBLIC. The wallet was mintable by anyone from June
 *                   to August 2026 while everyone believed it was locked.
 *   others          revoked from `public` but left the explicit `anon` grant
 *                   in place → anon kept its own entry.
 *
 * A revoke must name all three: `from public, anon, authenticated`.
 *
 * Reading the migration does not tell you whether it worked. This test asks the
 * live system instead, over the same path an attacker would use.
 *
 * WHY IT TESTS OVER HTTP RATHER THAN INSPECTING GRANTS
 * internet → anon key → PostgREST → function is the boundary that matters, and
 * it needs only public values, so this runs anywhere. It cannot be fooled by a
 * grant that reads correctly but is defeated by a residual PUBLIC.
 *
 * SAFETY
 * Every probe uses the all-zero UUID, zero amounts, or a bound that matches
 * nothing. If a function were reachable it would raise a foreign-key error or
 * touch no rows. Two notes on the deliberately awkward ones:
 *   • purge_old_job_applications() takes no arguments, so it cannot be made a
 *     no-op by argument choice. It only deletes declined/withdrawn applications
 *     older than six months — i.e. exactly what its scheduled job is meant to
 *     delete — so an accidental execution does no damage a cron run would not.
 *   • expire_stale_ticket_orders is probed with a 1000-year threshold, which
 *     matches nothing.
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
 * THE DEFINITIVE LIST of server-only RPCs.
 *
 * Every one of these is SECURITY DEFINER, performs no authorisation of its own,
 * and has no client call site in either oneshetland-delivers or
 * oneshetland-web. Each is reached only by an edge function holding the service
 * role, or by another SECURITY DEFINER function via the owner grant.
 *
 * Anon reaching ANY of them is a launch blocker. Add to this list whenever a
 * new privileged function ships.
 */
const SERVER_ONLY: Array<{ fn: string; body: Record<string, unknown>; why: string }> = [
  // ── The money ─────────────────────────────────────────────────────────────
  { fn: 'wallet_credit', body: { p_user: NIL, p_amount: 0 },
    why: 'adds any amount to any user balance — a minting primitive' },
  { fn: 'wallet_debit', body: { p_user: NIL, p_spend: 0, p_cashback: 0 },
    why: 'drains any user balance, and mints via p_cashback when p_spend is 0' },
  { fn: 'wallet_topup', body: { p_user: NIL, p_amount: 0, p_pi: 'probe-not-a-real-intent' },
    why: 'credits a balance and writes the ledger row that claims a payment' },

  // ── Tickets ───────────────────────────────────────────────────────────────
  { fn: 'validate_and_checkin_ticket', body: { p_raw_token: 'probe', p_event_id: NIL, p_scanner_id: NIL },
    why: 'burns a ticket and returns attendee PII, with a caller-supplied scanner id' },
  { fn: 'validate_and_checkin_ticket_by_id', body: { p_ticket_id: NIL, p_event_id: NIL, p_scanner_id: NIL },
    why: 'same, addressed by ticket id' },
  { fn: 'validate_backup_code', body: { p_backup_code: 'PROBE-PROBE', p_event_id: NIL, p_scanner_id: NIL },
    why: 'looks a ticket up across ALL events by a short human-readable code' },
  { fn: 'increment_event_tickets_sold', body: { p_event_id: NIL, p_count: 0 },
    why: 'sets any event public sold counter to any value' },
  { fn: 'expire_stale_ticket_orders', body: { p_older_than_minutes: 525_600_000 },
    why: 'cancels pending orders and releases their held capacity' },

  // ── Hubs ──────────────────────────────────────────────────────────────────
  { fn: 'activate_hub_membership',
    body: { p_hub: NIL, p_user: NIL, p_type: NIL, p_period: 'year', p_payment_pence: 0, p_pi: null },
    why: 'grants a paid hub membership with no payment and no authorisation' },
  { fn: 'record_hub_donation',
    body: {
      p_campaign: NIL, p_hub: NIL, p_user: NIL, p_amount: 0, p_fee: 0, p_message: null,
      p_anon: true, p_pi: null, p_gift_aid: false, p_title: null, p_first: null,
      p_last: null, p_address: null, p_postcode: null,
    },
    why: 'writes donations and Gift Aid declarations that never happened' },

  // ── Stock ─────────────────────────────────────────────────────────────────
  { fn: 'reserve_product_stock', body: { p_product: NIL, p_variant: NIL, p_qty: 0 },
    why: 'holds inventory without an order behind it' },
  { fn: 'commit_product_stock', body: { p_product: NIL, p_variant: NIL, p_qty: 0 },
    why: 'converts a hold into a sale' },
  { fn: 'release_product_stock', body: { p_product: NIL, p_variant: NIL, p_qty: 0 },
    why: 'releases someone else inventory hold' },

  // ── Maintenance / internal ────────────────────────────────────────────────
  { fn: 'purge_old_job_applications', body: {},
    why: 'destructive maintenance — deletes job applications' },
  { fn: '_apply_vessel_edit', body: { p: null },
    why: 'applies a vessel edit proposal without checking who asked' },
  { fn: 'bookings_due_metering', body: { p_cap: 0 },
    why: 'drives the per-booking billing run' },
];

before(() => {
  if (!cfg) {
    throw new Error(
      'Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (or provide a .env) to run the RPC exposure test.',
    );
  }
});

for (const { fn, body, why } of SERVER_ONLY) {
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
      `SECURITY REGRESSION: ${fn} answered the public anon key with HTTP ${status} (expected 401). ` +
      `This function ${why}. Fix with:\n` +
      `    revoke all on function public.${fn}(<signature>) from public, anon, authenticated;\n` +
      `    grant execute on function public.${fn}(<signature>) to service_role;\n` +
      `  Naming fewer than all three roles is what caused this bug twice before.`,
    );
    assert.match(
      message, /permission denied/i,
      `SECURITY REGRESSION: ${fn} returned 401 but not a permission error (${message}).`,
    );
  });
}

/**
 * Functions that LOOK server-only but genuinely need client-role execution.
 * Documented so nobody "tidies them up" into the list above and takes
 * production down.
 *
 *   analytics_emit  — ten of the twelve analytics triggers that call it
 *                     (tg_ae_booking, tg_ae_donation, tg_ae_event_tickets,
 *                     tg_ae_wallet, …) are SECURITY INVOKER, so they run as
 *                     whoever fired them. Revoking it makes those triggers
 *                     raise insufficient_privilege and abort the INSERT they
 *                     hang off — breaking bookings, donations, ticket sales,
 *                     gifts, unit purchases and wallet transactions. Tested.
 *                     Fix the triggers first, then revoke.
 *
 *   ensure_member_code / ensure_referral_code — called directly by both
 *                     clients (lib/member-card.ts, lib/referrals.ts and their
 *                     web counterparts), so they cannot be service-role only.
 *                     Migration 20260819160000 pinned the uuid signatures to
 *                     auth.uid() and added no-argument versions; anon is
 *                     revoked from all four. Identity binding is covered by
 *                     supabase/tests/identity-binding.node.test.ts.
 */
const CLIENT_CALLABLE_BY_DESIGN = [
  'analytics_emit        — SECURITY INVOKER triggers call it; revoking breaks INSERTs',
  'ensure_member_code    — both clients call it; pinned to auth.uid() in 20260819160000',
  'ensure_referral_code  — both clients call it; pinned to auth.uid() in 20260819160000',
];

test('server-only list excludes the functions that need client execution', () => {
  // Deliberately no network call. analytics_emit would write an analytics row,
  // and ensure_member_code loops until its UPDATE matches, which never happens
  // for a nil user. Probing them is worse than documenting them.
  for (const entry of CLIENT_CALLABLE_BY_DESIGN) {
    const name = entry.split(/\s+/)[0];
    assert.ok(
      !SERVER_ONLY.some((s) => s.fn === name),
      `${name} is in SERVER_ONLY but is called by client code or by a SECURITY INVOKER ` +
      `trigger. Revoking it will break production — see the comment above this test.`,
    );
  }
  console.log(
    `\n  Client-callable by design — do NOT add these to SERVER_ONLY:\n` +
    CLIENT_CALLABLE_BY_DESIGN.map((e) => `    ${e}`).join('\n') + '\n',
  );
});
