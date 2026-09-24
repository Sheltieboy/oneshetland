/**
 * ticket-ownership-display.node.test.ts
 *
 * THE DEFECT (24 Sep 2026, paid-ticket acceptance)
 *
 * The web homepage "For you" strip marked an upcoming event "YOUR TICKET" for a
 * buyer who had not bought it. lib/for-you.server.ts read event_tickets by
 * holder_id ALONE — no status condition — so a pending_payment reservation (created
 * the moment checkout starts) and a cancelled/refunded ticket all counted as
 * ownership. Cleanup working correctly did not help: the cancelled row still matched.
 *
 * THE INVARIANT
 *
 *   A user owns an event ticket, for display, only when its status is valid or used.
 *   pending_payment, cancelled and refunded are never ownership.
 *
 * It is the definition already used by web My Tickets, mobile My Tickets, and the
 * database (holds_ticket_for(), get_event_social_stats()). Web now has ONE shared
 * constant for it: OWNED_TICKET_STATUSES in lib/event-ticket-utils.ts.
 *
 * WHAT THIS FILE PINS
 *   - the status matrix, by EXECUTING the real For You fetchTickets against a fake
 *     database that honours every filter it is given
 *   - a free claim still shows ownership (it issues a valid ticket), and a paid
 *     checkout does NOT issue one until fulfilment — both proven on the real
 *     create-event-ticket-intent
 *   - upcoming-event filtering happens in the query, so past rows cannot use up its limit
 *   - a source contract: no client read of event_tickets by holder can match without a
 *     genuine-status condition (web AND mobile)
 *   - the web constant equals the database helper's definition
 *
 * No special-casing: nothing here names a user, an event, or the acceptance fixture.
 * SAFETY: fakes only. The one live check is a read-only SELECT via the Supabase CLI
 * and skips when it is unavailable.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule, extractFunction, extractConst, instantiate } from './_support/load-source.ts';
import * as Sca from '../functions/_shared/stripe-sca.ts';
import * as SafeError from '../functions/_shared/safe-error.ts';
import * as TicketQuantities from '../functions/_shared/ticket-quantities.ts';
import * as SavedCardState from '../functions/_shared/saved-card-state.ts';
import {
  OWNED_TICKET_STATUSES, isOwnedTicketStatus,
} from '../../../oneshetland-web/lib/event-ticket-utils.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
const web = (p: string) => readFileSync(join(WEB, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

/* ── the real For You fetchTickets, against a fake DB that honours its filters ── */

type Row = {
  id: string; holder_id: string; status: string;
  event: { id: string; title: string; starts_at: string; venue: string | null; cover_url: string | null } | null;
};

/**
 * Applies eq / in / gte / limit exactly as PostgREST would — including the detail that
 * matters here: a filter on an EMBEDDED column only removes parent rows when the embed
 * is `!inner`; otherwise the parent survives with the embed nulled.
 */
function fakeSb(rows: Row[]) {
  const reads: { table: string; select: string; filters: string[] }[] = [];
  const sb = {
    from(table: string) {
      const rec = { table, select: '', filters: [] as string[] };
      reads.push(rec);
      let out: Row[] = table === 'event_tickets' ? rows.map((r) => ({ ...r, event: r.event ? { ...r.event } : null })) : [];
      let max = Infinity;
      const q: any = {
        select: (s: string) => { rec.select = s; return q; },
        eq: (c: string, v: unknown) => { rec.filters.push(`eq:${c}`); out = out.filter((r: any) => r[c] === v); return q; },
        in: (c: string, vs: unknown[]) => { rec.filters.push(`in:${c}=${vs.join('|')}`); out = out.filter((r: any) => vs.includes(r[c])); return q; },
        gt: () => q, or: () => q, order: () => q,
        gte: (c: string, v: string) => {
          rec.filters.push(`gte:${c}`);
          if (c.startsWith('event.')) {
            const col = c.slice('event.'.length);
            const inner = /events!inner/.test(rec.select);
            out = out.flatMap((r) => {
              const ok = !!r.event && String((r.event as any)[col]) >= v;
              if (ok) return [r];
              return inner ? [] : [{ ...r, event: null }];
            });
          }
          return q;
        },
        limit: (n: number) => { max = n; return q; },
        then: (res: any, rej: any) => Promise.resolve({ data: out.slice(0, max), error: null }).then(res, rej),
      };
      return q;
    },
  };
  return { sb, reads };
}

