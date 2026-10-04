/**
 * app-preview-shell.node.test.ts — guard rails for the App Home V2 / Local V2 PREVIEW (shell, typography, compact top).
 * Not a design acceptance. What must never regress:
 *   • the preview display font resolves to files that really exist (the shared DisplayText's paths do NOT — that is
 *     the bug; the shared component is intentionally untouched)
 *   • the previews use that font, not the broken shared component
 *   • the preview shell is development-only and reuses the real AppTabBar; production tabs/home/local are untouched
 *   • all six Local pillars stay; none dropped for compactness
 *   • nothing in the preview writes data
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (rel: string) => readFileSync(join(REPO, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const PREVIEW_FILES = ['app/preview/home-v2.tsx', 'app/preview/local-v2.tsx', 'app/preview/_layout.tsx', ...readdirSync(join(REPO, 'components/preview-v2')).filter((f) => /\.tsx?$/.test(f)).map((f) => `components/preview-v2/${f}`)];

describe('display typography', () => {
  test('every font file the preview requires exists in the installed package', () => {
    const reqs = [...src('components/preview-v2/PreviewDisplayText.tsx').matchAll(/require\('(@expo-google-fonts\/fraunces\/[^']+\.ttf)'\)/g)].map((m) => m[1]);
    assert.ok(reqs.length >= 3);
    for (const r of reqs) assert.ok(existsSync(join(REPO, 'node_modules', r)), r);
  });
  test('the shared DisplayText paths are the broken ones (documented, deliberately not edited here)', () => {
    const shared = readFileSync(join(REPO, 'components/DisplayText.tsx'), 'utf8');
    const m = shared.match(/require\('(@expo-google-fonts\/fraunces\/Fraunces_900Black\.ttf)'\)/);
    assert.ok(m, 'shared component still requires the flat path');
    assert.equal(existsSync(join(REPO, 'node_modules', m![1])), false, 'flat path does not exist in package 0.4.1');
  });
  test('no preview file imports the shared DisplayText', () => {
    for (const f of PREVIEW_FILES) assert.doesNotMatch(src(f), /from '(\.\.\/)+components\/DisplayText'|from '\.\.\/DisplayText'/, f);
  });
});

describe('the preview shell', () => {
  test('is development-only and wraps the REAL AppTabBar', () => {
    const l = src('app/preview/_layout.tsx');
    assert.match(l, /__DEV__/);
    assert.match(l, /<Redirect href="\/" \/>/);
    assert.match(l, /from '@\/components\/AppTabBar'/);
    assert.match(l, /<AppTabBar /);
  });
  test('production tabs, Home and Local do not reference the preview', () => {
    for (const f of ['app/(tabs)/_layout.tsx', 'app/(tabs)/index.tsx', 'app/(tabs)/local.tsx', 'components/AppTabBar.tsx', 'components/DisplayText.tsx']) {
      assert.doesNotMatch(src(f), /preview/i, f);
    }
  });
  test('the review switch takes no layout space (floating) and can be hidden for captures', () => {
    assert.match(src('components/preview-v2/PreviewSwitch.tsx'), /position: 'absolute'/);
    assert.match(src('app/preview/home-v2.tsx'), /chrome !== '0'/);
    assert.match(src('app/preview/local-v2.tsx'), /chrome !== '0'/);
  });
});

describe('Local keeps all six pillars, compactly', () => {
  test('Shop · Offers · Book · Experiences · Businesses · Rewards are all present', () => {
    const l = src('app/preview/local-v2.tsx');
    for (const p of ['Shop', 'Offers', 'Book', 'Experiences', 'Businesses', 'Rewards']) assert.match(l, new RegExp(`<PillarTile label="${p}"`), p);
    assert.equal((l.match(/<PillarTile /g) ?? []).length, 6);
  });
  test('the tiles are short and the count is secondary text', () => {
    const ui = src('components/preview-v2/ui.tsx');
    assert.match(ui, /h = 72/);
    assert.match(ui, /fontSize: 10\.5/);
  });
  test('Featured locally has a Directory route and a fallback, so it never vanishes', () => {
    const l = src('app/preview/local-v2.tsx');
    assert.match(l, /action="Browse directory"/);
    assert.match(l, /\(tabs\)\/services/);
    assert.match(l, /Browse the directory/);
  });
});

describe('Home top is compact', () => {
  test('identity, wallet, alerts, profile, search, audience and Shetland-now all remain', () => {
    const h = src('app/preview/home-v2.tsx');
    for (const needle of ['OneShetland', 'Wallet, £12.50', 'Notifications', 'Profile', 'Search Shetland', 'Live here', 'Visiting', 'data?.weather']) assert.ok(h.includes(needle), needle);
  });
  test('the old tall header furniture is gone (no big audience segment, no boxed now-strip)', () => {
    const h = src('app/preview/home-v2.tsx');
    assert.doesNotMatch(h, /I live here<\/Text>|seg:|segItem/);
    assert.doesNotMatch(h, /height: insets\.top, backgroundColor: '#0F172A'/);
  });
});

describe('preview-only', () => {
  test('no write calls anywhere in the app preview', () => {
    for (const f of PREVIEW_FILES) assert.doesNotMatch(src(f), /\.(insert|update|upsert|rpc)\(|\)\.delete\(/, f);
  });
});
