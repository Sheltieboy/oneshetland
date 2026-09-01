/**
 * business-be-found-and-next.node.test.ts — Business Experience 2.0, Phase 1.
 *
 * Two questions this pins. Is the listing good enough for a customer to use,
 * and what is the one thing worth doing next?
 *
 * The helpers are imported and run for real rather than read as text, so these
 * are behaviour tests. The database half proves the map pin an owner can now
 * set actually saves, that a stranger cannot set it, and that saving it moves
 * nothing it has no business moving.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beFound, hasValidPin } from '../../../oneshetland-web/lib/be-found.ts';
import { nextAction, hasOperationalAttention } from '../../../oneshetland-web/lib/business-next-action.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const readWeb = (p: string) => readFileSync(join(WEB, p), 'utf8');
/**
 * Source with comments removed. Every one of these files EXPLAINS why it has no
 * score and sells nothing, so asserting against the raw text just matches the
 * explanation and proves nothing.
 */
const code = (p: string) => readWeb(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
  const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 400));
  return parsed.rows ?? [];
}

/* A pin in Lerwick, and a listing with nothing on it. */
const PIN = { lat: 60.1546, lng: -1.1494 };
const BARE = { phone: null, website: null, email: null, lat: null, lng: null,
               description: null, logo_url: null, cover_url: null, opening_hours: null };
const CALM = { orders: { length: 0 }, bookings: { length: 0 }, leads: { length: 0 },
               needs: { jobApplications: 0 }, isTrade: false,
               tradeAvailability: null, tradeAvailabilitySetAt: null };

/* ── 1. Be Found ──────────────────────────────────────────────────────────── */

describe('is this listing good enough to be found', () => {
  test('1. nothing at all is incomplete', () => {
    const r = beFound(BARE);
    assert.equal(r.state, 'incomplete');
    assert.deepEqual(r.missingEssential, ['contact', 'map_pin']);
  });

  test('2. a contact method without a pin is still incomplete', () => {
    const r = beFound({ ...BARE, phone: '01595 000000' });
    assert.equal(r.state, 'incomplete');
    assert.deepEqual(r.missingEssential, ['map_pin']);
  });

  test('3. a pin without a contact method is still incomplete', () => {
    const r = beFound({ ...BARE, ...PIN });
    assert.equal(r.state, 'incomplete');
    assert.deepEqual(r.missingEssential, ['contact']);
  });

  test('4. contact and a pin is ready', () => {
    const r = beFound({ ...BARE, ...PIN, email: 'hello@example.com' });
    assert.equal(r.state, 'ready');
    assert.deepEqual(r.missingEssential, []);
  });

  test('5. ready plus a description is still only ready', () => {
    const r = beFound({ ...BARE, ...PIN, phone: '01595', description: 'We make things' });
    assert.equal(r.state, 'ready');
    assert.deepEqual(r.missingImprovements, ['image', 'opening_hours']);
  });

  test('6. ready plus a description and an image is still only ready', () => {
    const r = beFound({ ...BARE, ...PIN, phone: '01595', description: 'x', logo_url: 'u' });
    assert.equal(r.state, 'ready');
    assert.deepEqual(r.missingImprovements, ['opening_hours']);
  });

  test('7. all five is good', () => {
    const r = beFound({ ...BARE, ...PIN, phone: '01595', description: 'x', logo_url: 'u',
                        opening_hours: { mon: '9-5' } as never });
    assert.equal(r.state, 'good');
    assert.deepEqual(r.missingImprovements, []);
  });

  test('8. a logo or a cover each satisfy the image', () => {
    assert.equal(beFound({ ...BARE, logo_url: 'u' }).hasImage, true);
    assert.equal(beFound({ ...BARE, cover_url: 'u' }).hasImage, true);
    assert.equal(beFound({ ...BARE, logo_url: '   ' }).hasImage, false, 'whitespace is not a photo');
  });

  test('9. any one of phone, email or website satisfies contact', () => {
    for (const k of ['phone', 'email', 'website'] as const) {
      assert.equal(beFound({ ...BARE, [k]: 'something' }).hasContactMethod, true, k);
    }
    assert.equal(beFound({ ...BARE, phone: '  ' }).hasContactMethod, false, 'whitespace is not a phone number');
  });

  test('10. is_active is not consulted, so moderation cannot make an owner look unfinished', () => {
    const good = { ...BARE, ...PIN, phone: '01595', description: 'x', logo_url: 'u',
                   opening_hours: { mon: '9-5' } as never };
    // The field is not part of the input type at all. Passing it changes nothing.
    assert.equal(beFound({ ...good, is_active: false } as never).state, 'good');
    assert.doesNotMatch(code('lib/be-found.ts'), /is_active/,
      'is_active must not be read by the derivation');
  });

  test('11. name, category and address alone do not make a listing ready', () => {
    // They are NOT NULL on the table, so every business has them; if they
    // counted, every business would start ready and the model would say nothing.
    const r = beFound({ ...BARE, name: 'A shop', category: 'retail', address: 'Lerwick' } as never);
    assert.equal(r.state, 'incomplete');
  });

  test('12. no percentage or score is produced anywhere', () => {
    const r = beFound({ ...BARE, ...PIN, phone: '01595' });
    for (const v of Object.values(r)) assert.notEqual(typeof v, 'number');
    assert.doesNotMatch(code('lib/be-found.ts'), /percent|score|Math\.round/i);
  });

  test('a pin at Null Island is a failed import, not a location', () => {
    assert.equal(hasValidPin(0, 0), false);
    assert.equal(hasValidPin(null, -1.1), false);
    assert.equal(hasValidPin(91, 0), false);
    assert.equal(hasValidPin(NaN, 1), false);
    assert.equal(hasValidPin(60.15, -1.14), true);
  });
});

