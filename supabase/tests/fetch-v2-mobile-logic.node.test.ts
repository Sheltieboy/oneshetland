/**
 * fetch-v2-mobile-logic.node.test.ts — Fetch v2 in the app (Step 12): the shared client contract, the app-only rules, and the brief's
 * UX scenarios A–J. Pure modules only (lib/fetch-api.ts, lib/fetch/{present,flow,scenarios,mobile}.ts); a fake transport stands in for
 * Supabase, so nothing here touches a network, a database or production.
 *
 * Also proves web/app parity: the shared modules are byte-identical to the website's (Step 11), so both describe every state the same way.
 *
 * Run: node --test supabase/tests/fetch-v2-mobile-logic.node.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FetchApi, FETCH_RPCS, FETCH_EDGES, FETCH_MESSAGES } from '../../lib/fetch-api.ts';
import { createInput, driverActions, requesterActions, stepProblems } from '../../lib/fetch/flow.ts';
import { bankCheckResult, driverStatus, matchLabel, moneyLines, requesterStatus, timelineFor } from '../../lib/fetch/present.ts';
import { QUOTE_PARCEL, QUOTE_SOFA, RUN_SATURDAY, scenarios } from '../../lib/fetch/scenarios.ts';
import { FETCH_HOME, accessFrom, directionsFallback, directionsUrl, fetchRouteFor, lostAccess, photoPlan, v1Forward } from '../../lib/fetch/mobile.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = process.env.FETCH_WEB_ROOT ?? join(REPO_ROOT, '..', 'oneshetland-web-fetch-v2');
const ID = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-10-21T12:00:00Z');
const at = (h: number) => new Date(NOW + h * 3600_000).toISOString();

function fake(reply: { rpc?: (fn: string) => unknown; invoke?: (fn: string) => unknown } = {}) {
  const calls: { via: string; fn: string; body?: Record<string, unknown> }[] = [];
  const api = new FetchApi({
    rpc: async (fn) => { calls.push({ via: 'rpc', fn }); return (reply.rpc?.(fn) ?? { data: { ok: true }, error: null }) as never; },
    invoke: async (fn, body) => { calls.push({ via: 'edge', fn, body }); return (reply.invoke?.(fn) ?? { data: { ok: true }, error: null }) as never; },
    read: async (table) => { calls.push({ via: 'read', fn: table }); return { data: [], error: null }; },
  });
  return { api, calls };
}

describe('web and app share one contract and one vocabulary', () => {
  const shared = ['lib/fetch-api.ts', 'lib/fetch/present.ts', 'lib/fetch/flow.ts', 'lib/fetch/scenarios.ts'];
  for (const f of shared) {
    test(`${f} is byte-identical to the website's`, { skip: !existsSync(join(WEB_ROOT, f)) && 'web Fetch v2 worktree not present' }, () => {
      assert.equal(readFileSync(join(REPO_ROOT, f), 'utf8'), readFileSync(join(WEB_ROOT, f), 'utf8'));
    });
  }
});

describe('the shared client', () => {
  test('calls only allow-listed functions; the create body carries no money, status or driver even if a caller adds them', async () => {
    const { api, calls } = fake();
    const place = { region_id: ID, address: '1 Example Quay' };
    await api.create({ idempotency_key: 'abcdefgh12', size_class: 'bulky', pickup: place, destination: place, category_slug: 'furniture', item_description: 'Sofa',
      contact_phone: '07000 000000', scheduling_mode: 'asap', ...({ total_fee_pence: 1, status: 'matched', driver_id: ID } as object) });
    await api.accept(ID, true); await api.deliver(ID, true); await api.board(true); await api.cancelOpen(ID);
    for (const c of calls) {
      if (c.via === 'rpc') assert.ok((FETCH_RPCS as readonly string[]).includes(c.fn), c.fn);
      if (c.via === 'edge') {
        assert.ok((FETCH_EDGES as readonly string[]).includes(c.fn), c.fn);
        for (const k of Object.keys(c.body ?? {})) assert.ok(!/pence|price|amount|fee|total|hold|status|driver_id/i.test(k), `${c.fn} sends ${k}`);
      }
    }
  });
  test('a retried post reuses the key; refusals come back as plain words', async () => {
    const { api, calls } = fake({ invoke: (fn) => (fn === 'fetch-v2-accept' ? { data: null, error: { code: 'already_taken' } } : { data: { ok: true, request_id: ID }, error: null }) });
    const input = { idempotency_key: 'same-key-123', size_class: 'small' as const, pickup: { region_id: ID, address: 'a' }, destination: { region_id: ID, address: 'b' },
      category_slug: 'parcel', item_description: 'Box', contact_phone: '07000 000000', scheduling_mode: 'asap' as const };
    await api.create(input); await api.create(input);
    assert.deepEqual(calls.map((c) => c.body?.idempotency_key), ['same-key-123', 'same-key-123']);
    const r = await api.accept(ID, true);
    assert.ok(!r.ok && r.code === 'already_taken' && r.message === 'Another driver accepted this Fetch just before you.');
    for (const code of ['driver_verification_expired', 'driver_payouts_not_enabled', 'too_large_for_vehicle', 'two_person_lift_required', 'payment_not_ready', 'capture_failed', 'payment_method_required', 'card_check_failed'])
      assert.ok(FETCH_MESSAGES[code] && !/_/.test(FETCH_MESSAGES[code]), code);
  });
});

describe('app-only rules (lib/fetch/mobile.ts)', () => {
  test('the server flag decides and fails closed', () => {
    assert.equal(accessFrom({ data: true, error: null }), 'on');
    for (const r of [{ data: false, error: null }, { data: null, error: { message: 'x' } }, { data: 'true', error: null }, null]) assert.equal(accessFrom(r), 'off');
    assert.ok(lostAccess('fetch_unavailable') && lostAccess('member_restricted') && !lostAccess('already_taken'));
  });
  test('Step 8 notifications open the matching screen; anything unknown or disallowed falls back to the Fetch home', () => {
    for (const route of [`/fetch/requests/${ID}`, `/fetch/requests/${ID}/payment`, `/fetch/jobs/${ID}`, `/fetch/board/${ID}`, '/fetch/driver/verification'])
      assert.equal(fetchRouteFor({ screen: 'fetch', route, kind: 'x', request_id: ID }), route);
    assert.equal(fetchRouteFor({ screen: 'fetch', route: `/admin/fetch/jobs/${ID}` }), FETCH_HOME);
    assert.equal(fetchRouteFor({ screen: 'fetch', route: '/fetch/jobs/not-an-id' }), FETCH_HOME);
    assert.equal(fetchRouteFor({ screen: 'fetch', route: 'https://evil.example/fetch/jobs/' + ID }), FETCH_HOME);
    assert.equal(fetchRouteFor({ screen: 'fetch', request_id: ID }), FETCH_HOME, 'a v1 payload (no route) still opens Fetch');
    assert.equal(fetchRouteFor({ screen: 'shifts' }), null, 'other features are untouched');
  });
  test('Android directions never use an Apple Maps link; every platform has a web fallback', () => {
    const a = '12 Hillhead, Lerwick';
    assert.equal(directionsUrl(a, 'ios'), 'maps://?daddr=12%20Hillhead%2C%20Lerwick');
    assert.equal(directionsUrl(a, 'android'), 'geo:0,0?q=12%20Hillhead%2C%20Lerwick');
    assert.ok(!directionsUrl(a, 'android').startsWith('maps:'));
    assert.equal(directionsFallback(a), 'https://www.google.com/maps/dir/?api=1&destination=12%20Hillhead%2C%20Lerwick');
  });
  test('every photo becomes a JPEG on the device (HEIC included), resized to 2048 px at most', () => {
    assert.deepEqual(photoPlan({ width: 4032, height: 3024, mimeType: 'image/heic' }), { resize: { width: 2048 }, format: 'jpeg', mime: 'image/jpeg', wasHeic: true });
    assert.deepEqual(photoPlan({ width: 3024, height: 4032, mimeType: 'image/heif' }).resize, { height: 2048 });
    assert.deepEqual(photoPlan({ width: 1200, height: 800, mimeType: 'image/png' }), { resize: null, format: 'jpeg', mime: 'image/jpeg', wasHeic: false });
    assert.equal(photoPlan({ width: 1600, height: 1200, mimeType: 'image/jpeg' }).mime, 'image/jpeg');
  });
  test('every old v1 screen forwards to v2; only saved addresses and payouts stay', () => {
    assert.equal(v1Forward('(customer)', 'dashboard'), FETCH_HOME);
    assert.equal(v1Forward('(customer)', 'request'), '/fetch/new');
    assert.equal(v1Forward('(customer)', 'request-detail', ID), `/fetch/requests/${ID}`);
    assert.equal(v1Forward('(customer)', 'request-detail', 'junk'), FETCH_HOME);
    assert.equal(v1Forward('(customer)', 'previous-requests'), '/fetch/history');
    assert.equal(v1Forward('(customer)', 'apply-driver'), '/fetch/drive/apply');
    assert.equal(v1Forward('(customer)', 'saved-addresses'), null);
    assert.equal(v1Forward('(driver)', 'dashboard'), '/fetch/drive');
    assert.equal(v1Forward('(driver)', 'create-run'), '/fetch/journeys/new');
    assert.equal(v1Forward('(driver)', 'request-detail', ID), `/fetch/jobs/${ID}`);
    assert.equal(v1Forward('(driver)', 'connect-bank'), null);
  });
});

describe('requester and driver flow (shared with the website)', () => {
  test('quote: lines, expected total, the hold separately with the exact sentence; ferry and minimum from the server', () => {
    const m = moneyLines(QUOTE_SOFA);
    assert.deepEqual(m.lines.map((l) => l[0]), ['Driver payment', 'Ferry journey extra', 'OneShetland fee']);
    assert.equal(m.total, 3300); assert.equal(m.hold, 5200);
    assert.equal(m.holdNote, 'The higher amount is only temporarily reserved in case there is waiting time or the item has to be returned. You are only charged for what actually happens.');
    assert.equal(QUOTE_PARCEL.minimum_applied, true);
  });
  test('create: large/bulky need measurements; the input holds no money', () => {
    assert.match(stepProblems(2, { pickup: {}, destination: {}, category_slug: 'furniture', item_description: 'Sofa', size_class: 'bulky' }).join(), /so the driver can make sure it will fit/);
    const c = createInput({ pickup: { region_id: 'a', address: 'x' }, destination: { region_id: 'b', address: 'y' }, category_slug: 'parcel', item_description: 'Box',
      size_class: 'small', scheduling_mode: 'asap', contact_phone: '07000 000000' }, 'key-12345678');
    assert.ok(!Object.keys(c).some((k) => /pence|price|fee|total|hold/.test(k)));
  });
  test('3DS: the server state decides (a confirmed hold is never reported as closed)', () => {
    assert.equal(bankCheckResult('authorised', 'cancelled').text, 'Payment authorisation confirmed.');
    assert.equal(bankCheckResult('requires_action', 'cancelled').ok, false);
  });
  test('statuses in words; only valid actions; collect only when payment is confirmed', () => {
    assert.equal(requesterStatus({ status: 'pending' }).label, 'Looking for someone');
    assert.equal(requesterStatus({ status: 'matched', payment_status: 'requires_action' }).label, 'Payment needs your attention');
    assert.equal(driverStatus({ status: 'matched', payment_status: 'authorised' }).label, 'Ready for collection');
    assert.ok(!driverActions({ status: 'matched', payment_status: 'requires_action', closed_at: null }, NOW).includes('collect'));
    assert.deepEqual(requesterActions({ status: 'delivered', closed_at: at(-73), driver: {} }, NOW), ['message']);
    assert.equal(matchLabel({ match: 'your_run', fits_run_id: RUN_SATURDAY(NOW).id }, [RUN_SATURDAY(NOW)]), 'Fits your Saturday journey');
  });
  test('scenarios A–J all produce human screens', () => {
    const all = scenarios(NOW);
    assert.deepEqual(all.map((x) => x.key).slice(0, 10), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    const raw = /\b(pending|matched|collected|undeliverable|requires_action|authorised)\b/;
    for (const sc of all) for (const screen of sc.screens) {
      const d = (screen as { detail?: { viewer: string; request: Record<string, unknown> } }).detail;
      if (!d) continue;
      const st = d.viewer === 'requester' ? requesterStatus(d.request) : driverStatus(d.request);
      assert.ok(st.label !== '—' && !raw.test(st.label + st.detail), `${sc.key}: ${st.label}`);
      if ('timeline' in screen) for (const e of timelineFor(d.viewer as 'requester', screen.timeline)) assert.ok(!/_/.test(e.text) && e.text.length > 3, e.text);
    }
  });
});