const FOR_YOU_SRC = web('lib/for-you.server.ts');
const isSameDay = instantiate<(iso: string) => boolean>(extractFunction(FOR_YOU_SRC, 'function isSameDay('), {});
const relativeDay = instantiate<(iso: string) => string>(extractFunction(FOR_YOU_SRC, 'function relativeDay('), { isSameDay });
const timeLabel = instantiate<(iso: string) => string>(extractFunction(FOR_YOU_SRC, 'function timeLabel('), {});
const fetchTickets = instantiate<(sb: unknown, userId: string) => Promise<any[]>>(
  extractFunction(FOR_YOU_SRC, 'async function fetchTickets('),
  { ACCENT: extractConst(FOR_YOU_SRC, 'ACCENT'), OWNED_TICKET_STATUSES, isSameDay, relativeDay, timeLabel },
);

const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString();
const ev = (id: string, days = 7) => ({ id, title: `Event ${id}`, starts_at: inDays(days), venue: 'Hall', cover_url: null });
const me = 'holder-me';
const tk = (id: string, status: string, event: Row['event'], holder = me): Row => ({ id, holder_id: holder, status, event });
const ticketCards = (items: any[]) => items.filter((i) => i.kind === 'ticket');

describe('For You: only genuinely owned tickets create "your ticket"', () => {
  test('the status matrix: pending_payment / cancelled / refunded → no cue; valid / used → cue', async () => {
    const expected: Record<string, boolean> = { pending_payment: false, cancelled: false, refunded: false, valid: true, used: true };
    for (const [status, owns] of Object.entries(expected)) {
      const { sb } = fakeSb([tk('t1', status, ev('e1'))]);
      const cards = ticketCards(await fetchTickets(sb, me));
      assert.equal(cards.length, owns ? 1 : 0, `${status} ${owns ? 'must' : 'must NOT'} produce a ticket card`);
      if (owns) assert.equal(cards[0].cue, 'your ticket');
    }
  });

  test('a successfully claimed FREE ticket (issued as valid) still shows ownership — nothing is paid-specific', async () => {
    const { sb } = fakeSb([tk('free1', 'valid', ev('freeEvent'))]);
    const cards = ticketCards(await fetchTickets(sb, me));
    assert.equal(cards.length, 1);
    assert.equal(cards[0].cue, 'your ticket');
    assert.equal(cards[0].href, '/whats-on/freeEvent');
  });

  test('a cancelled ticket does not become ownership when its order expires — cleanup leaves the row, the display ignores it', async () => {
    // Before expiry the checkout is a pending reservation; after, cleanup marks the ticket cancelled.
    for (const status of ['pending_payment', 'cancelled']) {
      const { sb } = fakeSb([tk('a', status, ev('attempted')), tk('b', 'used', ev('genuine'))]);
      const cards = ticketCards(await fetchTickets(sb, me));
      assert.deepEqual(cards.map((c) => c.id), ['ticket-genuine'], `with the attempted event's ticket ${status}`);
    }
  });

  test('a user with both an attempted and a genuine ticket sees only the genuine event; two tickets on one event are one card', async () => {
    const { sb } = fakeSb([
      tk('a1', 'valid', ev('e1', 3)), tk('a2', 'valid', ev('e1', 3)),
      tk('x1', 'pending_payment', ev('e2', 4)), tk('x2', 'refunded', ev('e3', 5)),
    ]);
    assert.deepEqual(ticketCards(await fetchTickets(sb, me)).map((c) => c.id), ['ticket-e1']);
  });

  test('other people’s tickets never appear', async () => {
    const { sb } = fakeSb([tk('o1', 'valid', ev('e1'), 'someone-else')]);
    assert.equal(ticketCards(await fetchTickets(sb, me)).length, 0);
  });

  test('the upcoming-event constraint is IN the query: past rows cannot consume the row limit', async () => {
    const past = Array.from({ length: 8 }, (_, i) => tk(`p${i}`, 'valid', ev(`past${i}`, -(i + 1))));
    const { sb, reads } = fakeSb([...past, tk('up', 'valid', ev('upcoming', 2))]);
    const cards = ticketCards(await fetchTickets(sb, me));
    assert.deepEqual(cards.map((c) => c.id), ['ticket-upcoming'], 'the one upcoming ticket must not be crowded out by 8 past ones');
    const q = reads.find((r) => r.table === 'event_tickets')!;
    assert.match(q.select, /events!inner/);
    assert.ok(q.filters.includes('gte:event.starts_at'));
    assert.ok(q.filters.some((f) => f === 'in:status=valid|used'), `status condition present: ${q.filters.join(', ')}`);
  });

  test('ranking and limit are otherwise unchanged: soonest first, at most two ticket cards, "today" outranks', async () => {
    const { sb } = fakeSb([tk('a', 'valid', ev('later', 10)), tk('b', 'valid', ev('soon', 2)), tk('c', 'used', ev('mid', 5))]);
    assert.deepEqual(ticketCards(await fetchTickets(sb, me)).map((c) => c.id), ['ticket-soon', 'ticket-mid']);
  });
});

