/**
 * web-preview-v2.node.test.ts — guard rails for the Home V2 / Local V2 DESIGN PREVIEWS (not a design acceptance).
 *
 * The previews are judged by eye. These tests only stop the things that must never regress while they exist:
 *   • the live `/` and `/local` do not depend on, link to, or import the previews
 *   • the previews are unindexed and unlinked
 *   • public viewers never receive test / acceptance commerce; admin QA always gets it, visibly tagged
 *   • each pillar's presentation follows the inventory band (none / few / rail / many) by one rule
 *   • the sample states are what they say they are
 *
 * Needs the sibling ../oneshetland-web checkout.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'oneshetland-web');
const have = existsSync(join(WEB, 'lib/preview-v2.ts'));
const opts = { skip: have ? false : 'sibling oneshetland-web checkout not found' };
const code = (rel: string) => readFileSync(join(WEB, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const mod = () => loadModule('../oneshetland-web/lib/preview-v2.ts');
const PILLARS = ['shop', 'offers', 'book', 'experiences'] as const;
const EMPTY = { shop: [], offers: [], book: [], experiences: [] };
type Item = { id: string; title: string; tag?: string; pillar: string };

describe('inventory bands — one rule for every surface', opts, () => {
  test('0 → none · 1–3 → few · 4–12 → rail · 13+ → many', () => {
    const { density } = mod();
    const got = [0, 1, 3, 4, 12, 13, 24].map((n) => density(n));
    assert.deepEqual(got, ['none', 'few', 'few', 'rail', 'rail', 'many', 'many']);
  });
});

describe('what each state and viewer receives', opts, () => {
  const { buildCommerce, parsePreview } = mod();
  const total = (c: Record<string, Item[]>) => PILLARS.reduce((n, p) => n + c[p].length, 0);
  const tagged = (c: Record<string, Item[]>) => PILLARS.flatMap((p) => c[p]).filter((m) => m.tag);

  test('THE RULE: the public never receives a test item, in any state', () => {
    for (const state of ['live', 'empty', 'seed', 'full']) {
      const real = { ...EMPTY, shop: [{ id: 'real-1', pillar: 'shop', title: 'A real product' }] };
      const c = buildCommerce(state, 'public', real);
      assert.equal(tagged(c).length, 0, state);
      for (const p of PILLARS) for (const m of c[p]) assert.doesNotMatch(m.title, /^(ZZ|DEMO)\b|ZZ TEST/, `${state}: ${m.title}`);
    }
  });
  test('admin QA receives the acceptance fixtures — and every one is tagged TEST or QA', () => {
    for (const state of ['empty', 'seed', 'full']) {
      const c = buildCommerce(state, 'admin', EMPTY);
      const t = tagged(c);
      assert.ok(t.length >= 4, `${state}: ${t.length} fixtures`);
      for (const m of t) assert.match(m.tag as string, /^(TEST|QA)$/);
      const untaggedFixtures = PILLARS.flatMap((p) => c[p]).filter((m) => /^(ZZ|DEMO)\b|ZZ TEST|Hamnavoe Lighthouse/.test(m.title) && !m.tag);
      assert.deepEqual(untaggedFixtures, [], 'test content must never look like real content');
    }
  });
  test('pre-launch is empty for the public and fixtures-only for admin; nothing invented', () => {
    assert.equal(total(buildCommerce('empty', 'public', EMPTY)), 0);
    assert.equal(tagged(buildCommerce('empty', 'admin', EMPTY)).length, total(buildCommerce('empty', 'admin', EMPTY)));
  });
  test('live data is exactly the real inventory handed in (nothing is added to it for the public)', () => {
    const real = { ...EMPTY, offers: [{ id: 'o1', pillar: 'offers', title: 'Genuine offer' }] };
    const c = buildCommerce('live', 'public', real);
    assert.deepEqual(c.offers.map((m: Item) => m.id), ['o1']);
    assert.equal(total(c), 1);
  });
  test('launch seed is a handful per pillar; populated is 20+ per pillar', () => {
    const seed = buildCommerce('seed', 'public', EMPTY);
    for (const p of PILLARS) assert.ok(seed[p].length >= 2 && seed[p].length <= 3, `${p}: ${seed[p].length}`);
    const full = buildCommerce('full', 'public', EMPTY);
    for (const p of PILLARS) assert.ok(full[p].length >= 20, `${p}: ${full[p].length}`);
  });
  test('every item has a unique id, a destination and a business name', () => {
    const c = buildCommerce('full', 'admin', EMPTY);
    const all = PILLARS.flatMap((p) => c[p]) as (Item & { href: string; business: string })[];
    assert.equal(new Set(all.map((m) => m.id)).size, all.length);
    for (const m of all) { assert.ok(m.href.startsWith('/')); assert.ok(m.business.length > 0); }
  });
  test('the switch parses safely: unknown values fall back to the launch seed, public', () => {
    assert.deepEqual(parsePreview({ state: 'nonsense', as: 'root' }), { state: 'seed', viewer: 'public' });
    assert.deepEqual(parsePreview({ state: 'full', as: 'admin' }), { state: 'full', viewer: 'admin' });
  });
});

describe('the previews do not touch the live pages', opts, () => {
  const walk = (d: string, out: string[] = []): string[] => {
    for (const n of readdirSync(d)) {
      if (['node_modules', '.next', '.git', 'preview'].includes(n)) continue;
      const p = join(d, n); const st = statSync(p);
      if (st.isDirectory()) walk(p, out); else if (/\.(tsx?|jsx?)$/.test(n)) out.push(p);
    }
    return out;
  };
  test('nothing outside the preview routes and components imports or links to a preview', () => {
    const offenders = ['app', 'components', 'lib'].flatMap((d) => walk(join(WEB, d)))
      .filter((f) => !/components\/preview\/|lib\/preview-v2/.test(f))
      .filter((f) => /preview-v2|\/preview\/(home|local)-v2|components\/preview\/v2/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders.map((f) => f.replace(WEB, '')), []);
  });
  test('the live Home and Local pages are the curated ones, untouched by the previews', () => {
    assert.match(code('app/page.tsx'), /<WhatsHappening/);
    assert.match(code('app/local/page.tsx'), /Open for business/);
    assert.doesNotMatch(code('app/page.tsx') + code('app/local/page.tsx'), /preview/i);
  });
  test('both preview routes are unindexed', () => {
    for (const r of ['app/preview/home-v2/page.tsx', 'app/preview/local-v2/page.tsx']) {
      assert.match(code(r), /robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/, r);
      assert.match(code(r), /export const dynamic = "force-dynamic"/);
    }
  });
  test('the preview writes nothing: no insert, update, upsert or delete anywhere in it', () => {
    const files = ['app/preview/home-v2/page.tsx', 'app/preview/local-v2/page.tsx', 'components/preview/v2/Merch.tsx', 'components/preview/v2/HomeV2.tsx', 'components/preview/v2/LocalV2.tsx', 'lib/preview-v2.ts'];
    for (const f of files) assert.doesNotMatch(code(f), /\.(insert|update|upsert|delete|rpc)\(/, f);
  });
});

describe('phone fit — the shrinkable-column rule, in the preview too', opts, () => {
  for (const file of ['components/preview/v2/Merch.tsx', 'components/preview/v2/HomeV2.tsx', 'components/preview/v2/LocalV2.tsx']) {
    test(`${file}: every responsive grid starts from a base column count`, () => {
      const s = code(file);
      const grids = [...s.matchAll(/className=(?:"|\{")(grid [^"]*)"/g)].map((m) => m[1]).filter((g) => /(sm|md|lg):grid-cols-/.test(g));
      for (const g of grids) assert.match(g, /grid grid-cols-\d/, g);
    });
  }
  test('photographs fall back to a brand image if a source fails', () => {
    assert.match(code('components/preview/v2/Merch.tsx'), /onError=\{\(e\) => \{ if \(fallback/);
  });
});
