/**
 * offer-visibility.node.test.ts — an unpublished business stops advertising.
 *
 * getActiveOffers fetched the offers, then looked their businesses up in a
 * SECOND query and attached `map[business_id] ?? null`. A business that is not
 * active is invisible to that second query, so the lookup missed — and the
 * offer was returned anyway, with `business: null`. The offer itself was never
 * filtered on its business at all.
 *
 * Found the hard way: after the pre-launch demo shop was unpublished, /local
 * still carried "DEMO — 10% off all wool". The shop was gone; its advertising
 * was not.
 *
 * The fix is the shape shop-data.ts already uses for products — one query, an
 * INNER join, and an explicit filter on the parent:
 *
 *   !inner                     no visible parent row, no offer row
 *   .eq("business.is_active")  and it must actually be active
 *
 * The second is load-bearing, not decoration. RLS on local_businesses is
 * `is_active = true OR owner_id = auth.uid()`, so an owner CAN see their own
 * unpublished business — without the explicit filter their own hidden offers
 * would come back through the join.
 *
 * The database half is exercised for real, as anon, against a fixture in a
 * transaction that is always rolled back: an inner join is what PostgREST
 * compiles `!inner` to, so that is what is tested.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT  = join(REPO_ROOT, '..', 'oneshetland-web');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\*).*$/gm, '');

const localData = code(readFileSync(join(WEB_ROOT, 'lib/local-data.ts'), 'utf8'));
const shopData  = code(readFileSync(join(WEB_ROOT, 'lib/shop-data.ts'), 'utf8'));

/** Rolled back, always: the guard row makes an accidental commit impossible. */
function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 300));
  return parsed.rows ?? [];
}

const OWNER = 'f1111111-1111-1111-1111-111111111111';
const LIVE  = 'f2222222-2222-2222-2222-222222222222';
const HIDDEN = 'f3333333-3333-3333-3333-333333333333';

/**
 * Two businesses — one published, one not — and three offers between them:
 * live/live, live/hidden, expired-flag/live. Everything read back as `anon`.
 */
const FIXTURE = `
begin;
  insert into auth.users (id, email) values ('${OWNER}', 'offerprobe@probe.invalid');
  insert into public.local_businesses (id, owner_id, name, category, address, is_active) values
    ('${LIVE}',   '${OWNER}', 'PROBE Live Shop',   'retail', 'PROBE', true),
    ('${HIDDEN}', '${OWNER}', 'PROBE Hidden Shop', 'retail', 'PROBE', false);
  insert into public.local_offers
    (business_id, title, discount_type, discount_value, is_active, valid_from, valid_until) values
    ('${LIVE}',   'PROBE live offer',       'percent', 10, true,  now() - interval '1 day', now() + interval '7 days'),
    ('${HIDDEN}', 'PROBE hidden-shop offer','percent', 10, true,  now() - interval '1 day', now() + interval '7 days'),
    ('${LIVE}',   'PROBE switched-off',     'percent', 10, false, now() - interval '1 day', now() + interval '7 days');
  set local role anon;
`;

/* ── 1. What the database actually returns ──────────────────────────────── */

