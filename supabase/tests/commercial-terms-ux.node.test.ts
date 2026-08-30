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
    for (const f of ['local-business-register', 'local-business-analytics',
                     'business-jobs', 'business-leads', 'business-orders', 'local-business-transactions']) {
      assert.ok(!/CommercialTermsGate/.test(read(`app/${f}.tsx`)), f);
    }
  });

  /**
   * The dashboard used to be on that list, on the strength of never mentioning
   * the gate at all. It mentions it now — over two money controls embedded in
   * it, shown in a Modal — so the absence of a string stopped being the rule.
   * The rule was always that the SCREEN is not gated, and that is what is
   * checked here and in "the dashboard stays open; its money controls do not".
   */
  test('the dashboard screen is open even though two controls on it are not', () => {
    const src = read('app/local-business-dashboard.tsx');
    assert.ok(!/return \(\s*<CommercialTermsGate/.test(src), 'the screen must not be wrapped');
    const gateAt = src.indexOf('<CommercialTermsGate');
    assert.ok(gateAt > src.indexOf('<Modal'), 'the gate appears only over the screen');
    // The dashboard renders without asking anything: the guard runs on tap.
    assert.match(src, /const requireCommercialTerms = useCallback\(async/);
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
                     'event-create', 'payment-setup']) {
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

/* ── 2b. Paying as a business, versus paying as yourself ────────────────── */

describe('business money setup is commerce; personal money setup is not', () => {
  test('the app gates payment setup only when it is for a business', () => {
    const src = read('app/payment-setup.tsx');
    assert.match(src, /if \(!businessId\) return <PaymentSetupBody \/>;/,
      'setting up your own card must not ask for selling terms');
    const personal = src.indexOf('if (!businessId) return');
    const gate = src.indexOf('<CommercialTermsGate businessId=');
    assert.ok(personal > 0 && gate > personal, 'the business path still goes through the gate');
  });

  test('the personal payment screens are untouched on both platforms', () => {
    // Your own card and your own payout account are account management. The
    // web pages carry no businessId at all, which is the reason.
    for (const f of ['app/account/payments/page.tsx', 'components/payments/CardSetup.tsx',
                     'components/payments/ConnectPayoutsButton.tsx', 'components/welcome/JoinWizard.tsx']) {
      assert.ok(!/commercialTermsGate|CommercialTermsAccept/.test(readWeb(f)), f);
    }
    assert.ok(!/businessId|business_id/.test(readWeb('components/payments/ConnectPayoutsButton.tsx')),
      'the payouts button is personal — it takes no business');
    for (const f of ['app/account.tsx', 'app/(tabs)/me.tsx']) {
      assert.ok(!/CommercialTermsGate/.test(read(f)), f);
    }
  });

  test("a business's bank and card setup sits behind the gate on the web", () => {
    // Business Stripe Connect onboarding and the business card both live in
    // BillingManager, which only the gated billing route renders.
    const billing = readWeb('components/business/BillingManager.tsx');
    assert.match(billing, /Business bank \(Stripe Connect\)/, 'BillingManager owns business Connect');
    assert.match(billing, /use_business_payout/);
    const pages = execFileSync('grep',
      ['-rl', 'BillingManager', join(WEB, 'app')], { encoding: 'utf8' }).trim().split('\n');
    for (const page of pages) {
      const src = readFileSync(page, 'utf8');
      assert.match(src, /commercialTermsGate\(business, "/, `${page} renders BillingManager ungated`);
    }
  });

  test('every consumer route into payment setup stays personal', () => {
    // Adding a card to buy a gift, top up the wallet or pay for a Fetch must
    // never meet selling terms. Only the business dashboard passes a
    // businessId, and that is the one path that is gated.
    const routes = execFileSync('grep',
      ['-rn', "payment-setup'", join(REPO_ROOT, 'app')], { encoding: 'utf8' })
      .trim().split('\n').filter((l) => /router\.push/.test(l));
    assert.ok(routes.length >= 8, 'expected the consumer add-card routes to be found');
    const withBusiness = routes.filter((l) => /businessId/.test(l));
    assert.equal(withBusiness.length, 1, 'exactly one route sets up a business card');
    assert.match(withBusiness[0], /local-business-dashboard/);
  });

  test('the existing acceptance opens payment setup — there is no second one', () => {
    // The gate asks about a BUSINESS, never about a feature. `feature` reaches
    // the wording and nothing else, so an acceptance recorded on Products is
    // the same acceptance payment setup reads. Nothing per-feature exists to
    // accept a second time.
    for (const [name, src] of [['web gate', gateServer], ['app lib', libApp]] as const) {
      // The call, not the comment that mentions it.
      const at = src.search(/rpc\(\s*['"]my_commercial_terms_status['"]/);
      assert.ok(at > 0, `${name}: no status call found`);
      const args = src.slice(at, src.indexOf('}', at) + 1);
      assert.match(args, /p_business_id/, name);
      assert.ok(!/feature/i.test(args), `${name} narrows the status by feature`);
    }
    assert.ok(!/feature/.test(acceptWeb.slice(acceptWeb.indexOf('record_commercial_terms_acceptance'),
                                              acceptWeb.indexOf('if (rpcErr)'))),
      'the writer records a business, not a feature');
  });

  test('no Stripe or Connect implementation was changed to achieve this', () => {
    // The gate is presentation. The money code is not part of it.
    const src = read('app/payment-setup.tsx');
    assert.match(src, /create-setup-intent/, 'the setup call is still the same one');
    assert.ok(!/account_link|createBusinessOnboardingLink/.test(src),
      'this route does not do Connect onboarding and must not start');
    // The gate wrapper touches params and children only — no Stripe calls in it.
    const wrapper = src.slice(src.indexOf('export default function PaymentSetupScreen'));
    assert.ok(!/supabase|stripe|Stripe/.test(wrapper), 'the wrapper does no payment work');
  });
});

/* ── 2c. Commercial controls inside an ungated screen ───────────────────── */

describe('the dashboard stays open; its money controls do not', () => {
  const dash = () => read('app/local-business-dashboard.tsx');

  test('the dashboard itself is not gated', () => {
    const src = dash();
    assert.ok(!/<CommercialTermsGate businessId=\{businessId\}>/.test(src));
    // It must not be wrapped: the gate appears only inside a Modal.
    const gateAt = src.indexOf('<CommercialTermsGate');
    const modalAt = src.indexOf('<Modal');
    assert.ok(gateAt > modalAt && modalAt > 0, 'the gate is shown over the screen, not instead of it');
    assert.ok(!/export default function BusinessDashboardScreen\(\)[^]*?return \(\s*<CommercialTermsGate/.test(src),
      'the screen is not wrapped by the gate');
  });

  test('ordinary Directory management is not behind the guard', () => {
    // Everything a business that never sells anything still needs.
    const src = dash();
    for (const fn of ['toggleAcceptWallet', 'saveProfile', 'refreshCode', 'requestNfcTile',
                      'upsertLoyaltyProgram', 'requestAlertAccess']) {
      if (!src.includes(fn)) continue;
      const at = src.indexOf(`const ${fn}`);
      if (at < 0) continue;
      const body = src.slice(at, src.indexOf('\n  };', at));
      assert.ok(!/requireCommercialTerms/.test(body), `${fn} must not require commercial acceptance`);
    }
  });

  test('the Connect action asks before the account link exists', () => {
    const src = dash();
    const fn = src.slice(src.indexOf('const handleConnectStripe'));
    const body = fn.slice(0, fn.indexOf('\n  };'));
    const guard = body.indexOf('requireCommercialTerms');
    const call = body.indexOf('createBusinessOnboardingLink');
    assert.ok(guard > 0, 'the Connect action is not gated');
    assert.ok(call > guard, 'createBusinessOnboardingLink must not be reachable before acceptance');
    assert.match(body, /if \(!\(await requireCommercialTerms\([^)]*\)\)\) return;/,
      'refusal must stop the action, not merely warn');
  });

  test('the payout toggle asks before the write', () => {
    const src = dash();
    const fn = src.slice(src.indexOf('const toggleBusinessPayout'));
    const body = fn.slice(0, fn.indexOf('\n  };'));
    const guard = body.indexOf('requireCommercialTerms');
    const write = body.indexOf('updateBusiness');
    assert.ok(guard > 0, 'the payout toggle is not gated');
    assert.ok(write > guard, 'use_business_payout must not be written before acceptance');
    assert.ok(body.indexOf('setActiveBusiness') > guard, 'nor may the local state flip first');
  });

  test('the guard fails closed and reads the server, not a local flag', () => {
    const src = dash();
    const fn = src.slice(src.indexOf('const requireCommercialTerms'));
    const body = fn.slice(0, fn.indexOf('\n  }, ['));
    assert.match(body, /fetchCommercialTermsStatus\(activeBusiness\.id\)/, 'it must ask the server');
    assert.match(body, /if \(status\.known && status\.accepted\) return true;/,
      'only a known, accepted status may proceed');
    assert.match(body, /return false;/);
    // No local shortcut that could stand in for the server's answer.
    assert.ok(!/activeBusiness\.(terms|accepted)/.test(body), 'no client-side acceptance flag');
  });

  test('rendering the dashboard or the gate calls nothing at Stripe', () => {
    const src = dash();
    // The only createBusinessOnboardingLink call site is inside the guarded action.
    const calls = [...src.matchAll(/createBusinessOnboardingLink\(/g)].map((m) => m.index!);
    assert.equal(calls.length, 1, 'exactly one call site, inside the gated action');
    const guardAt = src.indexOf("requireCommercialTerms('Business bank account')");
    assert.ok(guardAt > 0 && calls[0] > guardAt);
    // And it sits inside the tap handler, not in an effect or at render.
    const fnStart = src.indexOf('const handleConnectStripe');
    const fnEnd = src.indexOf('\n  };', fnStart);
    assert.ok(fnStart > 0 && calls[0] > fnStart && calls[0] < fnEnd,
      'onboarding must only be reachable from the guarded tap handler');
  });

  test('it reuses the one acceptance experience — no second one was made', () => {
    const src = dash();
    assert.match(src, /import \{ CommercialTermsGate \} from '@\/components\/CommercialTermsGate';/);
    assert.match(src, /import \{ fetchCommercialTermsStatus \} from '@\/lib\/commercial-terms';/);
    // The confirmation panel accepts nothing.
    const notice = src.slice(src.indexOf('function CommercialTermsAccepted'));
    const body = notice.slice(0, notice.indexOf('\n}'));
    for (const forbidden of ['record_commercial_terms_acceptance', 'checkbox', 'accessibilityRole="checkbox"',
                             'COMMERCIAL_TERMS_VERSION', 'compliance_log']) {
      assert.ok(!body.includes(forbidden), `the confirmation panel must not ${forbidden}`);
    }
    // Still exactly one acceptance component per platform.
    assert.equal([...src.matchAll(/type="checkbox"|accessibilityRole="checkbox"/g)].length, 0);
  });

  test('the business payment toggle is noted, and reaches a gated destination', () => {
    // Choosing to use a business card is a preference; SETTING UP that card is
    // the commercial act, and payment-setup?businessId is gated (W3H.1).
    const src = dash();
    assert.match(src, /pathname: '\/payment-setup', params: \{ businessId/);
    assert.match(read('app/payment-setup.tsx'), /<CommercialTermsGate businessId=/);
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
           where event_type='business.commercial_terms_accepted' and user_id in (select id from auth.users where email like '%@probe.invalid')) as records;
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
           where event_type='business.commercial_terms_accepted' and user_id in (select id from auth.users where email like '%@probe.invalid')) as records;
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
     where event_type = 'business.commercial_terms_accepted'
       and metadata->>'business_id' = '${BIZ_A}';
    insert into r values ('update','REWRITTEN — HOLE');
  exception when others then insert into r values ('update','refused'); end $p$;
  do $p$ begin
    delete from public.compliance_log where event_type = 'business.commercial_terms_accepted'
       and metadata->>'business_id' = '${BIZ_A}';
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
