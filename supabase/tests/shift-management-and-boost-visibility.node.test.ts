/**
 * shift-management-and-boost-visibility.node.test.ts — two things the first
 * real boost purchase exposed.
 *
 * ONE — THE MANAGEMENT AREA WAS BEHIND THE WRONG DOOR
 *
 * The main nav's "Work" goes to /jobs. That page is entirely worker-facing:
 * browse, filter, apply. Everything belonging to the person who POSTED the work
 * lives at /work, which is only reachable through Account → Work. Two pages,
 * both called Work, and the one you actually land on had no way through to your
 * own postings at all.
 *
 * A shift posted as a business had a second problem: Business → Manage listed
 * Jobs and Job leads under "People", but never Shifts. The natural place to look
 * did not have it.
 *
 * Neither is fixed by moving anything. /work keeps its links, /shifts/manage
 * keeps its route, and the manager component is untouched. What is added is
 * doors: a poster's shortcut on the hub people actually reach, and a Shifts
 * entry in the business area — both leading to the SAME manager.
 *
 * TWO — £2.99 BOUGHT A LIGHTNING GLYPH
 *
 * The web shift card showed boosted state as a bare ⚡ next to the title, with
 * the word "Boosted" only in a title attribute. Beside a verified tick and an
 * urgency pill it read as decoration. The app has shown a filled "★ Boosted"
 * pill all along, and the difference was stark enough that the buyer could not
 * tell their paid shift from an ordinary one.
 *
 * Worse on the shift's own page: an owner who had just paid saw the Boost
 * button disappear and nothing take its place, which reads like a broken button
 * rather than a completed purchase.
 *
 * AUTHORISATION IS UNCHANGED
 *
 * Navigation is not permission. The business Shifts page requires business
 * ownership to enter AND narrows to shifts the account employs on, because
 * posted_as_business_id says whose name is on the advert, not who may cancel or
 * boost it. Showing a Boost button the backend would then refuse is worse than
 * showing nothing.
 *
 * SAFETY
 * Source inspection plus one read-only look at the live boosted shift. Nothing
 * is written, no Stripe object is created, no payment is made, and the real
 * boost is not touched.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const web = (p: string) => readFileSync(join(WEB_ROOT, p), 'utf8');

const jobsHub = web('app/jobs/page.tsx');
const workPage = web('app/work/page.tsx');
const manageDash = web('app/business/[id]/manage/page.tsx');
const bizShifts = web('app/business/[id]/manage/shifts/page.tsx');
const shiftsManage = web('app/shifts/manage/page.tsx');
const dataServer = web('lib/jobs-data.server.ts');
const jobsUI = web('components/jobs/JobsUI.tsx');
const ownerHub = web('components/jobs/ShiftOwnerHub.tsx');
const manager = web('components/jobs/EmployerShiftManager.tsx');
const shiftDetail = web('app/shifts/[id]/page.tsx');
const jobsData = web('lib/jobs-data.ts');

const appWorkTab = read('app/(tabs)/jobs.tsx');
const appMyWork = read('app/my-work.tsx');
const appShiftCard = read('components/ShiftCard.tsx');
const appPosted = read('app/my-posted-shifts.tsx');
const appPostForm = read('components/shifts/ShiftPostForm.tsx');

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

/* ── 1. the poster can get to their own postings ──────────────────────────── */

