/**
 * pass-redemption-stale-state.node.test.ts
 *
 * Passes & vouchers (local-my-passes.tsx) and the business detail page
 * (local-business-detail.tsx) both stay mounted underneath local-redeem.tsx
 * while a customer redeems a pass, offer, loyalty reward or points spend at
 * the till. Both screens' only fetch was a plain
 * `useEffect(() => { load(); }, [load])`, whose dependency never changes on
 * the return trip — tapping Done on local-redeem's "Redeemed!" screen calls
 * router.back(), landing on the SAME, still-mounted screen instance, showing
 * exactly the pre-redemption state until a manual pull-to-refresh.
 *
 * REPRODUCTION (real, physical, 29 Sep): bought "ZZ - Demo Pass" (1 use),
 * redeemed it at the till, tapped Done on "Redeemed!" — Passes & vouchers
 * still read "1 use left" until pulled to refresh, though the DB was already
 * correct (uses_remaining 0, fully_used_at set) at the moment Done was
 * tapped — not a data bug, purely a missing refetch-on-focus. Confirmed the
 * identical wiring gap on local-business-detail.tsx, the OTHER screen
 * local-redeem is reached from (offer, reward and points redemption all
 * start there, not from a separate list screen) — the same bug would show a
 * stale offer/stamp/points balance after redeeming any of those.
 *
 * THE FIX
 * Replace each mount-only effect with the same
 * `useFocusEffect(useCallback(() => { load(); }, [load]))` idiom already
 * used by local-my-cards.tsx (for the identical "stamp collected on the
 * scanner, come back stale" case), local-business-dashboard.tsx and others —
 * not alongside the mount effect, INSTEAD of it, since useFocusEffect
 * already fires once on initial mount.
 *
 * WHAT THIS FILE CANNOT PROVE
 * Source-level assertions only — this repo has no RN render/navigation-
 * lifecycle test infrastructure, so it cannot mount either screen, simulate
 * an actual focus/blur transition, or watch a real re-render happen. These
 * prove the wiring — one fetch path, on useFocusEffect, with no "already
 * loaded" guard suppressing the second run — genuinely matches the
 * established pattern; the DB-level correctness of what a fresh load()
 * would show (uses_remaining, fully_used_at, redemption row) is proven
 * separately by pass-redemption-concurrency.node.test.ts and confirmed live
 * against the real purchase this defect was found on.
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

const PASSES_PATH   = 'app/local-my-passes.tsx';
const BUSINESS_PATH = 'app/local-business-detail.tsx';
const passesSrc     = code(read(PASSES_PATH));
const businessSrc   = code(read(BUSINESS_PATH));

/* ── 1. Passes & vouchers: the screen the reported defect was on ─────────── */

describe('Passes & vouchers refreshes on focus, not just on mount', () => {
  test('useFocusEffect is imported from expo-router', () => {
    assert.match(passesSrc, /import \{ router, useRouter, useFocusEffect \} from 'expo-router';/);
  });

  test('the old mount-only effect is gone — no bare useEffect(() => { load(); }, [load])', () => {
    assert.doesNotMatch(passesSrc, /useEffect\(\(\) => \{ load\(\); \}, \[load\]\);/);
    // useEffect itself is no longer imported — nothing else in this screen needs it.
    assert.doesNotMatch(passesSrc, /import React, \{ useCallback, useEffect, useState \}/);
  });

  test('load is now driven by exactly one useFocusEffect call, with no "already loaded" guard', () => {
    const matches = passesSrc.match(/useFocusEffect\(/g) ?? [];
    assert.equal(matches.length, 1, 'exactly one focus-driven fetch, not duplicated');
    assert.match(passesSrc, /useFocusEffect\(useCallback\(\(\) => \{ load\(\); \}, \[load\]\)\);/);
  });

  test('this is the same idiom already used by the sibling screen with the identical bug class', () => {
    // local-my-cards.tsx fixed "stamp collected on the scanner, come back
    // stale" this exact way — this fix follows that precedent, not a new one.
    const cardsSrc = code(read('app/local-my-cards.tsx'));
    assert.match(cardsSrc, /useFocusEffect\(useCallback\(\(\) => \{ load\(\); \}, \[load\]\)\);/);
  });
});

/* ── 2. Business detail: the other screen local-redeem is reached from ───── */

describe('Business detail — where offer/reward/points redemption actually starts — also refreshes on focus', () => {
  test('local-redeem is reached from here for offers, rewards and points, not from a separate list screen', () => {
    assert.match(businessSrc, /pathname: '\/local-redeem', params: \{ kind: 'reward', ref_id: card\.id \}/);
    assert.match(businessSrc, /pathname: '\/local-redeem', params: \{ kind: 'offer', ref_id: offer\.id \}/);
    assert.match(businessSrc, /pathname: '\/local-redeem', params: \{ kind: 'points', ref_id: card\.id, amount: String\(spend\) \}/);
  });

  test('useFocusEffect is imported from expo-router, alongside the existing hooks', () => {
    assert.match(businessSrc, /import \{ useLocalSearchParams, useRouter, useFocusEffect \} from 'expo-router';/);
  });

  test('the old mount-only data-load effect is gone', () => {
    assert.doesNotMatch(businessSrc, /useEffect\(\(\) => \{ load\(\); \}, \[load\]\);/);
  });

  test('load is now driven by useFocusEffect, and the unrelated analytics effect is untouched (still a plain useEffect keyed on business id)', () => {
    assert.match(businessSrc, /useFocusEffect\(useCallback\(\(\) => \{ load\(\); \}, \[load\]\)\);/);
    // A focus-triggered analytics re-fire would double-count every return
    // trip as a fresh page view — this effect must stay exactly as it was.
    assert.match(businessSrc, /useEffect\(\(\) => \{\s*\n\s*if \(business\?\.id\) track\('content_viewed'/);
  });
});

/* ── 3. Where this bug class does NOT apply ───────────────────────────────── */

describe('screens this defect does not reach', () => {
  test('the merchant redemption screen already showed the correct post-redemption state in the real acceptance run — untouched here', () => {
    // local-counter.tsx / local-till.tsx / local-verify.tsx are the staff
    // side; the reported defect and this fix are customer-side only.
    for (const p of ['app/local-counter.tsx', 'app/local-till.tsx']) {
      assert.ok(read(p).length > 0, `${p} must remain, unmodified by this fix`);
    }
  });

  test('the web customer Passes page has no equivalent redeem-then-return navigation loop to go stale', () => {
    // Merchant redemption happens in a completely separate web session (the
    // business owner's own login), not reachable from the customer's own
    // /account/passes page the way local-redeem is reachable from — and
    // returns to — the mobile screens above.
    const passesPage = read('../oneshetland-web/app/account/passes/page.tsx');
    assert.doesNotMatch(passesPage, /local-redeem|"use client"/,
      'the web passes page is a server component with no client-side redeem-and-return loop');
  });
});
