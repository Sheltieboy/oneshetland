/**
 * saved-card-reconcile.node.test.ts
 *
 * THE INCONSISTENCY (24 Sep 2026)
 *
 * 4 of the 6 profiles with has_payment_method = true had NO Stripe Customer bound.
 * Checkout (canonical) said "no saved card"; Account said "card added" from the flag.
 *
 * THE FIX, AND WHAT THIS FILE PINS
 *
 *   - reconcileSavedCard repairs one profile: recovers a Customer ONLY on proof of
 *     ownership (Stripe metadata supabase_user_id, exactly one, not held elsewhere),
 *     through the EXISTING claim/settle functions; otherwise clears the stale flag
 *     and creates nothing. Never by email. Never on a Stripe outage.
 *   - the flag follows the attached cards: cards → true, none → false
 *   - the scheduled function fails closed and returns only masked output
 *   - the database refuses a flag with no bound Customer (migration), and every
 *     writer of the flag derives it from what Stripe holds
 *
 * Runs the real library and the real Edge Function source against a fake Stripe and a
 * fake database. SAFETY: no network to Stripe, no write to any real database. The live
 * checks are read-only SELECTs through the Supabase CLI and skip when it is unavailable.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';
import * as Reconcile from '../functions/_shared/saved-card-reconcile.ts';
import * as CronAuth from '../functions/_shared/cron-auth.ts';
import * as SafeError from '../functions/_shared/safe-error.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*)(?!\*).*$/gm, '');

const U = '11111111-2222-3333-4444-555555555555';
const OTHER_USER = '99999999-8888-7777-6666-555555555555';
const CUS = 'cus_RECOVERABLE1';
const SECRET = 'cron-test-secret';

let denoSecret: string | undefined = SECRET;
(globalThis as any).Deno = {
  env: {
    get: (k: string) => k === 'CRON_SECRET' ? denoSecret
      : ({ STRIPE_SECRET_KEY: 'sk_test_FAKE', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'SERVICE' } as Record<string, string>)[k],
  },
};

/* ── fakes ─────────────────────────────────────────────────────────────── */

type StripeCfg = {
  search?: { id: string; deleted?: boolean; metadata?: Record<string, string> }[] | 'error';
  cards?: Record<string, { id: string }[] | 'error'>;
};

function fakeStripe(cfg: StripeCfg = {}) {
  const calls: { method: string; url: string }[] = [];
  const impl = async (url: string, init: any = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase();
    calls.push({ method, url: String(url) });
    const respond = (status: number, json: unknown) => ({ ok: status < 400, status, json: async () => json });
    const u = new URL(String(url));
    if (method === 'GET' && u.pathname.endsWith('/customers/search')) {
      if (cfg.search === 'error') return respond(500, {});
      return respond(200, { data: cfg.search ?? [] });
    }
    const m = /\/customers\/([^/]+)\/payment_methods$/.exec(u.pathname);
    if (method === 'GET' && m) {
      const c = cfg.cards?.[m[1]];
      if (c === 'error') return respond(500, {});
      return respond(200, { data: c ?? [] });
    }
    return respond(404, { error: { message: `unexpected ${method} ${u.pathname}` } });
  };
  return { impl, calls, writes: () => calls.filter((c) => c.method !== 'GET') };
}

