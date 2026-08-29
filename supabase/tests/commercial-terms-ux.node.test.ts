/**
 * commercial-terms-ux.node.test.ts — the acceptance journey, before enforcement.
 *
 * W3G built a record nobody can fake. This is the way a business legitimately
 * creates one, and the rule the journey has to respect: owning a Directory
 * listing does not make anybody a seller. A business that claims its listing to
 * keep its opening hours right is never asked to accept selling terms; a
 * business opening Products, Bookings or the till is.
 *
 * One acceptance per business covers every commercial screen — not one per
 * feature — and it is asked for again only when the version moves.
 *
 * Database enforcement of commercial WRITES is deliberately still off. A test
 * below asserts that, so the day it changes is a decision rather than a drift.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const read    = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB, p), 'utf8');

const gateServer = readWeb('lib/commercial-terms.server.tsx');
const acceptWeb  = readWeb('components/business/CommercialTermsAccept.tsx');
const gateApp    = read('components/CommercialTermsGate.tsx');
const libApp     = read('lib/commercial-terms.ts');

function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 400));
  return parsed.rows ?? [];
}

/** Web commercial routes, and the Directory ones that must stay open. */
const COMMERCIAL = ['products', 'bookings', 'passes', 'offers', 'loyalty', 'events', 'wallet', 'counter', 'billing'];
const DIRECTORY  = ['profile', 'analytics', 'alerts', 'jobs', 'shifts', 'leads', 'orders', 'transactions'];
const webPage = (r: string) => readWeb(`app/business/[id]/manage/${r}/page.tsx`);

/* ── 1. Directory-only owners are left alone ────────────────────────────── */

describe('a Directory listing does not make you a seller', () => {
  test('no Directory management screen asks for commercial acceptance', () => {
    for (const r of DIRECTORY) {
      assert.ok(!/commercialTermsGate/.test(webPage(r)), `${r} must not be gated`);
    }
    assert.ok(!/commercialTermsGate/.test(readWeb('app/business/[id]/manage/page.tsx')),
      'the dashboard itself must not be gated');
  });

  test('nor does claiming or creating a listing', () => {
    for (const f of ['components/directory/BusinessCreateForm.tsx',
                     'components/directory/BusinessClaimForm.tsx',
                     'components/welcome/JoinWizard.tsx']) {
      assert.ok(!/commercialTermsGate|CommercialTermsAccept/.test(readWeb(f)), f);
    }
  });

  test('and the app leaves Directory screens open too', () => {
    for (const f of ['local-business-register', 'local-business-dashboard', 'local-business-analytics',
                     'business-jobs', 'business-leads', 'business-orders', 'local-business-transactions']) {
      assert.ok(!/CommercialTermsGate/.test(read(`app/${f}.tsx`)), f);
    }
  });
});

/* ── 2. Every commercial surface goes through the one gate ──────────────── */

