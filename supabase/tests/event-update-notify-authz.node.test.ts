/**
 * event-update-notify-authz.node.test.ts — who may make notify-event-update fire.
 *
 * Signed in is not the same as ENTITLED: an update_id comes straight from the request body, so any signed-in account could otherwise email
 * every ticket holder of somebody else's event. The gate asks the database's can_scan_event() (platform admin, the owning business's owner,
 * the owning hub's owner or an active committee member) and nothing else: organiser_user_id is audit metadata and confers no authority.
 *
 * Exercised directly against a fake service client — no network, no database.
 * (The other seven notify-* fan-out gates are a separate piece of work and are not part of this suite.)
 *
 * SAFETY: pure unit tests. No network call, no database write.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** A fake service client: named tables of rows, plus an optional RPC stub. */
function fakeSvc(tables: Record<string, Row[]>, rpcImpl?: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }) {
  const rpcCalls: { name: string; args: unknown }[] = [];
  return {
    rpcCalls,
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const rowsFor = () => (tables[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters[k] = v; return q; },
        maybeSingle: async () => ({ data: rowsFor()[0] ?? null }),
        limit: async () => ({ data: rowsFor() }),
      };
      return q;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return rpcImpl ? rpcImpl(name, args) : { data: null, error: null };
    },
  };
}

const user = (id: string) => ({ userId: id, isServiceRole: false });
const service = { userId: '', isServiceRole: true };

// Every auth module imports its decision type/helpers from notify-decision.ts;
// load it once and hand it to loadModule as the stub for that import.
const Decision = loadModule('supabase/functions/_shared/notify-decision.ts');
const stubs = { './notify-decision.ts': Decision };
const loadAuth = (rel: string) => loadModule(rel, stubs);

// A stock cast of uuids, reused across sections with domain-appropriate names.
const A = '11111111-1111-4111-8111-111111111111'; // the legitimate party
const B = '22222222-2222-4222-8222-222222222222'; // an unrelated signed-in user
const ENTITY = '33333333-3333-4333-8333-333333333333';
const OTHER_ENTITY = '44444444-4444-4444-8444-444444444444';


/* ── notify-event-update ──────────────────────────────────────────────── */

// deno-lint-ignore no-explicit-any
const EventUpdate: Record<string, any> = loadAuth('supabase/functions/_shared/event-update-notify-auth.ts');

describe('notify-event-update: only someone who CURRENTLY controls the organiser may email ticket holders', () => {
  const UPDATE = ENTITY;
  const EVENT_ID = OTHER_ENTITY;
  /** can_scan_event is the single source of truth; this stub plays it for a given set of authorised users. */
  const scanners = (...ids: string[]) => (name: string, args: Record<string, unknown>) =>
    ({ data: name === 'can_scan_event' && args.p_event_id === EVENT_ID && ids.includes(args.p_user_id as string), error: null });
  const tables = { event_updates: [{ id: UPDATE, event_id: EVENT_ID }], events: [{ id: EVENT_ID, organiser_user_id: A }] };

  test('an unrelated signed-in user is refused', async () => {
    const d = await EventUpdate.authoriseEventUpdateNotify(fakeSvc(tables, scanners(A)), user(B), { updateId: UPDATE });
    assert.equal(d.ok, false);
    assert.equal(d.status, 403);
  });

  test('someone can_scan_event authorises (business owner, hub owner / committee, platform admin) is allowed', async () => {
    const svc = fakeSvc(tables, scanners(A));
    assert.equal((await EventUpdate.authoriseEventUpdateNotify(svc, user(A), { updateId: UPDATE })).ok, true);
    assert.deepEqual(svc.rpcCalls.map((c) => [c.name, c.args]), [['can_scan_event', { p_event_id: EVENT_ID, p_user_id: A }]]);
  });

  test('a bare organiser_user_id confers nothing: the row creator is refused when the database says they no longer control the organiser', async () => {
    const d = await EventUpdate.authoriseEventUpdateNotify(fakeSvc(tables, scanners()), user(A), { updateId: UPDATE });
    assert.equal(d.ok, false);
    assert.equal(d.status, 403);
  });

  test('a database error fails closed', async () => {
    const svc = fakeSvc(tables, () => ({ data: null, error: { message: 'boom' } }));
    assert.equal((await EventUpdate.authoriseEventUpdateNotify(svc, user(A), { updateId: UPDATE })).status, 403);
  });

  test('the gate never reads organiser_user_id or the owner tables itself', () => {
    const src = read('supabase/functions/_shared/event-update-notify-auth.ts').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(src, /organiser_user_id|organiser_business_id|organiser_hub_id|from\('(events|hubs|local_businesses|profiles)'\)/);
  });

  test('an update that does not exist is a 404; the service role is trusted', async () => {
    const svc = fakeSvc({ event_updates: [] });
    assert.equal((await EventUpdate.authoriseEventUpdateNotify(svc, user(A), { updateId: UPDATE })).status, 404);
    assert.equal((await EventUpdate.authoriseEventUpdateNotify(svc, service, { updateId: UPDATE })).ok, true);
  });
});

