/**
 * mobile-analytics-consent.node.test.ts — mobile analytics is genuinely opt-in.
 *
 * Physical/legal defect (found during the Privacy Policy audit, fixed 28 Sep
 * 2026): the app's DEFAULT_CONSENT was `true` (opt-out), and `initAnalytics()`
 * created and PERSISTED an analytics id on every launch regardless of consent —
 * so a device that had never been asked already had an identifier sitting on
 * disk, and any analytics call before the user touched the Settings toggle
 * queued and transmitted.
 *
 * What this pins, against the REAL source (lib/analytics.ts), not a rewrite:
 *   - a device that has never chosen: no id created, none persisted, nothing
 *     queued, nothing transmitted;
 *   - explicit opt-in creates and persists an id, and un-blocks tracking;
 *   - explicit opt-out (whether from fresh or from a prior opt-in) clears any
 *     id from storage and drops anything queued;
 *   - the choice survives a restart (a fresh module load reading the same
 *     backing store — the closest a Node harness gets to relaunching the app);
 *   - CONSENT_KEY is written ONLY by the toggle, which is what makes a missing
 *     value safe to treat as "never asked" rather than "the old default";
 *   - signed-in vs signed-out (identifyAnalytics) does not itself gate consent.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** An in-memory AsyncStorage. Pass the SAME store into two loads to simulate a restart. */
function fakeStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    getItem:    async (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem:    async (k: string, v: string) => { store.set(k, v); },
    removeItem: async (k: string) => { store.delete(k); },
  };
}

function fakeSupabase() {
  const rpcCalls: { name: string; args: unknown }[] = [];
  return { rpcCalls, rpc: async (name: string, args: unknown) => { rpcCalls.push({ name, args }); return { data: null, error: null }; } };
}

/** Loads the real lib/analytics.ts fresh, wired to the given (shared, for "restart") backing store. */
function load(storage: ReturnType<typeof fakeStorage>, sb = fakeSupabase()) {
  const mod = loadModule('lib/analytics.ts', {
    '@react-native-async-storage/async-storage': storage,
    'expo-constants': { expoConfig: { version: '1.0.0' } },
    'react-native': { Platform: { OS: 'ios' }, AppState: { addEventListener: () => ({ remove() {} }) } },
    './supabase': { supabase: sb },
  });
  return { mod, sb };
}

/* ── 1. Fresh install / no stored preference ─────────────────────────────── */

describe('a device that has never chosen', () => {
  test('consent reads as off, before init and after', async () => {
    const { mod } = load(fakeStorage());
    assert.equal(mod.getAnalyticsConsent(), false, 'off before init() — the in-module default');
    await mod.initAnalytics();
    assert.equal(mod.getAnalyticsConsent(), false, 'still off once the (empty) stored value is read');
  });

  test('no analytics id is created or persisted', async () => {
    const storage = fakeStorage();
    const { mod } = load(storage);
    await mod.initAnalytics();
    assert.equal(storage.store.has('os_analytics_anon_id'), false);
  });

  test('track() neither queues nor transmits', async () => {
    const storage = fakeStorage();
    const { mod, sb } = load(storage);
    await mod.initAnalytics();
    mod.track('viewed_event', { objectType: 'event', objectId: 'e1' });
    assert.equal(mod.__analyticsDebug.queueLength, 0, 'nothing queued');
    await mod.flushAnalytics();
    assert.equal(sb.rpcCalls.length, 0, 'nothing sent to log_events');
    assert.equal(storage.store.has('os_analytics_anon_id'), false, 'track() must not create one either');
  });

  test('CONSENT_KEY itself is not written just by using the app', async () => {
    const storage = fakeStorage();
    const { mod } = load(storage);
    await mod.initAnalytics();
    mod.track('opened_app');
    await mod.flushAnalytics();
    assert.equal(storage.store.has('os_analytics_consent'), false, 'silence is not a recorded choice');
  });
});

/* ── 2. Explicit opt-in ───────────────────────────────────────────────────── */