/* ── 2. Next ──────────────────────────────────────────────────────────────── */

describe('the one thing worth doing next', () => {
  const base = '/business/b1/manage';

  test('13. no contact method asks for a contact method', () => {
    assert.equal(nextAction(CALM, BARE, base)?.key, 'contact');
  });

  test('14. contact present, pin missing asks for the pin', () => {
    assert.equal(nextAction(CALM, { ...BARE, phone: '01595' }, base)?.key, 'map_pin');
  });

  test('15. ready with no description asks for the description', () => {
    assert.equal(nextAction(CALM, { ...BARE, ...PIN, phone: '01595' }, base)?.key, 'description');
  });

  test('16. description present, image missing asks for the image', () => {
    assert.equal(nextAction(CALM, { ...BARE, ...PIN, phone: '01595', description: 'x' }, base)?.key, 'image');
  });

  test('17. image present, hours missing asks for the hours', () => {
    assert.equal(nextAction(CALM, { ...BARE, ...PIN, phone: '01595', description: 'x', logo_url: 'u' }, base)?.key,
      'opening_hours');
  });

  test('18. a good listing produces no next action at all', () => {
    const good = { ...BARE, ...PIN, phone: '01595', description: 'x', logo_url: 'u',
                   opening_hours: { mon: '9-5' } as never };
    assert.equal(nextAction(CALM, good, base), null);
  });

  test('19 & 20. anything waiting silences Next entirely', () => {
    // BARE would otherwise produce a very loud "add a contact method".
    const cases = [
      { ...CALM, orders:   { length: 1 } },
      { ...CALM, bookings: { length: 1 } },
      { ...CALM, leads:    { length: 1 } },
      { ...CALM, needs: { jobApplications: 2 } },
      { ...CALM, isTrade: true, tradeAvailability: 'this_week',
        tradeAvailabilitySetAt: new Date(Date.now() - 400 * 86400000).toISOString() },
    ];
    for (const a of cases) {
      assert.equal(hasOperationalAttention(a), true);
      assert.equal(nextAction(a, BARE, base), null, 'a customer waiting outranks a listing tidy-up');
    }
    // ...and the control: with nothing waiting, the same business does get one.
    assert.equal(hasOperationalAttention(CALM), false);
    assert.ok(nextAction(CALM, BARE, base));
  });

  test('21. at most one action is ever returned', () => {
    const a = nextAction(CALM, BARE, base);
    assert.ok(a && typeof a.key === 'string', 'a single object, not a list');
    assert.equal(Array.isArray(a), false);
  });

  test('22 & 23. no paid capability, upgrade or plan ever appears in Next', () => {
    assert.doesNotMatch(code('lib/business-next-action.ts'),
      /\b(upgrade|billing|Pro|Premium|subscription|tier|plan)\b/,
      'Next tells an owner what to do, it does not sell to them');
    // Every reachable key is a Be Found gap and nothing else.
    const keys = new Set<string>();
    const inputs = [BARE, { ...BARE, phone: 'p' }, { ...BARE, ...PIN, phone: 'p' },
                    { ...BARE, ...PIN, phone: 'p', description: 'd' },
                    { ...BARE, ...PIN, phone: 'p', description: 'd', logo_url: 'u' }];
    for (const i of inputs) { const a = nextAction(CALM, i, base); if (a) keys.add(a.key); }
    assert.deepEqual([...keys].sort(),
      ['contact', 'description', 'image', 'map_pin', 'opening_hours']);
  });

  test('every action points the owner at somewhere they can actually do it', () => {
    assert.equal(nextAction(CALM, BARE, base)?.href, `${base}/profile`);
  });
});