describe('one shared gate, in front of every commercial screen', () => {
  test('all nine web commercial screens use it', () => {
    for (const r of COMMERCIAL) {
      const src = webPage(r);
      assert.match(src, /commercialTermsGate\(business, "/, `${r} is not gated`);
      assert.match(src, /if \(gate\) return gate;/, `${r} does not return the gate`);
    }
  });

  test('the gate precedes the screen\'s own work', () => {
    for (const r of COMMERCIAL) {
      const src = webPage(r);
      const gateAt = src.indexOf('const gate = await commercialTermsGate');
      const ownerAt = src.indexOf('requireBusinessOwner(');
      assert.ok(ownerAt > 0 && gateAt > ownerAt, `${r}: ownership first, then the gate`);
      const firstQuery = src.indexOf('sb.from(');
      if (firstQuery > 0) assert.ok(gateAt < firstQuery, `${r}: the gate must precede the screen's queries`);
    }
  });

  test('there is exactly one acceptance component per platform', () => {
    assert.ok(existsSync(join(WEB, 'components/business/CommercialTermsAccept.tsx')));
    assert.ok(existsSync(join(REPO_ROOT, 'components/CommercialTermsGate.tsx')));
    // Nobody rolled their own checkbox next to a manager.
    for (const r of COMMERCIAL) {
      assert.ok(!/record_commercial_terms_acceptance/.test(webPage(r)),
        `${r} calls the writer directly instead of using the shared component`);
    }
  });

  test('the app wraps its commercial screens with the same gate', () => {
    for (const f of ['business-products', 'local-offer-new', 'local-book-services',
                     'local-book-units', 'local-book-schedule', 'local-till', 'local-counter',
                     'event-create']) {
      assert.match(read(`app/${f}.tsx`), /<CommercialTermsGate businessId=/, f);
    }
  });

  test('event creation is gated on the business route and not the hub one', () => {
    // A community hub arranging an event is not a business selling tickets.
    const src = read('app/event-create.tsx');
    assert.match(src, /if \(!businessId\) return <EventCreateBody \/>;/,
      'the hub route must not be asked to accept selling terms');
    const bypass = src.indexOf('if (!businessId) return');
    const gate = src.indexOf('<CommercialTermsGate businessId=');
    assert.ok(bypass > 0 && gate > bypass, 'the business route still goes through the gate');
  });

  test('every screen that takes a businessId is a deliberate decision', () => {
    // A new owner-facing screen should not be able to appear ungated by
    // accident. Anything parameterised by businessId is either gated or listed
    // here as a considered exclusion.
    const UNGATED_ON_PURPOSE: Record<string, string> = {
      'business-jobs':                'recruitment, not selling',
      'business-alerts':              'Directory notices',
      'business-orders':              'reading orders already placed',
      'job-post':                     'recruitment, not selling',
      'local-book-bookings':          'reading bookings already taken',
      'local-business-analytics':     'Directory statistics',
      'local-business-transactions':  'reading a payment history',
      'payment-setup':                'Stripe Connect onboarding — out of scope for W3H',
    };
    const screens = execFileSync('grep',
      ['-l', 'useLocalSearchParams<{ businessId', '-r', join(REPO_ROOT, 'app')],
      { encoding: 'utf8' }).trim().split('\n')
      .map((f) => f.split('/').pop()!.replace(/\.tsx$/, ''));
    for (const name of screens) {
      const gated = /CommercialTermsGate/.test(read(`app/${name}.tsx`));
      if (!gated) {
        assert.ok(name in UNGATED_ON_PURPOSE,
          `${name} takes a businessId but is neither gated nor a recorded exclusion`);
      }
    }
  });
});

/* ── 3. What the browser is allowed to send ─────────────────────────────── */

describe('the client decides nothing', () => {
  test('the writer is called with only p_business_id', () => {
    for (const [name, src] of [['web', acceptWeb], ['app', libApp]] as const) {
      const call = src.slice(src.indexOf('record_commercial_terms_acceptance'));
      const args = call.slice(0, call.indexOf('}') + 1);
      assert.match(args, /p_business_id/, name);
      for (const forbidden of ['p_user_id', 'user_id', 'document_version', 'event_type', 'metadata']) {
        assert.ok(!args.includes(forbidden), `${name} sends ${forbidden}`);
      }
    }
  });

  test('no version, event type or user is present in the acceptance call anywhere', () => {
    for (const [name, src] of [['web', acceptWeb], ['app', libApp], ['gate', gateApp]] as const) {
      assert.ok(!/business\.commercial_terms_accepted/.test(src), `${name} names the event type`);
      assert.ok(!/COMMERCIAL_TERMS_VERSION\s*[,)]/.test(src) || name === 'app',
        `${name} passes a version`);
    }
  });

  test('status is read through the safe wrapper, never the internal helper', () => {
    for (const [name, src] of [['web', gateServer], ['app', libApp]] as const) {
      assert.match(src, /my_commercial_terms_status/, name);
      assert.ok(!/has_accepted_commercial_terms/.test(src),
        `${name} calls the internal arbitrary-user reader`);
    }
  });
});

/* ── 4. Consent must be affirmative, and the result re-read ─────────────── */

describe('acceptance is deliberate and then verified', () => {
  test('web: the button is disabled until the box is ticked', () => {
    assert.match(acceptWeb, /type="checkbox"/);
    assert.match(acceptWeb, /disabled=\{!agreed \|\| busy\}/);
  });

  test('app: the same', () => {
    assert.match(gateApp, /accessibilityRole="checkbox"/);
    assert.match(gateApp, /disabled=\{!agreed \|\| busy\}/);
  });

  test('web: success refreshes so the server re-reads the status', () => {
    const fn = acceptWeb.slice(acceptWeb.indexOf('async function accept'));
    assert.ok(fn.indexOf('router.refresh()') > fn.indexOf('record_commercial_terms_acceptance'),
      'the unlock must come from a re-read, not from optimistic client state');
    assert.ok(!/setAccepted\(true\)|setStatus\('accepted'\)/.test(fn), 'no optimistic unlock');
  });

  test('app: success re-reads too', () => {
    const fn = gateApp.slice(gateApp.indexOf('async function accept'));
    assert.ok(fn.indexOf('await load()') > fn.indexOf('acceptCommercialTerms'),
      'the app must re-read rather than assume');
    assert.ok(!/setStatus\('accepted'\)/.test(fn), 'no optimistic unlock');
  });

  test('the Terms are linked, and at the section that governs selling', () => {
    assert.match(acceptWeb, /href="\/terms#commercial"/);
    assert.match(acceptWeb, /section 11 of our Terms/);
    assert.match(gateApp, /oneshetland\.com\/terms#commercial/);
    // And that anchor exists rather than scrolling nowhere.
    assert.match(readWeb('app/terms/page.tsx'), /<L id="commercial" h="11\./);
  });
});

/* ── 5. Failing closed ──────────────────────────────────────────────────── */

describe('unknown is never treated as accepted', () => {
  test('web: only a known-and-accepted status opens the screen', () => {
    assert.match(gateServer, /if \(status\.known && status\.accepted\) return null;/);
    assert.match(gateServer, /return \{ known: false \}/);
    // Every failure path answers "unknown", which renders the acceptance surface.
    const fn = gateServer.slice(gateServer.indexOf('export async function commercialTermsStatus'));
    assert.ok((fn.match(/known: false/g) ?? []).length >= 3, 'error, missing data and throw all fail closed');
  });

  test('app: loading and unknown both withhold the screen', () => {
    assert.match(gateApp, /if \(status === 'accepted'\) return <>\{children\}<\/>;/);
    assert.match(gateApp, /if \(!s\.known\) \{ setStatus\('unknown'\); return; \}/);
    const idx = gateApp.indexOf("status === 'accepted'");
    assert.ok(gateApp.indexOf("status === 'loading'") > idx, 'loading does not render children');
  });

  test('a lost owner is told, not silently unlocked', () => {
    assert.match(acceptWeb, /no longer manage this business/);
    assert.match(gateApp, /no longer manage this business/);
  });
});

/* ── 6. What the server actually does, live ─────────────────────────────── */

const OWNER = 'd0de0001-1111-1111-1111-111111111111';
const BIZ_A = 'd0de0002-2222-2222-2222-222222222222';
const BIZ_B = 'd0de0003-3333-3333-3333-333333333333';
const STRANGER = 'd0de0004-4444-4444-4444-444444444444';

const FIXTURE = `
begin;
  insert into auth.users (id, email) values
    ('${OWNER}','ux-owner@probe.invalid'), ('${STRANGER}','ux-stranger@probe.invalid');
  insert into public.local_businesses (id, owner_id, name, category, address, is_active) values
    ('${BIZ_A}', '${OWNER}', 'PROBE A', 'other', 'PROBE', true),
    ('${BIZ_B}', '${OWNER}', 'PROBE B', 'other', 'PROBE', true);
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"${OWNER}","role":"authenticated"}';
`;

describe('one acceptance, one business, one version', () => {
  test('accepting once answers for every commercial screen of that business', () => {
    const [row] = sql(FIXTURE + `
  create temp table s on commit drop as select
    (public.my_commercial_terms_status('${BIZ_A}'::uuid))->>'accepted' as before;
  select public.record_commercial_terms_acceptance('${BIZ_A}'::uuid);
  create temp table s2 on commit drop as select
    (public.my_commercial_terms_status('${BIZ_A}'::uuid))->>'accepted' as after,
    (public.my_commercial_terms_status('${BIZ_B}'::uuid))->>'accepted' as other_business;
  reset role;
  select (select before from s) as before, (select after from s2) as after,
         (select other_business from s2) as other_business,
         (select count(*)::int from public.compliance_log
           where event_type='business.commercial_terms_accepted') as records;
rollback;`);
    assert.equal(row.before, 'false');
    assert.equal(row.after, 'true', 'one acceptance covers every commercial feature');
    assert.equal(row.other_business, 'false', 'business A does not unlock business B');
    assert.equal(row.records, 1);
  });

  test('an acceptance of an older version does not count as acceptance', () => {
    // The log is append-only, so an old acceptance cannot be edited into a
    // current one — it can only sit beside a newer record. What the status
    // must not do is accept the stale one on the current version's behalf.
    const [row] = sql(FIXTURE + `
  reset role;
  insert into public.compliance_log
    (user_id, user_email, event_type, document_version, metadata)
  values ('${OWNER}', 'ux-owner@probe.invalid', 'business.commercial_terms_accepted',
          '0.9', jsonb_build_object('business_id', '${BIZ_A}'));
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"${OWNER}","role":"authenticated"}';
  create temp table s on commit drop as select
    (public.my_commercial_terms_status('${BIZ_A}'::uuid))->>'accepted' as stale_only,
    (public.my_commercial_terms_status('${BIZ_A}'::uuid))->>'version'  as asks_for;
  select public.record_commercial_terms_acceptance('${BIZ_A}'::uuid);
  create temp table s2 on commit drop as select
    (public.my_commercial_terms_status('${BIZ_A}'::uuid))->>'accepted' as after_current;
  reset role;
  select (select stale_only from s) as stale_only, (select asks_for from s) as asks_for,
         (select after_current from s2) as after_current,
         (select count(*)::int from public.compliance_log
           where event_type='business.commercial_terms_accepted') as records;
rollback;`);
    assert.equal(row.stale_only, 'false', 'a 0.9 acceptance must not satisfy the current version');
    assert.equal(row.asks_for, '1.0', 'the status names the version being asked for');
    assert.equal(row.after_current, 'true');
    assert.equal(row.records, 2, 'the old record survives beside the new one');
  });

  test('an acceptance cannot afterwards be edited or removed', () => {
    const [row] = sql(FIXTURE + `
  select public.record_commercial_terms_acceptance('${BIZ_A}'::uuid);
  reset role;
  create temp table r(label text, outcome text) on commit drop;
  do $p$ begin
    update public.compliance_log set document_version = '9.9'
     where event_type = 'business.commercial_terms_accepted';
    insert into r values ('update','REWRITTEN — HOLE');
  exception when others then insert into r values ('update','refused'); end $p$;
  do $p$ begin
    delete from public.compliance_log where event_type = 'business.commercial_terms_accepted';
    insert into r values ('delete','ERASED — HOLE');
  exception when others then insert into r values ('delete','refused'); end $p$;
  select (select outcome from r where label='update') as upd,
         (select outcome from r where label='delete') as del;
rollback;`);
    assert.equal(row.upd, 'refused', 'even the table owner cannot rewrite an acceptance');
    assert.equal(row.del, 'refused');
  });

  test('a stranger cannot accept or read status for a business they do not own', () => {
    const [row] = sql(FIXTURE + `
  reset role;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"${STRANGER}","role":"authenticated"}';
  create temp table r(label text, outcome text) on commit drop;
  grant insert, select on r to authenticated;
  do $p$ begin
    perform public.record_commercial_terms_acceptance('${BIZ_A}'::uuid);
    insert into r values ('write','ACCEPTED — HOLE');
  exception when others then insert into r values ('write','refused'); end $p$;
  do $p$ declare v jsonb; begin
    v := public.my_commercial_terms_status('${BIZ_A}'::uuid);
    insert into r values ('read','LEAKED '||coalesce(v::text,'null'));
  exception when others then insert into r values ('read','refused'); end $p$;
  reset role;
  select (select outcome from r where label='write') as write,
         (select outcome from r where label='read') as read;
rollback;`);
    assert.equal(row.write, 'refused');
    assert.equal(row.read, 'refused');
  });
});

/* ── 7. Enforcement is still off ────────────────────────────────────────── */

describe('the write gate is not live', () => {
  test('web and app share the server-backed version', () => {
    const [row] = sql(`select public.commercial_terms_version() as v;`);
    assert.match(readWeb('lib/compliance.ts'), new RegExp(`COMMERCIAL_TERMS_VERSION = "${row.v}"`));
    assert.match(read('lib/compliance.ts'), new RegExp(`COMMERCIAL_TERMS_VERSION = '${row.v}'`));
  });

  test('commercial policies reference commercial terms 0 times', () => {
    const [row] = sql(`
      select count(*)::int as gated
        from pg_policy p join pg_class c on c.oid=p.polrelid
       where c.relname in ('products','product_variants','business_shipping','book_services',
                           'book_unit_items','book_availability_rules','local_offers',
                           'local_loyalty_programs','events','local_businesses')
         and p.polcmd <> 'r'
         and coalesce(pg_get_expr(p.polwithcheck,p.polrelid),
                      pg_get_expr(p.polqual,p.polrelid)) ilike '%commercial_terms%';`);
    assert.equal(row.gated, 0, 'commercial write enforcement must still be OFF');
  });
});