describe('explicit opt-in', () => {
  test('turning it on persists the choice and creates exactly one id', async () => {
    const storage = fakeStorage();
    const { mod } = load(storage);
    await mod.initAnalytics();
    await mod.setAnalyticsConsent(true);
    assert.equal(storage.store.get('os_analytics_consent'), 'true');
    assert.equal(typeof storage.store.get('os_analytics_anon_id'), 'string');
    assert.match(storage.store.get('os_analytics_anon_id')!, /^[0-9a-f-]{36}$/);
  });

  test('tracking now queues and transmits, carrying that id', async () => {
    const storage = fakeStorage();
    const { mod, sb } = load(storage);
    await mod.initAnalytics();
    await mod.setAnalyticsConsent(true);
    mod.track('viewed_event', { objectType: 'event', objectId: 'e1' });
    assert.equal(mod.__analyticsDebug.queueLength, 1);
    await mod.flushAnalytics();
    assert.equal(sb.rpcCalls.length, 1);
    const [sent] = (sb.rpcCalls[0].args as { p_events: { anon_id: string; consent: boolean }[] }).p_events;
    assert.equal(sent.anon_id, storage.store.get('os_analytics_anon_id'));
    assert.equal(sent.consent, true);
  });

  test('opting in twice does not mint a second id', async () => {
    const storage = fakeStorage();
    const { mod } = load(storage);
    await mod.initAnalytics();
    await mod.setAnalyticsConsent(true);
    const first = storage.store.get('os_analytics_anon_id');
    await mod.setAnalyticsConsent(true);
    assert.equal(storage.store.get('os_analytics_anon_id'), first);
  });
});

/* ── 3. Explicit opt-out ──────────────────────────────────────────────────── */

describe('explicit opt-out', () => {
  test('from fresh: still nothing created, choice is recorded', async () => {
    const storage = fakeStorage();
    const { mod } = load(storage);
    await mod.initAnalytics();
    await mod.setAnalyticsConsent(false);
    assert.equal(storage.store.get('os_analytics_consent'), 'false');
    assert.equal(storage.store.has('os_analytics_anon_id'), false);
  });

  test('after having opted in: the id is deleted from storage, not just ignored', async () => {
    const storage = fakeStorage();
    const { mod } = load(storage);
    await mod.initAnalytics();
    await mod.setAnalyticsConsent(true);
    assert.ok(storage.store.has('os_analytics_anon_id'));
    await mod.setAnalyticsConsent(false);
    assert.equal(storage.store.has('os_analytics_anon_id'), false);
  });

  test('anything already queued is dropped, not sent on the next flush', async () => {
    const storage = fakeStorage();
    const { mod, sb } = load(storage);
    await mod.initAnalytics();
    await mod.setAnalyticsConsent(true);
    mod.track('viewed_event');
    assert.equal(mod.__analyticsDebug.queueLength, 1);
    await mod.setAnalyticsConsent(false);
    assert.equal(mod.__analyticsDebug.queueLength, 0, 'opting out clears the pending queue');
    await mod.flushAnalytics();
    assert.equal(sb.rpcCalls.length, 0);
  });

  test('a stray pre-existing id on disk (from the old default-on code) is removed on the next init if never consented', async () => {
    // Simulates a device that ran the OLD buggy build: it has an id on disk but
    // CONSENT_KEY was never written (the old code never wrote it either).
    const storage = fakeStorage({ os_analytics_anon_id: 'stale-pre-fix-id' });
    const { mod } = load(storage);
    await mod.initAnalytics();
    assert.equal(mod.getAnalyticsConsent(), false, 'no consent record ⇒ off, per the fix');
    assert.equal(storage.store.has('os_analytics_anon_id'), false, 'the leftover id must not linger unused');
  });
});

/* ── 4. App restart ───────────────────────────────────────────────────────── */

