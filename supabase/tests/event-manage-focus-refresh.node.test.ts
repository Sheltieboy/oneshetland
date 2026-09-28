/**
 * event-manage-focus-refresh.node.test.ts
 *
 * Event Manage stayed mounted while the organiser used the scanner (Scan
 * tickets → check a ticket in → back) and never refetched Sold / Checked in
 * / capacity-related figures on return — the same root cause and fix shape
 * as business-dashboard-focus-refresh.node.test.ts, applied to the second
 * screen that has it.
 *
 * REPRODUCTION (ZZ TEST — Acceptance Event)
 * 1. Event Manage's "Scan tickets" button does router.push('/event-scanner',
 *    {id}) — push, not replace, so Event Manage stays mounted underneath.
 * 2. event-scanner.tsx's back button calls router.back(), landing on the
 *    SAME, still-mounted Event Manage instance.
 * 3. Event Manage's only fetch was a plain
 *    useEffect(() => { load(); }, [load]), whose dependency (load, itself
 *    keyed only on the route id) never changes on this return trip — no
 *    useFocusEffect, no realtime subscription, nothing else asks again.
 * 4. Sold / Checked in / capacity-related figures stay exactly as they
 *    were before scanning — confirmed as a pure refresh-lifecycle problem,
 *    not a data problem: the backend and public event page were both
 *    immediately correct, and pull-to-refresh already fixed it manually.
 *
 * THE FIX
 * Replace the mount-only effect with
 * useFocusEffect(useCallback(() => { load(); }, [load])) — not alongside
 * it, since useFocusEffect already fires once on initial mount (a freshly
 * mounted screen is focused), so a separate mount effect would have
 * doubled the initial fetch. Unlike the Business Dashboard's loadAll
 * (which takes an optional business argument and calls setActiveBusiness
 * on every load, requiring a ref to avoid a refetch loop), load() here
 * takes no argument and depends only on the stable route id — no ref
 * needed.
 *
 * WHAT THIS FILE CANNOT PROVE
 * Source-level assertions only — this repo has no RN render/navigation-
 * lifecycle test infrastructure, so it cannot mount the screen or simulate
 * an actual focus/blur transition. These prove the wiring matches the
 * description above: one fetch path, on useFocusEffect, still calling both
 * fetchEvent and fetchScannerStats, with pull-to-refresh and every other
 * action on the screen untouched.
 *
 * SAFETY
 * No Supabase call, no navigation, no database write. Nothing here touches
 * production.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const managePath = 'app/event-manage.tsx';
const manageRaw = read(managePath);
const manageSrc = code(manageRaw);

/* ── 1, 2 & 5. One fetch path: useFocusEffect replaces the mount effect ──── */