async function withFetch<T>(stripe: ReturnType<typeof fakeStripe>, fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  (globalThis as any).fetch = stripe.impl;
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

type Tables = Record<string, { maybe?: unknown; list?: unknown[] }>;
function fakeDb(tables: Tables, rpc: Record<string, (a: any) => { data?: unknown; error?: unknown }> = {}) {
  const log = { updates: [] as { table: string; payload: any }[], rpcs: [] as { name: string; args: any }[] };
  const from = (table: string) => {
    let mode: 'select' | 'update' = 'select';
    let payload: any;
    const exec = () => (mode === 'update'
      ? (log.updates.push({ table, payload }), { data: null, error: null })
      : { data: tables[table]?.list ?? [], error: null });
    const q: any = {
      select: () => q, eq: () => q, neq: () => q, in: () => q, or: () => q, limit: () => q,
      update: (p: any) => { mode = 'update'; payload = p; return q; },
      maybeSingle: async () => ({ data: tables[table]?.maybe ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve(exec()).then(res, rej),
    };
    return q;
  };
  const rpcFn = async (name: string, args: any) => {
    log.rpcs.push({ name, args });
    return rpc[name]?.(args) ?? { data: null, error: null };
  };
  return { from, rpc: rpcFn, log };
}

const claimed = () => ({ data: [{ outcome: 'claimed', stripe_customer_id: null }] });
const settled = () => ({ data: { ok: true } });
const run = (db: any, stripe: ReturnType<typeof fakeStripe>, extra: Record<string, unknown> = {}) =>
  withFetch(stripe, () => Reconcile.reconcileSavedCard({ supabase: db, stripeKey: 'k', userId: U, ...extra }));
const flagWrites = (db: ReturnType<typeof fakeDb>) => db.log.updates.filter((u) => u.table === 'profiles').map((u) => u.payload.has_payment_method);
const profileRow = (flag: boolean, customer: string | null = null) => ({ has_payment_method: flag, stripe_customer_id: customer });

/* ── 1. the stale flag: nothing provable behind it ─────────────────────── */

describe('a flag with no bound customer', () => {
  test('and no provable Stripe customer → the stale flag is CLEARED, and nothing is created or copied', async () => {
    const stripe = fakeStripe({ search: [] });
    const db = fakeDb({ profiles: { maybe: profileRow(true) } });
    const r = await run(db, stripe);
    assert.equal(r.action, 'flag_cleared');
    assert.equal(r.customer, 'none');
    assert.deepEqual(flagWrites(db), [false]);
    assert.equal(stripe.writes().length, 0, 'no Stripe write of any kind — no customer created, no payment method touched');
    assert.equal(db.log.rpcs.length, 0, 'nothing is claimed for a customer that does not exist');
  });

  test('a flag that was already false with nothing behind it is left alone', async () => {
    const db = fakeDb({ profiles: { maybe: profileRow(false) } });
    const r = await run(db, fakeStripe({ search: [] }));
    assert.equal(r.action, 'consistent');
    assert.equal(db.log.updates.length, 0);
  });

  test('a customer that provably belongs to the user is RECOVERED through the canonical claim/settle — not duplicated', async () => {
    const stripe = fakeStripe({ search: [{ id: CUS, metadata: { supabase_user_id: U } }], cards: { [CUS]: [{ id: 'pm_1' }] } });
    const db = fakeDb({ profiles: { maybe: profileRow(true) } }, { claim_stripe_customer: claimed, settle_stripe_customer: settled });
    const r = await run(db, stripe);
    assert.equal(r.action, 'recovered');
    assert.equal(r.customer, 'recovered');
    assert.deepEqual(db.log.rpcs.map((x) => x.name), ['claim_stripe_customer', 'settle_stripe_customer']);
    assert.deepEqual(db.log.rpcs[1].args, { p_user: U, p_customer: CUS });
    assert.deepEqual(flagWrites(db), [], 'flag already true and a card exists → nothing to change');
    assert.equal(stripe.writes().length, 0, 'no second Customer was created');
  });

  test('recovered with NO card attached → bound, and the flag is cleared (there is nothing to pay with)', async () => {
    const stripe = fakeStripe({ search: [{ id: CUS, metadata: { supabase_user_id: U } }], cards: { [CUS]: [] } });
    const db = fakeDb({ profiles: { maybe: profileRow(true) } }, { claim_stripe_customer: claimed, settle_stripe_customer: settled });
    const r = await run(db, stripe);
    assert.equal(r.customer, 'recovered');
    assert.equal(r.flag_after, false);
    assert.deepEqual(flagWrites(db), [false]);
  });

  test('ownership must be PROVEN: wrong metadata, a deleted customer, or several matches are never bound', async () => {
    const cases: [string, StripeCfg, string][] = [
      ['metadata names another user', { search: [{ id: CUS, metadata: { supabase_user_id: OTHER_USER } }] }, 'none'],
      ['no metadata at all', { search: [{ id: CUS, metadata: {} }] }, 'none'],
      ['deleted customer', { search: [{ id: CUS, deleted: true, metadata: { supabase_user_id: U } }] }, 'none'],
      ['two customers claim the same user', { search: [{ id: 'cus_A', metadata: { supabase_user_id: U } }, { id: 'cus_B', metadata: { supabase_user_id: U } }] }, 'ambiguous'],
    ];
    for (const [label, cfg, expected] of cases) {
      const stripe = fakeStripe(cfg);
      const db = fakeDb({ profiles: { maybe: profileRow(true) } }, { claim_stripe_customer: claimed, settle_stripe_customer: settled });
      const r = await run(db, stripe);
      assert.equal(r.customer, expected, label);
      assert.equal(r.action, 'flag_cleared', label);
      assert.equal(db.log.rpcs.length, 0, `${label}: nothing bound`);
      assert.deepEqual(flagWrites(db), [false], label);
    }
  });

  test('a customer already held by ANOTHER profile is not this user’s, whatever its metadata says', async () => {
    const stripe = fakeStripe({ search: [{ id: CUS, metadata: { supabase_user_id: U } }], cards: { [CUS]: [{ id: 'pm_1' }] } });
    const db = fakeDb({ profiles: { maybe: profileRow(true), list: [{ id: OTHER_USER }] } }, { claim_stripe_customer: claimed, settle_stripe_customer: settled });
    const r = await run(db, stripe);
    assert.equal(r.customer, 'none');
    assert.equal(r.action, 'flag_cleared');
    assert.equal(db.log.rpcs.length, 0);
  });

  test('canonical claim rules are respected: in-flight elsewhere, or bound to a DIFFERENT customer → not overridden', async () => {
    for (const claim of [
      () => ({ data: [{ outcome: 'in_flight', stripe_customer_id: null }] }),
      () => ({ data: [{ outcome: 'bound', stripe_customer_id: 'cus_SOMETHING_ELSE' }] }),
    ]) {
      const stripe = fakeStripe({ search: [{ id: CUS, metadata: { supabase_user_id: U } }], cards: { [CUS]: [{ id: 'pm_1' }] } });
      const db = fakeDb({ profiles: { maybe: profileRow(true) } }, { claim_stripe_customer: claim, settle_stripe_customer: settled });
      const r = await run(db, stripe);
      assert.notEqual(r.customer, 'recovered');
      assert.ok(!db.log.rpcs.some((x) => x.name === 'settle_stripe_customer'), 'never settles a customer it did not win the claim for');
    }
    // and a settle that refuses is reported failed on the claim, not swallowed
    const stripe = fakeStripe({ search: [{ id: CUS, metadata: { supabase_user_id: U } }], cards: { [CUS]: [{ id: 'pm_1' }] } });
    const db = fakeDb({ profiles: { maybe: profileRow(true) } }, {
      claim_stripe_customer: claimed,
      settle_stripe_customer: (a) => (a.p_customer ? { error: { code: '23505' } } : { data: { ok: true } }),
    });
    const r = await run(db, stripe);
    assert.notEqual(r.customer, 'recovered');
    assert.equal(db.log.rpcs.at(-1)!.args.p_error, 'reconcile could not bind a recovered customer');
  });
});

/* ── 2. the flag follows the attached cards ────────────────────────────── */

describe('with a bound customer, the flag follows Stripe', () => {
  const bound = (flag: boolean) => ({ profiles: { maybe: profileRow(flag, CUS) } });

  test('customer + card → reports added; a missing flag is set', async () => {
    const stripe = fakeStripe({ cards: { [CUS]: [{ id: 'pm_1' }] } });
    const db = fakeDb(bound(false));
    const r = await run(db, stripe);
    assert.equal(r.action, 'flag_set');
    assert.deepEqual(flagWrites(db), [true]);
    assert.equal(r.cards, 1);
  });

  test('customer + card + flag already true → consistent, no write', async () => {
    const db = fakeDb(bound(true));
    const r = await run(db, fakeStripe({ cards: { [CUS]: [{ id: 'pm_1' }] } }));
    assert.equal(r.action, 'consistent');
    assert.equal(db.log.updates.length, 0);
  });

  test('removing the LAST card clears the flag; removing one of two does not', async () => {
    const none = fakeDb(bound(true));
    assert.equal((await run(none, fakeStripe({ cards: { [CUS]: [] } }))).action, 'flag_cleared');
    assert.deepEqual(flagWrites(none), [false]);
    const one = fakeDb(bound(true));
    assert.equal((await run(one, fakeStripe({ cards: { [CUS]: [{ id: 'pm_2' }] } }))).action, 'consistent');
  });

  test('a settled claim counts as the binding even when the profile column is empty', async () => {
    const db = fakeDb({ profiles: { maybe: profileRow(true) }, stripe_customer_claims: { maybe: { stripe_customer_id: CUS, status: 'bound' } } });
    const stripe = fakeStripe({ cards: { [CUS]: [{ id: 'pm_1' }] } });
    const r = await run(db, stripe);
    assert.equal(r.customer, 'bound');
    assert.equal(stripe.calls.some((c) => c.url.includes('/search')), false, 'no search when a binding already exists');
  });
});

/* ── 3. safety ─────────────────────────────────────────────────────────── */

describe('safety', () => {
  test('a Stripe outage changes NOTHING — an unreadable answer is not "no card"', async () => {
    for (const cfg of [{ search: 'error' as const }, { cards: { [CUS]: 'error' as const } }]) {
      const bound = 'cards' in cfg;
      const db = fakeDb({ profiles: { maybe: profileRow(true, bound ? CUS : null) } });
      const r = await run(db, fakeStripe(cfg));
      assert.equal(r.action, 'skipped_unknown');
      assert.equal(db.log.updates.length, 0);
      assert.equal(r.flag_after, true);
    }
  });

  test('a dry run reports what it would do and writes nothing', async () => {
    const stripe = fakeStripe({ search: [{ id: CUS, metadata: { supabase_user_id: U } }], cards: { [CUS]: [{ id: 'pm_1' }] } });
    const db = fakeDb({ profiles: { maybe: profileRow(true) } }, { claim_stripe_customer: claimed, settle_stripe_customer: settled });
    const r = await run(db, stripe, { dryRun: true });
    assert.equal(r.customer, 'recoverable');
    assert.equal(r.action, 'recovered');
    assert.equal(db.log.updates.length, 0);
    assert.equal(db.log.rpcs.length, 0);
    const stale = fakeDb({ profiles: { maybe: profileRow(true) } });
    assert.equal((await run(stale, fakeStripe({ search: [] }), { dryRun: true })).action, 'flag_cleared');
    assert.equal(stale.log.updates.length, 0, 'even the clear is not written on a dry run');
    // …and the flag-follows-the-cards path: set-true and clear-to-false are both only reported.
    const missing = fakeDb({ profiles: { maybe: profileRow(false, CUS) } });
    assert.equal((await run(missing, fakeStripe({ cards: { [CUS]: [{ id: 'pm_1' }] } }), { dryRun: true })).action, 'flag_set');
    assert.equal(missing.log.updates.length, 0, 'a missing flag is not set on a dry run');
    const lastCard = fakeDb({ profiles: { maybe: profileRow(true, CUS) } });
    assert.equal((await run(lastCard, fakeStripe({ cards: { [CUS]: [] } }), { dryRun: true })).action, 'flag_cleared');
    assert.equal(lastCard.log.updates.length, 0, 'a removed last card is not cleared on a dry run');
  });

  test('the search is by the user’s id metadata ONLY — never by email or anything typed', async () => {
    const stripe = fakeStripe({ search: [] });
    await run(fakeDb({ profiles: { maybe: profileRow(true) } }), stripe);
    const search = stripe.calls.find((c) => c.url.includes('/customers/search'))!;
    const query = decodeURIComponent(new URL(search.url).searchParams.get('query')!);
    assert.equal(query, `metadata['supabase_user_id']:'${U}'`);
    assert.doesNotMatch(search.url, /email/i);
    // a malformed id is never interpolated into a Stripe query at all
    const bad = fakeStripe({ search: [] });
    const out = await withFetch(bad, () => Reconcile.reconcileSavedCard({ supabase: fakeDb({ profiles: { maybe: profileRow(true) } }), stripeKey: 'k', userId: "x') OR metadata['a']:'1" }));
    assert.equal(bad.calls.length, 0);
    assert.equal(out.customer, 'none');
  });

  test('outcomes are masked: first 8 characters of the id, never a customer id, payment-method id or card detail', async () => {
    const stripe = fakeStripe({ search: [{ id: CUS, metadata: { supabase_user_id: U } }], cards: { [CUS]: [{ id: 'pm_SECRETCARD' }] } });
    const db = fakeDb({ profiles: { maybe: profileRow(true) } }, { claim_stripe_customer: claimed, settle_stripe_customer: settled });
    const r = await run(db, stripe);
    const flat = JSON.stringify(r);
    assert.equal(r.user, U.slice(0, 8));
    for (const leak of [CUS, 'pm_SECRETCARD', U, 'cus_']) assert.ok(!flat.includes(leak), `leaked ${leak}`);
  });

  test('the library can never create a Customer, copy a payment method, or use email — by construction', () => {
    const src = code(read('supabase/functions/_shared/saved-card-reconcile.ts'));
    assert.doesNotMatch(src, /method:\s*['"]POST['"]/, 'no Stripe write');
    assert.doesNotMatch(src, /\/v1\/customers['"`]|\/customers['"`]\s*,\s*\{\s*method/);
    assert.doesNotMatch(src, /\bemail\b/i);
    assert.doesNotMatch(src, /payment_methods\/.*(attach|detach)|\.attach|\.detach/);
    const rpcs = [...src.matchAll(/\.rpc\('([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(rpcs)].sort(), ['claim_stripe_customer', 'settle_stripe_customer'], 'only the existing canonical binding functions');
  });
});

/* ── 4. the scheduled function ─────────────────────────────────────────── */

function handler() {
  const db = fakeDb({ profiles: { list: [{ id: U }], maybe: profileRow(true) } });
  let h: ((r: Request) => Promise<Response>) | undefined;
  loadModule('supabase/functions/reconcile-saved-cards/index.ts', {
    'https://deno.land/std@0.168.0/http/server.ts': { serve: (fn: typeof h) => { h = fn; } },
    'https://esm.sh/@supabase/supabase-js@2': { createClient: () => db },
    '../_shared/cron-auth.ts': CronAuth,
    '../_shared/safe-error.ts': SafeError,
    '../_shared/saved-card-reconcile.ts': Reconcile,
  });
  return { h: h!, db };
}
const call = (h: (r: Request) => Promise<Response>, headers: Record<string, string>, body: unknown = {}) =>
  h(new Request('https://f.test/x', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }));

describe('reconcile-saved-cards function', () => {
  test('fails CLOSED: no server secret → 503, no header → 401, wrong header → 401 — and Stripe is never called', async () => {
    const stripe = fakeStripe({ search: [] });
    const { h } = handler();
    await withFetch(stripe, async () => {
      assert.equal((await call(h, {})).status, 401);
      assert.equal((await call(h, { 'x-cron-secret': 'nope' })).status, 401);
      denoSecret = undefined;
      try { assert.equal((await call(h, { 'x-cron-secret': SECRET })).status, 503); } finally { denoSecret = SECRET; }
    });
    assert.equal(stripe.calls.length, 0);
  });

  test('with the secret: reconciles every candidate and returns counts + masked lines only', async () => {
    const stripe = fakeStripe({ search: [] });
    const { h, db } = handler();
    const res = await withFetch(stripe, () => call(h, { 'x-cron-secret': SECRET }));
    const text = await res.text();
    const body = JSON.parse(text);
    assert.equal(res.status, 200);
    assert.equal(body.dry_run, false);
    assert.equal(body.checked, 1);
    assert.deepEqual(body.counts, { flag_cleared: 1 });
    assert.equal(body.results[0].user, U.slice(0, 8));
    assert.ok(!text.includes(U) && !text.includes('cus_'));
    assert.deepEqual(flagWrites(db), [false]);
  });

  test('dry_run:true writes nothing through the function either', async () => {
    const { h, db } = handler();
    const res = await withFetch(fakeStripe({ search: [] }), () => call(h, { 'x-cron-secret': SECRET }, { dry_run: true }));
    assert.equal((await res.json() as any).dry_run, true);
    assert.equal(db.log.updates.length, 0);
  });

  test('it is deployed verify_jwt=false like the other scheduled functions, and scheduled nightly', () => {
    assert.match(read('supabase/config.toml'), /\[functions\.reconcile-saved-cards\]\s*\nverify_jwt = false/);
    assert.match(code(read('supabase/functions/reconcile-saved-cards/index.ts')), /const denied = requireCronSecret\(req, corsHeaders\);\s*\n\s*if \(denied\) return denied;/);
    const sql = read('supabase/migrations/20261016000000_saved_card_flag_requires_customer.sql');
    assert.match(sql, /cron\.schedule\(\s*'reconcile-saved-cards'/);
    assert.match(sql, /x-cron-secret', \(select decrypted_secret from vault\.decrypted_secrets where name = 'cron_secret'\)/);
  });
});

/* ── 5. the write path and the database guard ──────────────────────────── */

describe('the invariant cannot be broken again', () => {
  test('the migration guards the flag on every write, from every role, using the bound customer OR a settled claim', () => {
    const sql = code(read('supabase/migrations/20261016000000_saved_card_flag_requires_customer.sql'));
    assert.match(sql, /create trigger trg_profiles_card_flag_needs_customer\s+before insert or update on public\.profiles\s+for each row/);
    assert.match(sql, /new\.has_payment_method is true\s+and coalesce\(new\.stripe_customer_id, ''\) = ''/);
    assert.match(sql, /c\.status = 'bound'/);
    assert.match(sql, /new\.has_payment_method := false;/);
    assert.match(sql, /security definer/);
    assert.doesNotMatch(sql, /update public\.profiles\s+set has_payment_method/i, 'the migration never blanket-rewrites existing rows');
  });

  test('every writer of has_payment_method derives it from what Stripe holds — and there are exactly three', () => {
    const dir = join(REPO, 'supabase', 'functions');
    const writers: string[] = [];
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const files = d.name === '_shared'
        ? readdirSync(join(dir, d.name)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => join(dir, d.name, f))
        : [join(dir, d.name, 'index.ts')];
      for (const f of files) {
        let src = ''; try { src = code(readFileSync(f, 'utf8')); } catch { continue; }
        if (/has_payment_method\s*:/.test(src) && /\.update\(/.test(src)) writers.push(f.slice(dir.length + 1));
      }
    }
    assert.deepEqual(writers.sort(), ['_shared/saved-card-reconcile.ts', 'confirm-card-setup/index.ts', 'remove-card/index.ts']);
    assert.match(code(read('supabase/functions/confirm-card-setup/index.ts')), /const hasCard = attached\.length > 0;[\s\S]*has_payment_method: hasCard/);
    assert.match(code(read('supabase/functions/remove-card/index.ts')), /has_payment_method: hasCard/);
    assert.match(code(read('supabase/functions/_shared/saved-card-reconcile.ts')), /has_payment_method: desired|has_payment_method: false/);
  });

  test('adding a card binds through the canonical customer path, so the flag never outruns its customer', () => {
    const add = code(read('supabase/functions/create-setup-intent/index.ts'));
    assert.match(add, /canonicalStripeCustomer\(/);
    const confirm = code(read('supabase/functions/confirm-card-setup/index.ts'));
    assert.match(confirm, /if \(!customerId\) return json\(\{ error: 'No payment profile found/);
    assert.ok(confirm.indexOf("if (!customerId)") < confirm.indexOf('has_payment_method: hasCard'), 'the flag is only written once a customer exists');
  });
});

/* ── 6. live, read-only ────────────────────────────────────────────────── */

let sqlOk = false;
const runSql = (sql: string): Record<string, unknown>[] => {
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 200)}`);
  return p.rows ?? [];
};

describe('live (read-only): production honours the invariant', () => {
  before(() => { try { runSql('select 1 as ok'); sqlOk = true; } catch { sqlOk = false; } });
  const skip = 'Supabase CLI or linked project unavailable — run `supabase link` to exercise this layer.';

  test('ZERO profiles have has_payment_method = true with no bound customer', (t) => {
    if (!sqlOk) return t.skip(skip);
    const rows = runSql(`select left(p.id::text, 8) as id8 from public.profiles p
      where p.has_payment_method and coalesce(p.stripe_customer_id, '') = ''
        and not exists (select 1 from public.stripe_customer_claims c where c.user_id = p.id and c.status = 'bound' and coalesce(c.stripe_customer_id, '') <> '')`);
    assert.deepEqual(rows, [], `profiles still carrying a flag with nothing behind it: ${rows.map((r) => r.id8).join(', ')}`);
  });

  test('the guard trigger and the nightly job exist', (t) => {
    if (!sqlOk) return t.skip(skip);
    const trg = runSql(`select pg_get_triggerdef(t.oid) as def from pg_trigger t where t.tgrelid = 'public.profiles'::regclass and t.tgname = 'trg_profiles_card_flag_needs_customer'`);
    assert.equal(trg.length, 1);
    assert.match(String(trg[0].def), /BEFORE INSERT OR UPDATE ON public\.profiles/);
    const job = runSql(`select schedule from cron.job where jobname = 'reconcile-saved-cards'`);
    assert.equal(job.length, 1);
  });
});

// ── Account badge and checkout answer from the SAME canonical state ─────────

const WEB = join(REPO, '..', 'oneshetland-web');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('Payments & banking agrees with checkout (web + mobile)', () => {
  // A stand-in Supabase client whose saved-card-state function returns `reply`.
  // The profile flag is deliberately TRUE everywhere: the badge must ignore it.
  const clientReturning = (reply: unknown) => ({
    functions: { invoke: async () => (reply instanceof Error ? { data: null, error: reply } : { data: reply, error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { has_payment_method: true } }) }) }) }),
  });
  // The real web source, with its app-alias imports stubbed (type-only imports are stripped).
  // deno-lint-ignore no-explicit-any
  let web: Record<string, any>;
  before(() => {
    web = loadModule('../oneshetland-web/lib/payment-state.ts', {
      '@/lib/supabase/client': { createClient: () => ({}) },
      '@/lib/retry-after': { retryAfterSecsFrom: () => null },
    });
  });

  test('flag true but the resolver says none → NOT added', async () => {
    const r = await web.resolveCardState(clientReturning({ state: 'none' }) as never);
    assert.equal(r.state, 'none');
    assert.equal(await web.fetchCardOnFile(clientReturning({ state: 'none' }) as never), false);
  });

  test('a customer with a card → added, with safe brand and last4 only', async () => {
    const r = await web.resolveCardState(clientReturning({ state: 'card', brand: 'visa', last4: '4242', id: 'pm_x', customer: 'cus_x' }) as never);
    assert.deepEqual(r, { state: 'card', brand: 'visa', last4: '4242' });
  });

  test('an outage is "unknown", never "added" and never silently "none"', async () => {
    assert.equal((await web.resolveCardState(clientReturning(new Error('boom')) as never)).state, 'unknown');
    assert.equal((await web.resolveCardState(clientReturning({ state: 'weird' }) as never)).state, 'unknown');
    assert.equal((await web.resolveCardState(clientReturning(null) as never)).state, 'unknown');
  });

  test('removing the last card updates the state on the next read (no cache)', async () => {
    let reply: unknown = { state: 'card', brand: 'visa', last4: '4242' };
    const sb = { functions: { invoke: async () => ({ data: reply, error: null }) } } as never;
    assert.equal(await web.fetchCardOnFile(sb), true);
    reply = { state: 'none' };
    assert.equal(await web.fetchCardOnFile(sb), false);
  });

  test('the account summary, Payments page, basket and onboarding all use the canonical resolver, not the flag', () => {
    for (const f of ['lib/payment-state.ts', 'lib/onboarding.server.ts', 'app/fetch/new/page.tsx', 'app/account/page.tsx', 'app/account/payments/page.tsx']) {
      assert.ok(!strip(readFileSync(join(WEB, f), 'utf8')).includes('has_payment_method'), `${f} still reads the flag`);
    }
    assert.match(readFileSync(join(WEB, 'app/basket/page.tsx'), 'utf8'), /fetchCardOnFile/);
    assert.match(readFileSync(join(WEB, 'app/account/payments/page.tsx'), 'utf8'), /formatCardLabel/);
  });

  test('mobile Account and Me badges come from the same server state as checkout', () => {
    for (const f of ['app/account.tsx', 'app/(tabs)/me.tsx']) {
      const src = strip(readFileSync(join(REPO, f), 'utf8'));
      assert.match(src, /useSavedCard\(/, `${f} must use the canonical hook`);
      assert.ok(!/profile\?\.has_payment_method \?|!profile\?\.has_payment_method/.test(src), `${f} still branches on the flag`);
    }
    const hook = readFileSync(join(REPO, 'hooks/useSavedCard.ts'), 'utf8');
    assert.match(hook, /fetchSavedCardState/);
    // and checkout uses the very same helper
    assert.match(readFileSync(join(REPO, 'app/event-ticket-checkout.tsx'), 'utf8'), /fetchSavedCardState/);
  });

  test('no raw card data or ids reach a screen or a log from the state helpers', () => {
    const helper = strip(readFileSync(join(REPO, 'lib/saved-card-state.ts'), 'utf8'));
    const webSrc = strip(readFileSync(join(WEB, 'lib/payment-state.ts'), 'utf8'));
    for (const src of [helper, webSrc]) {
      assert.ok(!/console\.(log|info|warn|error)/.test(src));
      assert.ok(!/\bdata\.(id|customer|fingerprint|exp_)/.test(src));
    }
  });
});