describe('a hidden business advertises nothing', () => {
  test('the fixed query returns only the live shop\'s live offer', () => {
    const rows = sql(FIXTURE + `
  select o.title
    from public.local_offers o
    join public.local_businesses b on b.id = o.business_id   -- !inner
   where o.is_active
     and b.is_active                                          -- .eq("business.is_active", true)
     and o.valid_from <= now() and o.valid_until >= now()
     and o.title like 'PROBE%'
   order by o.created_at desc;
rollback;`);
    assert.deepEqual(rows.map((r) => r.title), ['PROBE live offer'],
      'exactly one offer is publishable: active, in date, and from a published shop');
  });

  test('THE DEFECT: without the business join the hidden shop\'s offer survives', () => {
    // This is the old two-query shape: filter the offers, then attach whatever
    // business can be found. The hidden shop's offer comes straight through.
    const rows = sql(FIXTURE + `
  select o.title
    from public.local_offers o
   where o.is_active
     and o.valid_from <= now() and o.valid_until >= now()
     and o.title like 'PROBE%'
   order by o.created_at desc;
rollback;`);
    const titles = rows.map((r) => r.title);
    assert.ok(titles.includes('PROBE hidden-shop offer'),
      'the unfiltered query is what let an unpublished shop keep advertising');
    assert.equal(titles.length, 2);
  });

  test('an inactive offer stays out either way', () => {
    const [row] = sql(FIXTURE + `
  select count(*)::int as n
    from public.local_offers o
    join public.local_businesses b on b.id = o.business_id
   where o.is_active and b.is_active and o.title = 'PROBE switched-off';
rollback;`);
    assert.equal(row.n, 0);
  });

  test('the explicit filter is needed as well as the join, because RLS lets an owner see their own', () => {
    // RLS on local_businesses: is_active OR owner_id = auth.uid(). Signed in as
    // the owner, the hidden business IS visible — so the inner join alone would
    // let their own hidden offer through.
    const [row] = sql(`
begin;
  insert into auth.users (id, email) values ('${OWNER}', 'offerprobe@probe.invalid');
  insert into public.local_businesses (id, owner_id, name, category, address, is_active)
    values ('${HIDDEN}', '${OWNER}', 'PROBE Hidden Shop', 'retail', 'PROBE', false);
  insert into public.local_offers (business_id, title, discount_type, discount_value, is_active, valid_from, valid_until)
    values ('${HIDDEN}', 'PROBE owner sees this', 'percent', 10, true, now() - interval '1 day', now() + interval '7 days');
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"${OWNER}","role":"authenticated"}';
  select
    (select count(*)::int from public.local_offers o
       join public.local_businesses b on b.id = o.business_id
      where o.is_active and o.title like 'PROBE%')                    as join_only,
    (select count(*)::int from public.local_offers o
       join public.local_businesses b on b.id = o.business_id
      where o.is_active and b.is_active and o.title like 'PROBE%')    as join_and_filter;
rollback;`);
    assert.equal(row.join_only, 1, 'the owner can see their own hidden business, so the join alone passes it');
    assert.equal(row.join_and_filter, 0, 'the explicit is_active filter is what stops it');
  });
});

/* ── 2. The query the code actually builds ──────────────────────────────── */

describe('getActiveOffers asks for both conditions', () => {
  // Scoped to this function only. The end marker cannot be a comment: code()
  // strips those, so indexOf would return -1 and the slice would swallow the
  // rest of the file — which is how this test first passed while asserting
  // against a different function's query.
  const start = localData.indexOf('export async function getActiveOffers');
  const after = localData.indexOf('export async function', start + 10);
  const fn = localData.slice(start, after > start ? after : undefined);

  test('it inner-joins the business rather than looking it up separately', () => {
    assert.match(fn, /business:local_businesses!inner\(/);
    assert.ok(!/\.in\("id", ids\)/.test(fn),
      'the second lookup that attached `?? null` is gone');
    assert.ok(!/\?\? null\}\)\)/.test(fn),
      'nothing may fall back to a null business and keep the offer');
  });

  test('and filters on the parent explicitly', () => {
    assert.match(fn, /\.eq\("business\.is_active", true\)/);
  });

  test('it matches the pattern products already use', () => {
    assert.match(shopData, /local_businesses!inner\([^)]*is_active[^)]*\)/);
    assert.match(shopData, /\.eq\("business\.is_active", true\)/);
  });

  test('the offer\'s own rules are untouched', () => {
    assert.match(fn, /\.eq\("is_active", true\)/);
    assert.match(fn, /\.lte\("valid_from", now\)/);
    assert.match(fn, /\.gte\("valid_until", now\)/);
    assert.match(fn, /\.order\("created_at", \{ ascending: false \}\)/);
    assert.match(fn, /\.limit\(limit\)/);
  });

  test('the public shape is exactly what it was', () => {
    for (const f of ['id', 'business_id', 'title', 'description', 'image_url',
                     'discount_type', 'discount_value', 'valid_until']) {
      assert.match(fn, new RegExp(`${f}: o\\.${f}`), `${f} must still be returned`);
    }
    for (const f of ['id', 'name', 'logo_url', 'category', 'slug']) {
      assert.match(fn, new RegExp(`${f}: o\\.business\\.${f}`), `business.${f} must still be returned`);
    }
    assert.ok(!/is_active: o\.business\.is_active/.test(fn),
      'is_active is joined on to filter, not to publish');
  });
});