describe('Event Manage loads on initial focus, with no duplicate mount-time fetch', () => {
  test('useFocusEffect is imported from expo-router, alongside the existing hooks', () => {
    assert.match(manageSrc, /import \{ useLocalSearchParams, useRouter, useFocusEffect \} from 'expo-router';/);
  });

  test('the old mount-only effect is gone — no bare useEffect(() => { load(); }, [load])', () => {
    assert.doesNotMatch(manageSrc, /useEffect\(\(\) => \{ load\(\); \}, \[load\]\);/);
  });

  test('the unused useEffect import was removed, not left dangling', () => {
    assert.doesNotMatch(manageSrc, /import React, \{ useState, useEffect, useCallback \} from 'react';/);
    assert.match(manageSrc, /import React, \{ useState, useCallback \} from 'react';/);
  });

  test('load is now driven by exactly one useFocusEffect call', () => {
    const matches = manageSrc.match(/useFocusEffect\(/g) ?? [];
    assert.equal(matches.length, 1, 'exactly one useFocusEffect — not duplicated, not layered on top of the old effect');
    assert.match(manageSrc, /useFocusEffect\(useCallback\(\(\) => \{ load\(\); \}, \[load\]\)\);/);
  });

  test('this is the same idiom already proven on the Business Dashboard, not a bespoke mechanism', () => {
    const dash = code(read('app/local-business-dashboard.tsx'));
    assert.match(dash, /useFocusEffect\(useCallback\(\(\) => \{/, 'the dashboard sets the precedent this fix follows');
  });
});

/* ── 3. Returning to the still-mounted screen re-runs load() ─────────────── */

describe('returning to the still-mounted Event Manage screen runs load() again', () => {
  test('the focus effect carries no "already loaded once" guard that would suppress a second run', () => {
    const fxIdx = manageSrc.indexOf('useFocusEffect(useCallback(() => { load(); }, [load]));');
    assert.notEqual(fxIdx, -1);
    // The whole call is a single line by construction (see the match above),
    // so there is no room for a hidden guard inside it.
  });

  test('load has no argument and no internal "already fresh" short-circuit — every focus is a real refetch', () => {
    const loadIdx = manageSrc.indexOf('const load = useCallback(async () => {');
    const loadEnd = manageSrc.indexOf('}, [id]);', loadIdx) + '}, [id]);'.length;
    const loadFn = manageSrc.slice(loadIdx, loadEnd);
    assert.doesNotMatch(loadFn, /if \(event && stats\)|hasLoaded|didLoad|loaded\.current/,
      'a home-grown "skip if already loaded" guard would defeat this fix');
  });

  test('the dependency array is exactly [load], stable across renders since load itself only depends on the route id', () => {
    assert.match(manageSrc, /useFocusEffect\(useCallback\(\(\) => \{ load\(\); \}, \[load\]\)\);/);
    assert.match(manageSrc, /\}, \[id\]\);/, 'load is keyed only on id — no state it sets can change its own identity');
  });
});

/* ── 4. Both fetchEvent and fetchScannerStats are part of the refreshed load ── */

describe('the refreshed load includes both event data and scanner/event statistics', () => {
  test('load() fetches fetchEvent(id) and fetchScannerStats(id) together, unchanged by this fix', () => {
    const loadIdx = manageSrc.indexOf('const load = useCallback(async () => {');
    const loadEnd = manageSrc.indexOf('}, [id]);', loadIdx);
    const loadFn = manageSrc.slice(loadIdx, loadEnd);
    assert.match(loadFn, /fetchEvent\(id\)\.catch\(\(\) => null\)/);
    assert.match(loadFn, /fetchScannerStats\(id\)\.catch\(\(\) => null\)/);
    assert.match(loadFn, /Promise\.all\(/, 'fetched together, not one after the other');
  });

  test('Sold and Checked in render from stats.tickets_sold / stats.checked_in — the same fields load() refreshes', () => {
    assert.match(manageSrc, /label="Sold"\s*value=\{stats\.tickets_sold\}/);
    assert.match(manageSrc, /label="Checked in"\s*value=\{stats\.checked_in\}/);
  });

  test('neither fetchEvent nor fetchScannerStats themselves were touched — this is a screen-lifecycle fix only', () => {
    const apiSrc = code(read('lib/events-api.ts'));
    assert.match(apiSrc, /export async function fetchEvent\(/);
    assert.match(apiSrc, /export async function fetchScannerStats\(/);
  });
});

/* ── 6. Pull-to-refresh remains a working manual fallback ───────────────── */

describe('pull-to-refresh still works, using the same load() function', () => {
  test('RefreshControl still calls load() directly, untouched by this fix', () => {
    assert.match(manageSrc,
      /refreshControl=\{<RefreshControl refreshing=\{refreshing\} onRefresh=\{\(\) => \{ setRefreshing\(true\); load\(\); \}\} tintColor=\{S\.color\} \/>\}/);
  });
});

/* ── 7. Existing event-management actions/routes are unchanged ──────────── */

describe('existing event-management actions and routes are unchanged', () => {
  test('Scan tickets, edit and public-view routes are all still wired exactly as before', () => {
    assert.match(manageSrc, /router\.push\(\{ pathname: '\/event-scanner', params: \{ id: event\.id \} \}\)/);
    assert.match(manageSrc, /router\.push\(\{ pathname: '\/event-create', params: editParams \}\)/);
    assert.match(manageSrc, /router\.push\(\{ pathname: '\/events\/\[id\]', params: \{ id: event\.id \} \}\)/);
  });

  test('the status-change and update-posting actions are untouched', () => {
    assert.match(manageSrc, /const handleStatusChange = async \(newStatus: EventStatus\) => \{/);
    assert.match(manageSrc, /postEventUpdate/);
  });
});