describe('the Work hub people actually land on has a way through', () => {
  test('the main nav Work item still points at /jobs — that is the page to fix', () => {
    const sections = web('lib/sections.ts');
    assert.match(sections, /label: "Work",\s*\n\s*href: "\/jobs",/);
  });

  test('/jobs now offers the poster their own shifts', () => {
    assert.match(jobsHub, /My posted shifts/);
    assert.match(jobsHub, /const manageHref = isShifts \? "\/shifts\/manage" : "\/jobs\/manage"/);
  });

  test('and it is shown only to somebody who has actually posted', () => {
    assert.match(jobsHub, /\{mine > 0 && \(/);
    assert.match(jobsHub, /const mine = isShifts \? posted\.shifts : posted\.jobs/);
    // A signed-out visitor is never counted, so the query is never run for them.
    assert.match(jobsHub, /account \? getMyPostingCounts\(account\.id\) : Promise\.resolve\(\{ shifts: 0, jobs: 0 \}\)/);
  });

  test('the page stays worker-facing — nothing else was moved into it', () => {
    for (const gone of ['/shifts/new"', '/jobs/new"']) assert.ok(jobsHub.includes(gone));
    assert.ok(!code(jobsHub).includes('EmployerShiftManager'), 'the manager was inlined into the browse hub');
    assert.ok(!code(jobsHub).includes('ShiftBoostModal'), 'boosting was moved into the browse hub');
  });

  test('/work keeps the links it always had', () => {
    assert.match(workPage, /href: "\/shifts\/manage", title: "My posted shifts"/);
    assert.match(workPage, /href: "\/jobs\/manage", title: "My posted jobs"/);
  });

  test('the counts helper asks for counts only, never the postings', () => {
    const fn = dataServer.match(/export async function getMyPostingCounts[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(fn.length > 0);
    assert.match(fn, /count: "exact", head: true/);
    assert.match(fn, /\.eq\("employer_id", userId\)/);
  });
});

/* ── 2. the business area has Shifts ──────────────────────────────────────── */

describe('Business → Manage → Shifts', () => {
  test('the dashboard lists it, next to Jobs, under People', () => {
    assert.match(manageDash, /\$\{base\}\/shifts`, group: "People", icon: "⚡", title: "Shifts", desc: "Post and manage shifts for your business"/);
  });

  test('the route exists', () => {
    assert.ok(existsSync(join(WEB_ROOT, 'app/business/[id]/manage/shifts/page.tsx')));
  });

  test('and reaches the SAME manager, not a second one', () => {
    assert.match(bizShifts, /import \{ EmployerShiftManager \} from "@\/components\/jobs\/EmployerShiftManager"/);
    assert.match(shiftsManage, /import \{ EmployerShiftManager \} from "@\/components\/jobs\/EmployerShiftManager"/);
    // Both hand it the same shape.
    for (const src of [bizShifts, shiftsManage]) {
      assert.match(src, /pending_count: s\.pending_count, total_apps: s\.total_apps, checked_out_count: s\.checked_out_count/);
    }
  });

  test('the two doors are signposted to each other', () => {
    assert.match(bizShifts, /href="\/shifts\/manage"/);
  });
});

/* ── 3. a door is not a permission ────────────────────────────────────────── */

describe('navigation changed; authorisation did not', () => {
  test('the business page still requires business ownership to enter', () => {
    assert.match(bizShifts, /const \{ business, account \} = await requireBusinessOwner\(id\)/);
  });

  test('and then narrows to shifts this account actually employs on', () => {
    assert.match(bizShifts, /getBusinessShifts\(business\.id, account\.id\)/);
    const fn = dataServer.match(/export async function getBusinessShifts[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(fn, /getEmployerShifts\(employerId\)/);
    assert.match(fn, /s\.posted_as_business_id === businessId/);
  });

  test('posted_as_business_id is never used on its own to decide who may manage', () => {
    const fn = dataServer.match(/export async function getBusinessShifts[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(!/\.eq\("posted_as_business_id"/.test(fn),
      'shifts are selected by business alone, without the employer check');
  });

  test('the manager still gates its own actions on shift state, unchanged', () => {
    assert.match(manager, /const canBoost = s\.status === "open" && !isBoosted/);
    assert.match(ownerHub, /const canBoost = s\.status === "open" && !isBoosted/);
  });

  test('the owner hub still renders only for the employer', () => {
    assert.match(shiftDetail, /const isOwner = !!account && shift\.employer_id === account\.id/);
    assert.match(shiftDetail, /\{isOwner && \(\s*\n\s*<ShiftOwnerHub/);
  });
});

/* ── 4. the boost is visible ──────────────────────────────────────────────── */

describe('a boosted shift looks boosted', () => {
  test('the worker-facing card says the word, in a pill', () => {
    assert.match(jobsUI, /⚡ Boosted/);
    const card = jobsUI.slice(jobsUI.indexOf('export function ShiftCard'));
    assert.match(card, /\{boosted && \(\s*\n\s*<span className="rounded-pill/);
  });

  test('the bare glyph beside the title is gone', () => {
    const card = jobsUI.slice(jobsUI.indexOf('export function ShiftCard'), jobsUI.indexOf('export function EmptyState'));
    assert.ok(!/title="Boosted">⚡<\/span>/.test(card), 'the tooltip-only lightning bolt is still there');
  });

  test('and the card itself is tinted, so it reads as different before you read it', () => {
    const card = jobsUI.slice(jobsUI.indexOf('export function ShiftCard'));
    assert.match(card, /style=\{boosted \? \{ borderColor: `\$\{SHIFTS\}66` \} : undefined\}/);
  });

  test('an unboosted shift shows none of it', () => {
    const card = jobsUI.slice(jobsUI.indexOf('export function ShiftCard'));
    assert.match(card, /const boosted = shift\.boosted_until && shift\.boosted_until > now/);
    // Every boosted treatment is behind that one condition.
    assert.equal((card.match(/\{boosted && /g) ?? []).length, 1);
    assert.equal((card.match(/boosted \? \{ borderColor/g) ?? []).length, 1);
  });

  test('the card keeps everything it carried before', () => {
    const card = jobsUI.slice(jobsUI.indexOf('export function ShiftCard'), jobsUI.indexOf('export function EmptyState'));
    for (const kept of ['shift.title', 'urg.label', 'formatPay(shift.pay_type', 'formatShiftDate(shift.start_at)',
                        'formatDuration(shift.start_at', 'SHIFT_CATEGORY_LABELS[shift.category]',
                        'shift.location_text', 'spotsLeft']) {
      assert.ok(card.includes(kept), `the card lost ${kept}`);
    }
  });

  test('the shift page the card opens says it too', () => {
    assert.match(shiftDetail, /const boosted = !!\(shift\.boosted_until && shift\.boosted_until > new Date\(\)\.toISOString\(\)\)/);
    assert.match(shiftDetail, /\{boosted && \(\s*\n\s*<span[^>]*>⚡ Boosted<\/span>/);
  });
});

/* ── 5. the employer sees what they bought ────────────────────────────────── */

describe('the owner view confirms the purchase', () => {
  test('the shift owner page now shows a boosted panel where the CTA used to be', () => {
    assert.match(ownerHub, /\{isBoosted && \(/);
    assert.match(ownerHub, /<p className="font-display text-lg font-bold text-ink">Boosted<\/p>/);
  });

  test('with time remaining, not a raw timestamp', () => {
    assert.match(ownerHub, /boostTimeLeft\(s\.boosted_until\)/);
    assert.ok(!/boosted_until\}<\/p>/.test(ownerHub), 'the owner is shown the raw expiry');
  });

  test('the manager keeps its pill and gains the remaining time', () => {
    assert.match(manager, /⚡ Boosted<\/span>/);
    assert.match(manager, /boostTimeLeft\(s\.boosted_until\)/);
  });

  test('the helper never claims time on an expired boost', () => {
    const fn = jobsData.match(/export function boostTimeLeft[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(fn, /if \(!boostedUntil\) return null/);
    assert.match(fn, /if \(ms <= 0\) return null/);
  });
});

/* ── 6. ranking is untouched ──────────────────────────────────────────────── */

describe('the functional effect of a boost is unchanged', () => {
  test('web still partitions boosted first on boosted_until > now', () => {
    const fn = jobsData.match(/export async function getOpenShifts[\s\S]*?\n\}/)?.[0] ?? '';
    assert.match(fn, /const boosted = all\.filter\(s => s\.boosted_until && s\.boosted_until > now\)/);
    assert.match(fn, /const regular = all\.filter\(s => !s\.boosted_until \|\| s\.boosted_until <= now\)/);
    assert.match(fn, /\[\.\.\.boosted, \.\.\.regular\]/);
  });

  test('the home shelf ordering is unchanged', () => {
    const home = web('lib/home-data.ts');
    assert.match(home, /const ab = a\.boosted_until && a\.boosted_until > now \? 0 : 1/);
  });

  test('the app orders the same way', () => {
    const api = read('lib/shifts-api.ts');
    assert.match(api, /const boosted = all\.filter\(s => s\.boosted_until && s\.boosted_until > now\)/);
  });

  test('an expired boost gets no advantage anywhere — expiry is query-time', () => {
    // Nothing sweeps boosted_until; every reader compares it to now.
    const migrations = read('supabase/migrations/20260825120000_shift_boost_eligibility_and_atomic_fulfilment.sql');
    assert.ok(!/delete from public\.shifts|set boosted_until = null/i.test(migrations));
  });
});

/* ── 7. the app ───────────────────────────────────────────────────────────── */

describe('the app keeps what it had', () => {
  test('its Boosted pill still derives from boosted_until', () => {
    assert.match(appShiftCard, /const featured = shift\.boosted_until != null && new Date\(shift\.boosted_until\) > new Date\(\)/);
    assert.match(appShiftCard, /name="star"[\s\S]{0,120}Boosted/);
  });

  test('the posted-shifts screen still badges an active boost', () => {
    assert.match(appPosted, /const isActiveBoosted = !!\(item\.boosted_until && item\.boosted_until > now\)/);
    assert.match(appPosted, /⚡ Boosted/);
  });

  test('paid boost purchase is still absent from the app', () => {
    const app = code(appPosted + appPostForm + read('app/shift-detail.tsx') + appWorkTab);
    for (const banned of ['create-boost-intent', 'confirm-boost', 'ShiftBoostModal', '£2.99', 'PRICE_PENCE']) {
      assert.ok(!app.includes(banned), `the app reintroduced ${banned}`);
    }
  });

  test('BoostSheet is still only a "shift posted" confirmation', () => {
    // Bound to the function itself — the file continues past it, and the
    // sheet's own style names (boostSheet, boostBtn) are a leftover of what it
    // used to be, not evidence that it sells anything.
    const start = appPostForm.indexOf('export function BoostSheet');
    const sheet = appPostForm.slice(start, appPostForm.indexOf('\nexport function', start + 10));
    assert.match(sheet, /Shift posted!/);
    for (const selling of ['£', 'Pay ', 'create-boost-intent', 'startShiftBoost', '299']) {
      assert.ok(!sheet.includes(selling), `BoostSheet sells a boost again (${selling})`);
    }
  });

  test('the app Work tab now reaches My posted shifts, for posters only', () => {
    assert.match(appWorkTab, /router\.push\(tier === 'jobs' \? '\/my-posted-jobs' : '\/my-posted-shifts'\)/);
    assert.match(appWorkTab, /\(tier === 'jobs' \? myPosted\.jobs : myPosted\.shifts\) > 0 && \(/);
    assert.match(appWorkTab, /count: 'exact', head: true/);
  });

  test('Me → My work keeps its entry', () => {
    assert.match(appMyWork, /label: 'My posted shifts'/);
  });
});

/* ── 8. nothing financial moved ───────────────────────────────────────────── */

describe('no payment code was touched', () => {
  test('the price and the endpoints are where they were', () => {
    assert.match(read('supabase/functions/create-boost-intent/index.ts'), /amount:\s+'299'/);
    assert.match(web('components/jobs/ShiftBoostModal.tsx'), /const PRICE_PENCE = 299/);
  });

  test('the attempt reference and shared fulfilment survive', () => {
    assert.match(web('lib/shift-boost-client.ts'), /client_request_id: attemptId/);
    assert.match(read('supabase/functions/_shared/fulfilment.ts'), /case 'shift_boost':\s+return fulfilShiftBoost\(svc, pi\)/);
  });

  test('none of the pages changed here talk to Stripe', () => {
    for (const [name, src] of [['jobs hub', jobsHub], ['business shifts', bizShifts],
                               ['shift detail', shiftDetail], ['card', jobsUI]] as const) {
      for (const w of ['stripe', 'payment_intent', 'client_request_id']) {
        assert.ok(!code(src).toLowerCase().includes(w), `${name} touches ${w}`);
      }
    }
  });
});