/* ── the shared definition ─────────────────────────────────────────────── */

describe('one shared definition of "owned"', () => {
  test('exactly valid and used; reservations, cancellations and refunds are not ownership', () => {
    assert.deepEqual([...OWNED_TICKET_STATUSES], ['valid', 'used']);
    for (const s of ['valid', 'used']) assert.equal(isOwnedTicketStatus(s), true, s);
    for (const s of ['pending_payment', 'cancelled', 'refunded', '', null, undefined, 'VALID', 'checked_in']) {
      assert.equal(isOwnedTicketStatus(s as never), false, String(s));
    }
  });

  test('For You and My Tickets both use it, rather than restating a list', () => {
    assert.match(code(web('lib/for-you.server.ts')), /\.in\("status", \[\.\.\.OWNED_TICKET_STATUSES\]\)/);
    assert.match(code(web('app/account/tickets/page.tsx')), /\.in\("status", \[\.\.\.OWNED_TICKET_STATUSES\]\)/);
    assert.match(code(web('lib/for-you.server.ts')), /import \{ OWNED_TICKET_STATUSES \} from "@\/lib\/event-ticket-utils";/);
  });

  test('the shared module stays pure — importable from client components (no server-only imports)', () => {
    const src = code(web('lib/event-ticket-utils.ts'));
    assert.doesNotMatch(src, /^import /m);
    assert.doesNotMatch(src, /next\/headers|supabase\/server/);
  });

  test('it equals the database’s definition — holds_ticket_for() and get_event_social_stats() (migrations)', () => {
    const dir = join(REPO, 'supabase', 'migrations');
    const all = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    const helper = all.slice(all.lastIndexOf('create or replace function public.holds_ticket_for'));
    assert.match(helper.slice(0, 700), /t\.status in \('valid', 'used'\)/);
    const stats = all.slice(all.lastIndexOf('create or replace function public.get_event_social_stats'));
    assert.match(stats.slice(0, 900), /status in \('valid', 'used'\)/);
  });
});

/* ── a contract over every client read of event_tickets ────────────────── */