describe('app restart (a fresh module load against the same storage)', () => {
  test('a device that opted in stays opted in, with the SAME id, across restart', async () => {
    const storage = fakeStorage();
    const first = load(storage);
    await first.mod.initAnalytics();
    await first.mod.setAnalyticsConsent(true);
    const id = storage.store.get('os_analytics_anon_id');

    const second = load(storage); // new module instance = simulated relaunch
    await second.mod.initAnalytics();
    assert.equal(second.mod.getAnalyticsConsent(), true);
    assert.equal(storage.store.get('os_analytics_anon_id'), id, 'no new id minted on restart');
    second.mod.track('viewed_event');
    await second.mod.flushAnalytics();
    assert.equal(second.sb.rpcCalls.length, 1);
    const [sent] = (second.sb.rpcCalls[0].args as { p_events: { anon_id: string }[] }).p_events;
    assert.equal(sent.anon_id, id);
  });

  test('a device that opted out stays opted out across restart, and stays clean', async () => {
    const storage = fakeStorage();
    const first = load(storage);
    await first.mod.initAnalytics();
    await first.mod.setAnalyticsConsent(false);

    const second = load(storage);
    await second.mod.initAnalytics();
    assert.equal(second.mod.getAnalyticsConsent(), false);
    assert.equal(storage.store.has('os_analytics_anon_id'), false);
    second.mod.track('viewed_event');
    assert.equal(second.mod.__analyticsDebug.queueLength, 0);
  });

  test('a device that never chose is STILL off after a restart — the old default cannot resurface', async () => {
    const storage = fakeStorage();
    const first = load(storage);
    await first.mod.initAnalytics();
    // deliberately: no setAnalyticsConsent call at all

    const second = load(storage);
    await second.mod.initAnalytics();
    assert.equal(second.mod.getAnalyticsConsent(), false);
    assert.equal(storage.store.has('os_analytics_anon_id'), false);
  });
});

/* ── 5. Signed-in vs signed-out ───────────────────────────────────────────── */

describe('sign-in state does not itself grant or imply consent', () => {
  test('identifyAnalytics (called on auth state change) never touches consent or the id', async () => {
    const storage = fakeStorage();
    const { mod } = load(storage);
    await mod.initAnalytics();
    mod.identifyAnalytics('user'); // e.g. the app calling this right after sign-in
    assert.equal(mod.getAnalyticsConsent(), false, 'signing in must not turn analytics on');
    assert.equal(storage.store.has('os_analytics_anon_id'), false);
    mod.track('viewed_event');
    assert.equal(mod.__analyticsDebug.queueLength, 0);
  });

  test('an opted-in choice carries across a sign-out (identifyAnalytics("visitor"))', async () => {
    const storage = fakeStorage();
    const { mod } = load(storage);
    await mod.initAnalytics();
    await mod.setAnalyticsConsent(true);
    mod.identifyAnalytics('visitor'); // signed out
    assert.equal(mod.getAnalyticsConsent(), true, 'consent is a device choice, not tied to session state');
  });
});

/* ── 6. The source itself: no other path can create/write these before consent ── */

describe('the source guarantees this structurally, not just by these scenarios', () => {
  const src = readFileSync(join(REPO_ROOT, 'lib', 'analytics.ts'), 'utf8');

  test('DEFAULT_CONSENT is false', () => {
    assert.match(src, /const DEFAULT_CONSENT = false/);
  });

  test('CONSENT_KEY has exactly one writer: setAnalyticsConsent', () => {
    const writes = [...src.matchAll(/AsyncStorage\.setItem\(CONSENT_KEY/g)];
    assert.equal(writes.length, 1);
  });

  test('ANON_KEY is only ever created/persisted inside the consent-gated syncAnonId helper', () => {
    const writes = [...src.matchAll(/AsyncStorage\.setItem\(ANON_KEY/g)];
    assert.equal(writes.length, 1);
    const fn = src.slice(src.indexOf('async function syncAnonId'), src.indexOf('/** Load persisted consent'));
    assert.match(fn, /if \(consent\)/);
  });

  test('a missing CONSENT_KEY resolves to DEFAULT_CONSENT, never to true unconditionally', () => {
    assert.match(src, /consent = c === null \? DEFAULT_CONSENT : c === 'true'/);
  });
});