/* ── 3. The map pin, against the real database ────────────────────────────── */

const OWNER   = 'f6f60001-1111-1111-1111-111111111111';
const STRANGER = 'f6f60002-2222-2222-2222-222222222222';
const BIZ     = 'f6f60003-3333-3333-3333-333333333333';

const FIXTURE = `
begin;
  insert into auth.users (id,email) values ('${OWNER}','bf-o@probe.invalid'),('${STRANGER}','bf-s@probe.invalid');
  insert into public.local_businesses (id,owner_id,name,category,address,is_active,lat,lng)
    values ('${BIZ}','${OWNER}','BF PROBE','other','Lerwick',true,60.1,-1.1);
  create temp table r(step text, outcome text) on commit drop;
  grant insert, select on r to authenticated, anon;`;
const asUser = (id: string) => `
  reset role;
  select set_config('request.jwt.claims','{"sub":"${id}","role":"authenticated"}',true);
  set local role authenticated;`;
const END = `reset role; select * from r order by step; rollback;`;
const outcome = (rows: Record<string, unknown>[], step: string) =>
  String(rows.find((r) => r.step === step)?.outcome ?? '(missing)');

describe('an owner can set their own map pin, and only their own', () => {
  const rows = sql(FIXTURE + asUser(OWNER) +
    `do $p$ begin
       update public.local_businesses set lat=60.9, lng=-1.9 where id='${BIZ}';
       insert into r values ('owner moves the pin','ALLOWED');
     exception when others then insert into r values ('owner moves the pin','refused'); end $p$;` +
    `reset role;
     insert into r select 'pin after owner', coalesce((lat::float8)::text,'null')||','||coalesce((lng::float8)::text,'null')
       from public.local_businesses where id='${BIZ}';` +
    asUser(STRANGER) +
    `do $p$ begin
       update public.local_businesses set lat=1.1, lng=1.1 where id='${BIZ}';
       insert into r values ('stranger moves the pin','ALLOWED');
     exception when others then insert into r values ('stranger moves the pin','refused'); end $p$;` +
    `reset role;
     insert into r select 'pin after stranger', coalesce((lat::float8)::text,'null')||','||coalesce((lng::float8)::text,'null')
       from public.local_businesses where id='${BIZ}';` +
    // the exact patch ProfileManager sends, and what it must leave alone
    asUser(OWNER) +
    `do $p$ begin
       update public.local_businesses
          set name='BF PROBE', description='d', category='other', phone='01595',
              website=null, email=null, address='Lerwick', brand_color='#fff',
              tags='{}', opening_hours=null, lat=60.5, lng=-1.5
        where id='${BIZ}';
       insert into r values ('the profile save','ALLOWED');
     exception when others then insert into r values ('the profile save','refused'); end $p$;` +
    `reset role;
     insert into r select 'untouched after save',
       is_active::text||'/'||subscription_tier||'/'||coalesce(payout_enabled,false)::text||'/'||
       coalesce(accepts_wallet,false)::text||'/'||coalesce(is_verified,false)::text
       from public.local_businesses where id='${BIZ}';` +
    END);

  test('24. the existing coordinates are there to display', () =>
    assert.equal(outcome(rows, 'pin after owner'), '60.9,-1.9'));

  test('25. a legitimate owner can update the coordinates', () =>
    assert.equal(outcome(rows, 'owner moves the pin'), 'ALLOWED'));

  test('26. a stranger cannot move another business\'s pin', () => {
    // RLS filters the row rather than raising, so this is measured by reading
    // the value back — "no error" would have passed while doing nothing.
    assert.equal(outcome(rows, 'pin after stranger'), '60.9,-1.9');
  });

  test('27 & 28. saving the profile moves nothing it should not', () => {
    assert.equal(outcome(rows, 'the profile save'), 'ALLOWED');
    assert.equal(outcome(rows, 'untouched after save'), 'true/free/false/false/false',
      'is_active, tier, payout, wallet and verification all unchanged');
  });

  test('the client never sends is_active, and the column lock guards the rest', () => {
    const pm = readWeb('components/business/ProfileManager.tsx');
    assert.doesNotMatch(pm, /is_active/, 'no owner publish control was added in this slice');
    const [lock] = sql(`select pg_get_functiondef('public.tg_lock_business_columns'::regproc) as d;`);
    const d = String(lock.d);
    for (const col of ['subscription_tier', 'payout_enabled', 'is_verified', 'owner_id']) {
      assert.match(d, new RegExp(`new\\.${col}\\s+:=\\s+old\\.${col}`), `${col} must stay server-managed`);
    }
    assert.doesNotMatch(d, /new\.lat\s+:=/, 'lat must remain owner-writable, or the pin control is a lie');
  });
});