function walk(dir: string, exts: string[], skip: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (skip.test(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, exts, skip));
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

/** Every `.from("event_tickets")` statement in a source tree, up to the closing `;`. */
function ticketReads(root: string, dirs: string[], skip: RegExp) {
  const found: { file: string; stmt: string }[] = [];
  for (const d of dirs) {
    let files: string[] = [];
    try { files = walk(join(root, d), ['.ts', '.tsx'], skip); } catch { continue; }
    for (const f of files) {
      const src = code(readFileSync(f, 'utf8'));
      for (const m of src.matchAll(/\.from\((["'])event_tickets\1\)/g)) {
        const rest = src.slice(m.index!);
        const end = rest.indexOf(';');
        found.push({ file: f.slice(root.length + 1), stmt: rest.slice(0, end === -1 ? 600 : end) });
      }
    }
  }
  return found;
}

describe('no client can infer ownership from holder_id alone', () => {
  const SKIP = /node_modules|\.next|\.test\./;

  /** A holder-keyed read must constrain status to the owned set, or be scoped to explicit ticket ids. */
  const constrained = (stmt: string) =>
    /OWNED_TICKET_STATUSES/.test(stmt)
    || /\.in\((["'])status\1,\s*\[\s*(["'])valid\2\s*,\s*(["'])used\3\s*\]\)/.test(stmt)
    || /\.eq\((["'])status\1,\s*(["'])valid\2\)/.test(stmt)
    || /\.in\((["'])id\1,/.test(stmt);          // re-reads tickets the server already filtered, by id

  test('web: every event_tickets read keyed on holder_id carries a genuine-status condition', () => {
    const reads = ticketReads(WEB, ['app', 'components', 'lib'], SKIP);
    const holderReads = reads.filter((r) => /holder_id/.test(r.stmt));
    assert.ok(holderReads.length >= 3, `expected to find the holder reads, found ${holderReads.length}`);
    for (const r of holderReads) assert.ok(constrained(r.stmt), `${r.file}: reads event_tickets by holder_id without a valid/used status condition`);
    // and the one id-scoped exception is exactly the live refresh
    const idScoped = holderReads.filter((r) => !/OWNED_TICKET_STATUSES|'valid'|"valid"/.test(r.stmt)).map((r) => r.file);
    assert.deepEqual(idScoped, ['components/account/TicketsLive.tsx']);
  });

  test('web: reservations are never treated as ownership by ANY status-listing read', () => {
    for (const r of ticketReads(WEB, ['app', 'components', 'lib'], SKIP)) {
      assert.doesNotMatch(r.stmt, /\.in\(["']status["'],\s*\[[^\]]*(pending_payment|cancelled|refunded)/, `${r.file} lists a non-owned status as if it were ownership`);
    }
  });

  test('mobile: every event_tickets read keyed on holder_id constrains status to valid/used', () => {
    const reads = ticketReads(REPO, ['app', 'lib', 'components', 'hooks', 'context'], SKIP).filter((r) => /holder_id/.test(r.stmt));
    assert.ok(reads.length >= 2, `expected to find the mobile holder reads, found ${reads.length}`);
    for (const r of reads) assert.ok(constrained(r.stmt), `${r.file}: reads event_tickets by holder_id without a valid/used status condition`);
  });

  test('the contract itself detects the defect: the pre-fix For You statement fails it', () => {
    const preFix = `.from("event_tickets").select("id, event:events(id, title)").eq("holder_id", userId).limit(6)`;
    assert.equal(constrained(preFix), false);
    assert.equal(constrained(`.from("event_tickets").eq("holder_id", u).in("status", ["valid", "used"])`), true);
    assert.equal(constrained(`.from("event_tickets").eq("holder_id", u).in("status", ["valid", "used", "pending_payment"])`), false);
  });
});

/* ── which statuses the SERVER actually issues ─────────────────────────── */

const USER = 'u-1', EVENT = 'e-1', TT = 'tt-1', ORDER = 'ord-1';
(globalThis as any).Deno ??= { env: { get: (k: string) => ({ STRIPE_SECRET_KEY: 'sk_test_FAKE', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'ANON', SUPABASE_SERVICE_ROLE_KEY: 'SERVICE' } as Record<string, string>)[k] } };

function fakeDb(tables: Record<string, { single?: unknown; maybe?: unknown; list?: unknown[] }>, rpc: Record<string, () => { data: unknown }>) {
  const updates: { table: string; payload: any }[] = [];
  const from = (table: string) => {
    let mode: 'select' | 'update' = 'select'; let payload: any;
    const exec = () => (mode === 'update' ? (updates.push({ table, payload }), { data: [{ id: 'x' }], error: null }) : { data: tables[table]?.list ?? [], error: null });
    const q: any = {
      select: () => q, eq: () => q, in: () => q, order: () => q, limit: () => q,
      update: (p: any) => { mode = 'update'; payload = p; return q; },
      single: async () => ({ data: tables[table]?.single ?? null, error: null }),
      maybeSingle: async () => ({ data: tables[table]?.maybe ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve(exec()).then(res, rej),
    };
    return q;
  };
  return { from, rpc: async (n: string) => rpc[n]?.() ?? { data: null, error: null }, updates };
}

async function runIntent(pricePence: number, extra: Record<string, unknown> = {}) {
  const db = fakeDb(
    {
      events: { single: { id: EVENT, title: 'T', starts_at: inDays(5), venue: 'V', formatted_address: 'A', status: 'published', organiser_business_id: 'b', organiser_hub_id: null } },
      event_ticket_types: { list: [{ id: TT, event_id: EVENT, name: 'A', price_pence: pricePence, per_order_max: 10, is_active: true, sale_starts_at: null, sale_ends_at: null }] },
      profiles: { maybe: { stripe_customer_id: null } },
    },
    {
      event_payout_destination: () => ({ data: [{ account_id: 'acct_D', is_demo: false }] }),
      reserve_ticket_basket: () => ({ data: { order_id: ORDER, ticket_ids: ['tk'], status: 'pending', already: false, stripe_payment_intent_id: null } }),
    },
  );
  let handler: ((r: Request) => Promise<Response>) | undefined;
  loadModule('supabase/functions/create-event-ticket-intent/index.ts', {
    'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: typeof handler) => { handler = h; } },
    'https://esm.sh/@supabase/supabase-js@2': { createClient: (_u: string, k: string) => (k === 'ANON' ? { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } } : db) },
    '../_shared/ticket-receipt.ts': { sendTicketReceipt: async () => {} },
    '../_shared/ticket-quantities.ts': TicketQuantities,
    '../_shared/wallet-ledger.ts': { debitAndTransfer: async () => ({ ok: false }) },
    '../_shared/safe-error.ts': SafeError,
    '../_shared/rate-limit.ts': { enforceRateLimit: async () => ({ ok: true }), userSubject: (u: string) => `user:${u}` },
    '../_shared/stripe-sca.ts': Sca,
    '../_shared/stripe-errors.ts': { stripeError: (s: number) => Object.assign(new Error('stripe'), { status: s }), checkoutFailure: () => null },
    '../_shared/saved-card-state.ts': SavedCardState,
  });
  const orig = globalThis.fetch;
  (globalThis as any).fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'pi_1', status: 'requires_payment_method', client_secret: 'pi_1_secret_x' }) });
  try {
    const res = await handler!(new Request('https://f.test/x', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_id: EVENT, line_items: [{ ticket_type_id: TT, quantity: 1 }], client_request_id: 'attempt-00000001', ...extra }),
    }));
    return { body: await res.json() as any, updates: db.updates };
  } finally { globalThis.fetch = orig; }
}

describe('what the server issues: free claim → valid; paid checkout → nothing until fulfilment', () => {
  test('a successful FREE claim issues valid tickets (so ownership shows)', async () => {
    const r = await runIntent(0);
    assert.equal(r.body.free, true);
    const issued = r.updates.filter((u) => u.table === 'event_tickets').map((u) => u.payload.status);
    assert.deepEqual(issued, ['valid']);
    assert.ok(isOwnedTicketStatus(issued[0]));
  });

  test('a PAID checkout only reserves: no ticket is set valid when the intent is created', async () => {
    const r = await runIntent(100, { use_saved_card: false });
    assert.ok(r.body.clientSecret, 'the buyer is sent to pay');
    assert.deepEqual(r.updates.filter((u) => u.table === 'event_tickets'), [], 'creating a PaymentIntent must not issue an owned ticket');
  });
});

/* ── live parity with the database helper ─────────────────────────────── */

let sqlOk = false;
const runSql = (sql: string): Record<string, unknown>[] => {
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 200)}`);
  return p.rows ?? [];
};

describe('live: the deployed database helpers agree with the shared constant (read-only)', () => {
  before(() => { try { runSql('select 1 as ok'); sqlOk = true; } catch { sqlOk = false; } });

  test('holds_ticket_for() and get_event_social_stats() count exactly the OWNED statuses', (t) => {
    if (!sqlOk) return t.skip('Supabase CLI or linked project unavailable — run `supabase link` to exercise this layer.');
    const defs = runSql(`select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('holds_ticket_for','get_event_social_stats')`);
    assert.equal(defs.length, 2);
    const listed = OWNED_TICKET_STATUSES.map((s) => `'${s}'`).join(', ');
    for (const d of defs) assert.ok(String(d.def).includes(`status in (${listed})`), `${d.proname} no longer counts exactly (${listed})`);
  });
});
