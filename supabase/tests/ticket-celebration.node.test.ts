/**
 * ticket-celebration.node.test.ts — the attendee's "You're in!" moment.
 *
 * Physical acceptance (25 Sep): the organiser scanned a valid £1 ticket, it went
 * valid → used correctly, and the attendee simply saw "Used" — no celebration.
 * The component and the screen wiring both existed; the trigger was a single
 * Realtime push that only counted if it landed while the screen was mounted, and
 * a screen that loaded an already-`used` row had no memory of the transition.
 *
 * These tests pin the once-only, observed-transition rule and that check-in
 * semantics were left alone.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// deno-lint-ignore no-explicit-any
const C: Record<string, any> = loadModule('lib/ticket-celebration.ts');

const T0 = Date.parse('2026-09-25T00:26:32Z');
const memStore = (fail = false) => {
  const m = new Map<string, string>();
  return {
    m,
    get: async (k: string) => { if (fail) throw new Error('storage down'); return m.get(k) ?? null; },
    set: async (k: string, v: string) => { if (fail) throw new Error('storage down'); m.set(k, v); },
  };
};
const used = (id = 't1', at = new Date(T0).toISOString()) => ({ id, status: 'used', checked_in_at: at });
const valid = (id = 't1') => ({ id, status: 'valid', checked_in_at: null });

/* ── the decision ─────────────────────────────────────────────────────── */

describe('shouldCelebrate', () => {
  const base = { status: 'used', checkedInAt: new Date(T0).toISOString(), seenValid: true, celebrated: false, now: T0 + 30_000 };

  test('a used ticket seen valid, fresh, not yet celebrated → yes', () => {
    assert.equal(C.shouldCelebrate(base), true);
  });
  test('any other status → never (cancelled, refunded, pending, valid)', () => {
    for (const status of ['valid', 'cancelled', 'refunded', 'pending_payment', null, undefined]) {
      assert.equal(C.shouldCelebrate({ ...base, status }), false, String(status));
    }
  });
  test('never seen valid on this device → no (a used ticket met fresh is not a check-in that just happened)', () => {
    assert.equal(C.shouldCelebrate({ ...base, seenValid: false }), false);
  });
  test('already celebrated → no', () => {
    assert.equal(C.shouldCelebrate({ ...base, celebrated: true }), false);
  });
  test('a stale check-in, or one with no usable stamp, is a memory not a moment', () => {
    assert.equal(C.shouldCelebrate({ ...base, now: T0 + C.CELEBRATION_MAX_AGE_MS + 1000 }), false);
    assert.equal(C.shouldCelebrate({ ...base, checkedInAt: null }), false);
    assert.equal(C.shouldCelebrate({ ...base, checkedInAt: 'nonsense' }), false);
  });
  test('a little clock skew is tolerated', () => {
    assert.equal(C.shouldCelebrate({ ...base, now: T0 - 30_000 }), true);
  });
});

/* ── the behaviour the physical test exposed ──────────────────────────── */

describe('first successful scan', () => {
  test('valid seen, then used → celebrates exactly once', async () => {
    const c = C.createTicketCelebrations(memStore(), () => T0 + 5000);
    assert.equal(await c.observe(valid()), false);
    assert.equal(await c.observe(used()), true);
    assert.equal(await c.observe(used()), false, 'the very next read must not repeat it');
    assert.equal(await c.observe(used()), false);
  });

  test('RETURNING from the QR: the app was away when the scan landed, the screen remounts and re-reads → celebrates', async () => {
    const store = memStore();
    const before = C.createTicketCelebrations(store, () => T0 - 60_000);
    await before.observe(valid()); // holder had the QR open, valid
    // …app backgrounded / screen unmounted; the door scans; a NEW tracker instance = a cold screen…
    const after = C.createTicketCelebrations(store, () => T0 + 120_000);
    assert.equal(await after.observe(used()), true);
  });

  test('a live valid → used push counts as the observed "before"', async () => {
    const c = C.createTicketCelebrations(memStore(), () => T0 + 1000);
    await c.markSeenValid('t1'); // the realtime payload's old row was valid
    assert.equal(await c.observe(used()), true);
  });

  test('the status the holder then sees is still "used" — the celebration never alters it', async () => {
    const c = C.createTicketCelebrations(memStore(), () => T0 + 1000);
    await c.observe(valid());
    const row = used();
    await c.observe(row);
    assert.equal(row.status, 'used');
  });
});

describe('it never replays and never fires on a fresh used ticket', () => {
  test('reopening the used ticket later (new screen, same device) does not replay', async () => {
    const store = memStore();
    const s1 = C.createTicketCelebrations(store, () => T0 + 1000);
    await s1.observe(valid());
    assert.equal(await s1.observe(used()), true);
    const later = C.createTicketCelebrations(store, () => T0 + 60_000);
    assert.equal(await later.observe(used()), false);
    const muchLater = C.createTicketCelebrations(store, () => T0 + 3 * 24 * 3600_000);
    assert.equal(await muchLater.observe(used()), false);
  });

  test('a ticket first opened already used (never seen valid here) does not celebrate on load', async () => {
    const c = C.createTicketCelebrations(memStore(), () => T0 + 1000);
    assert.equal(await c.observe(used()), false);
  });

  test('cancelled / refunded / pending tickets never celebrate, even if once seen valid', async () => {
    const c = C.createTicketCelebrations(memStore(), () => T0 + 1000);
    for (const status of ['cancelled', 'refunded', 'pending_payment']) {
      await c.markSeenValid(`x-${status}`);
      assert.equal(await c.observe({ id: `x-${status}`, status, checked_in_at: new Date(T0).toISOString() }), false, status);
    }
  });

  test('one ticket does not celebrate another', async () => {
    const c = C.createTicketCelebrations(memStore(), () => T0 + 1000);
    await c.observe(valid('a'));
    assert.equal(await c.observe(used('b')), false);
    assert.equal(await c.observe(used('a')), true);
  });
});