/* ── 4. Nothing else moved ────────────────────────────────────────────────── */

describe('the rest of Business Home is where it was', () => {
  const top = readWeb('components/business/DashboardTop.tsx');

  test('29. the existing attention panels remain', () => {
    for (const t of ['Orders to deal with', 'Coming up', 'Job leads waiting', 'Job applications',
                     'Nothing needs you right now']) {
      assert.ok(top.includes(t), `${t} must survive`);
    }
  });

  test('30. This week remains, including the unknown-is-not-zero rule', () => {
    assert.match(top, /Last 7 days/);
    assert.match(top, /week\.revenuePence === null/);
    assert.match(top, /Profile views/);
  });

  test('Next sits between what is waiting and the numbers', () => {
    assert.ok(top.indexOf('Nothing needs you right now') < top.indexOf('<p className="eyebrow text-ink-muted">Next</p>'));
    assert.ok(top.indexOf('<p className="eyebrow text-ink-muted">Next</p>') < top.indexOf('Last 7 days'));
  });

  test('31. creating a business still lands on Business Home', () =>
    assert.match(readWeb('components/directory/BusinessCreateForm.tsx'),
      /router\.push\(`\/business\/\$\{data\.id\}\/manage`\)/));

  test('32. claim moderation is untouched', () => {
    const claim = readWeb('components/directory/BusinessClaimForm.tsx');
    assert.match(claim, /business_claims/);
    assert.match(claim, /status:\s*"pending"/);
  });

  test('33. no migration was introduced', () => {
    const list = execFileSync('git', ['status', '--porcelain', 'supabase/migrations'],
      { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(list.trim(), '', 'Phase 1 is derived state — it needs no schema');
  });

  test('34. no mobile source changed', () => {
    const list = execFileSync('git', ['status', '--porcelain', 'app', 'lib', 'components'],
      { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(list.trim(), '', 'mobile convergence is a later phase');
  });

  test('35. no entitlement boundary changed', () => {
    const rows = sql(`
      select distinct c.relname as tbl from pg_trigger t join pg_class c on c.oid=t.tgrelid
       where not t.tgisinternal and position('business_meets_tier' in pg_get_functiondef(t.tgfoid)) > 0
       order by c.relname;`);
    assert.deepEqual(rows.map((r) => r.tbl),
      ['book_bookings', 'book_unit_items', 'local_businesses', 'local_loyalty_cards',
       'local_loyalty_programs', 'local_loyalty_transactions', 'local_offers',
       'local_wallet_transactions', 'products']);
  });

  test('36. Work is still a cross-link, not Business state', () => {
    // The dashboard may say a job application is waiting; it must not own one.
    assert.match(top, /\$\{base\}\/jobs/);
    assert.match(top, /\$\{base\}\/leads/);
    // Work legitimately appears in business-next-action as an attention INPUT —
    // a waiting job application silences Next. That is the cross-link. What
    // must never happen is Work coming back OUT as something to go and set up.
    const inputs = [BARE, { ...BARE, phone: 'p' }, { ...BARE, ...PIN, phone: 'p' },
                    { ...BARE, ...PIN, phone: 'p', description: 'd' },
                    { ...BARE, ...PIN, phone: 'p', description: 'd', logo_url: 'u' }];
    for (const i of inputs) {
      const a = nextAction(CALM, i, '/business/b1/manage');
      if (!a) continue;
      assert.doesNotMatch(`${a.key} ${a.title} ${a.body} ${a.href}`, /\b(job|shift|applicant|hire|recruit|lead)/i,
        'Next must never propose Work as a business setup step');
    }
    assert.doesNotMatch(code('lib/be-found.ts'), /\b(job|shift|applicant|hire|recruit)/i,
      'the Be Found copy table must contain no Work');
    for (const p of ['lib/business-capabilities.ts', 'lib/business-intent.ts']) {
      assert.equal(existsSync(join(WEB, p)), false, `${p} belongs to a later phase`);
    }
  });
});