describe('two screens, one celebration', () => {
  test('the list and the ticket screen reading the same row at once yield exactly ONE winner', async () => {
    const c = C.createTicketCelebrations(memStore(), () => T0 + 1000);
    await c.observe(valid());
    const results = await Promise.all([c.observe(used()), c.observe(used()), c.observe(used())]);
    assert.equal(results.filter(Boolean).length, 1);
  });
});

describe('storage trouble is survivable', () => {
  test('if storage is down it still celebrates once per session and never throws', async () => {
    const c = C.createTicketCelebrations(memStore(true), () => T0 + 1000);
    await c.observe(valid());
    assert.equal(await c.observe(used()), true);
    assert.equal(await c.observe(used()), false);
  });
});

/* ── the wiring ───────────────────────────────────────────────────────── */

describe('the screens', () => {
  const detail = strip(read('app/my-event-ticket.tsx'));
  const list = strip(read('app/my-event-tickets.tsx'));

  test('both judge every read through the shared once-only tracker', () => {
    for (const src of [detail, list]) {
      assert.match(src, /ticketCelebrations\.observe\(/);
      assert.match(src, /from '@\/lib\/ticket-celebration-store'/);
    }
  });

  test('a Realtime payload no longer triggers the celebration directly — it only supplies the "before" and re-reads', () => {
    for (const src of [detail, list]) {
      assert.ok(!/next === 'used'/.test(src), 'no direct payload-driven trigger');
      assert.match(src, /markSeenValid\(/);
    }
  });

  test('the ticket screen catches up when refocused, foregrounded, and while still unscanned', () => {
    assert.match(detail, /useFocusEffect\(useCallback\(\(\) => \{ load\(\); \}, \[load\]\)\)/);
    assert.match(detail, /AppState\.addEventListener\('change'/);
    assert.match(detail, /ticketStatus !== 'valid'\) return;[\s\S]*setInterval/);
  });

  test('the list claims a celebration only while it is focused (an open ticket must be the one to show it)', () => {
    assert.match(list, /focusedRef\.current/);
    assert.match(list, /t\.status === 'valid' \|\| focusedRef\.current/);
  });

  test('the celebration is brief, non-blocking and respects reduced motion', () => {
    const raw = read('components/TicketCelebration.tsx');
    const src = strip(raw);
    assert.ok(!/<Modal/.test(src), 'no blocking Modal');
    assert.match(src, /pointerEvents="none"/);
    assert.match(src, /CELEBRATION_MS/);
    assert.match(src, /isReduceMotionEnabled/);
    assert.ok(C.CELEBRATION_MS <= 2500, 'a small reward moment, not a takeover');
    assert.match(src, /haptic\.success\(\)/);
  });
});

/* ── check-in semantics are untouched ─────────────────────────────────── */

describe('check-in itself was not changed', () => {
  test('the scanner screen and the validate function are unmodified by this fix', () => {
    const out = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'app/event-scanner.tsx', 'supabase/functions/validate-event-ticket'],
      { cwd: REPO, encoding: 'utf8' }).trim();
    assert.equal(out, '');
  });

  test('the celebration code never writes to event_tickets or calls a check-in function', () => {
    for (const f of ['lib/ticket-celebration.ts', 'lib/ticket-celebration-store.ts', 'components/TicketCelebration.tsx']) {
      const src = strip(read(f));
      assert.ok(!/\.from\(\s*['"`]|\.rpc\(|functions\.invoke|from '@\/lib\/supabase'|\.update\(/.test(src), `${f} must not touch the database`);
    }
  });
});

const runSql = (sql: string): Record<string, unknown>[] => {
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 200)}`);
  return p.rows ?? [];
};

describe('live (read-only): a second scan is refused and check-in has no duplicate side effects', () => {
  let sqlOk = false;
  before(() => { try { runSql('select 1 as ok'); sqlOk = true; } catch { sqlOk = false; } });
  const skip = 'Supabase CLI or linked project unavailable — run `supabase link` to exercise this layer.';

  test('redeem_ticket_atomic spends only a valid ticket in one statement and reports already_used otherwise', (t) => {
    if (!sqlOk) return t.skip(skip);
    const def = String(runSql(`select pg_get_functiondef('public.redeem_ticket_atomic'::regproc) as d`)[0].d);
    assert.match(def, /update public\.event_tickets[\s\S]*set status\s*=\s*'used'[\s\S]*and status\s*=\s*'valid'/i);
    assert.match(def, /'already_used'/);
  });

  test('no ticket has more than one successful check-in (the audit trail has no duplicate "valid")', (t) => {
    if (!sqlOk) return t.skip(skip);
    const rows = runSql(`select ticket_id from public.event_checkins where result = 'valid' and ticket_id is not null group by ticket_id having count(*) > 1`);
    assert.equal(rows.length, 0);
  });

  test('every used ticket has exactly one successful check-in', (t) => {
    if (!sqlOk) return t.skip(skip);
    const rows = runSql(`select left(k.id::text, 8) as id8 from public.event_tickets k
      where k.status = 'used' and (select count(*) from public.event_checkins c where c.ticket_id = k.id and c.result = 'valid') <> 1`);
    // Legacy rows predating the audit table may exist; report rather than hide them.
    assert.ok(rows.length === 0, `used tickets without exactly one valid check-in: ${rows.map((r) => r.id8).join(', ')}`);
  });
});
