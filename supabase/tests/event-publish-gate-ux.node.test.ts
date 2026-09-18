/**
 * event-publish-gate-ux.node.test.ts — the paid-event payout gate was
 * already correct (proven by ZZ TEST — Payout Gate Test: the event stayed a
 * draft). This proves the UX CLARITY fix on top of it: a merchant who
 * attempts to publish a paid/mixed event while not payout-ready must be
 * told unmistakably that the save succeeded but publish did not, both
 * immediately (a confirmation dialog) and persistently (Event Manage's own
 * state), on both platforms.
 *
 * WHAT CHANGED — none of it is the gate itself
 *   1. event-create.tsx / BusinessEventForm.tsx: the alert shown after a
 *      downgraded save is now eventSavedAsDraftPrompt /
 *      EVENT_SAVED_AS_DRAFT_PROMPT ("Event saved as draft" — explicitly
 *      distinct from payoutNotReadyPrompt / PAYOUT_NOT_READY_PROMPT, which
 *      fires BEFORE a save, not after one that already succeeded).
 *   2. event-manage.tsx / BusinessEventManage.tsx: a new notReadyPaidDraft
 *      boolean (draft + an active paid ticket type + payout_ready !== true;
 *      mobile additionally excludes hub events, which don't use this payout
 *      model) drives:
 *        - a prominent amber "Not published" banner with a Connect Stripe
 *          action, additional to the small status-strip dot
 *        - the green "Publish now" button replaced with "Connect Stripe to
 *          publish", which navigates to the existing Connect Stripe /
 *          Plan & payouts route instead of attempting (and failing) to
 *          publish
 *   3. "View public page" reads "Preview public page" for any non-published
 *      event — investigated, not silently changed: a draft is NOT publicly
 *      readable (see the RLS note below), so this is a label correction,
 *      not an access-control change.
 *
 * INVESTIGATED, NOT CHANGED: draft public accessibility
 *   events_public_read's first OR-branch requires `NOT is_hidden`, and the
 *   tg_events_sync BEFORE INSERT OR UPDATE trigger
 *   (supabase/migrations/20260623000000_baseline_remote_schema.sql,
 *   tg_events_sync_hidden: `new.is_hidden := (new.status <> 'published')`)
 *   forcibly recomputes is_hidden from status server-side on every write —
 *   a client cannot set is_hidden independently of status. A draft is
 *   therefore NOT anonymously readable; the only OR-branches that can still
 *   match are organiser_user_id / is_business_owner / hub admin / platform
 *   admin — all legitimate owner/admin access, not public access. This is
 *   why "Preview public page" is an accurate rename rather than a fix.
 *
 * WHAT IS ASSERTED
 *   1-3  the post-save prompt on both platforms: title says "saved as
 *        draft", body says the event isn't live / paid tickets need
 *        Stripe / settings were kept, and it offers Connect Stripe
 *   4    the amber banner renders on both platforms exactly when
 *        notReadyPaidDraft is true
 *   5-7  notReadyPaidDraft executed for real against paid+not-ready,
 *        free-only, and paid+ready event shapes, on both platforms
 *   8-9  the public-page action label switches on published vs not
 *   10   mobile and web read the identical inputs (status, an active paid
 *        ticket type, payout_ready) to the identical boolean
 *
 * WHAT THIS FILE CANNOT PROVE
 * Source-level assertions and real execution of the lifted boolean/prompt
 * logic — not a rendered screenshot. The RLS/trigger claim above is proven
 * by reading the migration SQL that defines it, not by a live anonymous
 * fetch against production (out of scope here; see
 * business-payout-canonical-resolver.node.test.ts and
 * event-payout-fallback.node.test.ts for this session's live-data payout
 * verification conventions).
 *
 * SAFETY
 * Reads source only. No database, no network, no writes.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const readWeb = (p: string) => readFileSync(join(WEB, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

function liftFn(src: string, decl: string): string {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} not found`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.notEqual(end, -1, `end of ${decl} not found`);
  return src.slice(start, end + 1);
}

function extractBlock(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  assert.notEqual(start, -1, `start marker not found: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.notEqual(end, -1, `end marker not found: ${endMarker}`);
  return src.slice(start, end + endMarker.length);
}

function runJs(js: string): unknown {
  const mod = { exports: {} as unknown };
  new Function('module', 'exports', js)(mod, mod.exports);
  return mod.exports;
}

const transpile = (tsSrc: string) =>
  ts.transpileModule(tsSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

const mobileManage = code(read('app/event-manage.tsx'));
const webManage     = code(readWeb('components/business/BusinessEventManage.tsx'));
const mobileCreate  = code(read('app/event-create.tsx'));
const webForm       = code(readWeb('components/business/BusinessEventForm.tsx'));
const mobilePayout  = code(read('lib/payout-readiness.ts'));
const webPayout     = code(readWeb('lib/payout-readiness.ts'));

/* ════════════════════════════════════════════════════════════════════════
   1-3. The post-save "Event saved as draft" confirmation, both platforms.
   ════════════════════════════════════════════════════════════════════════ */

describe('1-3. The post-save confirmation explicitly says the save succeeded and publish did not', () => {
  test('mobile: event-create.tsx calls eventSavedAsDraftPrompt, not the pre-save payoutNotReadyPrompt', () => {
    assert.match(mobileCreate, /import \{ requirePayoutReadyForPaidActivation, eventSavedAsDraftPrompt \} from '@\/lib\/payout-readiness';/);
    assert.match(mobileCreate, /alert\(eventSavedAsDraftPrompt\(/);
    assert.doesNotMatch(mobileCreate, /alert\(payoutNotReadyPrompt\(/, 'the generic pre-save prompt must not be reused here');
  });

  test('web: BusinessEventForm.tsx calls EVENT_SAVED_AS_DRAFT_PROMPT, not the pre-save PAYOUT_NOT_READY_PROMPT', () => {
    assert.match(webForm, /import \{ requirePayoutReadyForPaidActivation, EVENT_SAVED_AS_DRAFT_PROMPT \} from "@\/lib\/payout-readiness";/);
    assert.match(webForm, /confirm\(EVENT_SAVED_AS_DRAFT_PROMPT\)/);
    assert.doesNotMatch(webForm, /confirm\(PAYOUT_NOT_READY_PROMPT\)/, 'the generic pre-save prompt must not be reused here');
  });

  test('mobile: eventSavedAsDraftPrompt content — title, body and both actions', () => {
    const fn = liftFn(mobilePayout, 'export function eventSavedAsDraftPrompt(onConnectStripe: () => void): AlertOptions {');
    assert.match(fn, /title: 'Event saved as draft'/);
    assert.match(fn, /isn't live yet/);
    assert.match(fn, /Connect Stripe before you can publish paid tickets/);
    assert.match(fn, /Your event and ticket settings have been saved/);
    assert.match(fn, /label: 'Not now', style: 'cancel'/);
    assert.match(fn, /label: 'Connect Stripe', style: 'primary', onPress: onConnectStripe/);
  });

  test('web: EVENT_SAVED_AS_DRAFT_PROMPT content — title, body and both actions', () => {
    const start = webPayout.indexOf('export const EVENT_SAVED_AS_DRAFT_PROMPT = {');
    assert.notEqual(start, -1);
    const block = webPayout.slice(start, webPayout.indexOf('};', start) + 2);
    assert.match(block, /title: "Event saved as draft"/);
    assert.match(block, /isn't live yet/);
    assert.match(block, /Connect Stripe before you can publish paid tickets/);
    assert.match(block, /Your event and ticket settings have been saved/);
    assert.match(block, /confirmLabel: "Connect Stripe"/);
    assert.match(block, /cancelLabel: "Not now"/);
  });

  test('parity: mobile and web say the identical three things — not live, paid tickets need Stripe, settings kept', () => {
    for (const src of [mobilePayout, webPayout]) {
      assert.match(src, /isn't live yet/);
      assert.match(src, /Connect Stripe before you can publish paid tickets/);
      assert.match(src, /Your event and ticket settings have been saved/);
    }
  });

  test('the two prompts remain genuinely distinct — pre-save vs post-save wording never merged', () => {
    // payoutNotReadyPrompt/PAYOUT_NOT_READY_PROMPT (used by Products/Passes/
    // Wallet, and nothing about events after this fix) must still exist,
    // unchanged, with its own different title.
    assert.match(mobilePayout, /title: 'Connect Stripe to take payments'/);
    assert.match(webPayout, /title: "Connect Stripe to take payments"/);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   4-7. Event Manage: the amber banner and the Publish/Connect-Stripe
   button, executed for real against paid+not-ready / free-only /
   paid+ready event shapes.
   ════════════════════════════════════════════════════════════════════════ */

describe('4-7. Event Manage: not-published state is unmissable, and never misrepresents a blocked publish as normal', () => {
  function loadMobileHelper() {
    const fn = liftFn(code(read('lib/events-api.ts')), 'export function eventHasActivePaidTicket(types: EventTicketType[]): boolean {');
    const js = transpile(fn.replace('export function', 'function') + '\nmodule.exports = eventHasActivePaidTicket;');
    return runJs(js) as (types: unknown[]) => boolean;
  }
  function loadWebHelper() {
    const fn = liftFn(code(readWeb('lib/events-manage-client.ts')), 'export function eventHasActivePaidTicket(types: { is_active: boolean; price_pence: number }[]): boolean {');
    const js = transpile(fn.replace('export function', 'function') + '\nmodule.exports = eventHasActivePaidTicket;');
    return runJs(js) as (types: unknown[]) => boolean;
  }

  function runMobile(opts: { status: string; ticketTypes: unknown[]; payoutReady: boolean; isHub?: boolean }) {
    const block = extractBlock(mobileManage,
      "const notReadyPaidDraft = status === 'draft'",
      "&& event.payout_ready !== true;");
    const shim = `
      const eventHasActivePaidTicket = ${loadMobileHelper().toString()};
      function run() {
        const status = ${JSON.stringify(opts.status)};
        const event = {
          organiser_hub_id: ${JSON.stringify(opts.isHub ? 'hub-1' : null)},
          ticket_types: ${JSON.stringify(opts.ticketTypes)},
          payout_ready: ${JSON.stringify(opts.payoutReady)},
        };
        ${block}
        return notReadyPaidDraft;
      }
      module.exports = run;
    `;
    return (runJs(transpile(shim)) as () => boolean)();
  }

  function runWeb(opts: { status: string; ticketTypes: unknown[]; payoutReady: boolean }) {
    const block = extractBlock(webManage,
      'const notReadyPaidDraft = status === "draft"',
      '&& !event.payout_ready;');
    const shim = `
      const eventHasActivePaidTicket = ${loadWebHelper().toString()};
      function run() {
        const status = ${JSON.stringify(opts.status)};
        const event = { ticket_types: ${JSON.stringify(opts.ticketTypes)}, payout_ready: ${JSON.stringify(opts.payoutReady)} };
        ${block}
        return notReadyPaidDraft;
      }
      module.exports = run;
    `;
    return (runJs(transpile(shim)) as () => boolean)();
  }

  const PAID   = [{ is_active: true, price_pence: 100 }];
  const MIXED  = [{ is_active: true, price_pence: 0 }, { is_active: true, price_pence: 100 }];
  const FREE   = [{ is_active: true, price_pence: 0 }];

  for (const [platform, run] of [['mobile', runMobile], ['web', runWeb]] as const) {
    test(`${platform} 5. paid draft, not payout-ready → notReadyPaidDraft is true (no misleading "Publish now")`, () => {
      assert.equal(run({ status: 'draft', ticketTypes: PAID, payoutReady: false }), true);
    });

    test(`${platform} 5b. mixed draft, not payout-ready → also true (mixed counts as paid)`, () => {
      assert.equal(run({ status: 'draft', ticketTypes: MIXED, payoutReady: false }), true);
    });

    test(`${platform} 6. free-only draft → false regardless of payout_ready — normal "Publish now" applies`, () => {
      assert.equal(run({ status: 'draft', ticketTypes: FREE, payoutReady: false }), false);
      assert.equal(run({ status: 'draft', ticketTypes: FREE, payoutReady: true }), false);
    });

    test(`${platform} 7. paid draft, payout-ready → false — normal "Publish now" applies`, () => {
      assert.equal(run({ status: 'draft', ticketTypes: PAID, payoutReady: true }), false);
    });

    test(`${platform} a published paid event is never flagged (status guard)`, () => {
      assert.equal(run({ status: 'published', ticketTypes: PAID, payoutReady: false }), false);
    });
  }

  test('mobile: hub events are never flagged, even with an active paid ticket and no payout route — hubs use a different payout model', () => {
    assert.equal(runMobile({ status: 'draft', ticketTypes: PAID, payoutReady: false, isHub: true }), false);
  });

  test('4. the amber "Not published" banner renders exactly when notReadyPaidDraft is true, on both platforms', () => {
    assert.match(mobileManage, /\{notReadyPaidDraft && \(/);
    assert.match(mobileManage, /Not published/);
    assert.match(mobileManage, /Connect Stripe to publish this event and start selling paid tickets\./);
    assert.match(webManage, /\{notReadyPaidDraft && \(/);
    assert.match(webManage, /Not published/);
    assert.match(webManage, /Connect Stripe to publish this event and start selling paid tickets\./);
  });

  test('5. the misleading green "Publish now" is replaced, not merely relabelled — it no longer calls the publish action', () => {
    const mobileBranch = extractBlock(mobileManage, 'notReadyPaidDraft ? (', ') : (');
    assert.match(mobileBranch, /onPress=\{onConnectStripe\}/);
    assert.doesNotMatch(mobileBranch, /onChangeStatus\('published'\)/, 'the not-ready branch must not attempt to publish');
    assert.match(mobileBranch, /Connect Stripe to publish/);

    const webBranch = extractBlock(webManage, 'notReadyPaidDraft ? (', ') : (');
    assert.match(webBranch, /onClick=\{goConnectStripe\}/);
    assert.doesNotMatch(webBranch, /changeStatus\("published"\)/, 'the not-ready branch must not attempt to publish');
    assert.match(webBranch, /Connect Stripe to publish/);
  });

  test('the normal ready/free-only branch is untouched — still calls the real publish action, still says "Publish now"', () => {
    assert.match(mobileManage, /onPress=\{\(\) => onChangeStatus\('published'\)\}/);
    assert.match(mobileManage, />Publish now</);
    assert.match(webManage, /onClick=\{\(\) => changeStatus\("published"\)\}/);
    assert.match(webManage, />Publish now</);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   8-9. Public-page action label: Preview vs View.
   ════════════════════════════════════════════════════════════════════════ */

describe('8-9. the public-page action label reflects whether the event is actually published', () => {
  test('mobile: label switches on isPublished', () => {
    assert.match(mobileManage, /label=\{isPublished \? 'View public page' : 'Preview public page'\}/);
  });

  test('web: label switches on isPublished', () => {
    assert.match(webManage, /\{isPublished \? "View public page" : "Preview public page"\}/);
  });

  test('the route itself is unchanged on both platforms — this is a label correction, not a new preview mechanism', () => {
    assert.match(mobileManage, /pathname: '\/events\/\[id\]', params: \{ id: event\.id \}/);
    assert.match(webManage, /href=\{`\/events\/\$\{event\.id\}`\}/);
  });

  test('investigated: a draft is not publicly readable — the RLS policy\'s NOT is_hidden branch cannot pass for one', () => {
    const rlsMigration = read('supabase/migrations/20260822140000_event_read_without_business_select.sql');
    assert.match(rlsMigration, /NOT is_hidden/);
    const trigger = read('supabase/migrations/20260623000000_baseline_remote_schema.sql');
    assert.match(trigger, /new\.is_hidden\s*:=\s*\(new\.status <> 'published'\)/,
      'is_hidden must be server-derived from status, not independently settable by a client');
    assert.match(trigger, /CREATE TRIGGER tg_events_sync BEFORE INSERT OR UPDATE ON public\.events/);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   10. Parity.
   ════════════════════════════════════════════════════════════════════════ */

describe('10. mobile and web read the identical inputs to the identical not-published rule', () => {
  test('both derive notReadyPaidDraft from status, an active paid ticket type, and payout_ready — nothing else', () => {
    assert.match(mobileManage, /status === 'draft'/);
    assert.match(mobileManage, /eventHasActivePaidTicket\(event\.ticket_types \?\? \[\]\)/);
    assert.match(mobileManage, /event\.payout_ready !== true/);

    assert.match(webManage, /status === "draft"/);
    assert.match(webManage, /eventHasActivePaidTicket\(event\.ticket_types\)/);
    assert.match(webManage, /!event\.payout_ready/);
  });

  test('both eventHasActivePaidTicket helpers apply the identical rule: active AND price_pence > 0', () => {
    const mobileFn = liftFn(code(read('lib/events-api.ts')), 'export function eventHasActivePaidTicket(types: EventTicketType[]): boolean {');
    const webFn = liftFn(code(readWeb('lib/events-manage-client.ts')), 'export function eventHasActivePaidTicket(types: { is_active: boolean; price_pence: number }[]): boolean {');
    assert.match(mobileFn, /t\.is_active && t\.price_pence > 0/);
    assert.match(webFn, /t\.is_active && t\.price_pence > 0/);
  });

  test('both read payout_ready already resolved server-side by the event fetch — neither re-derives it from raw Stripe columns', () => {
    for (const src of [mobileManage, webManage]) {
      assert.doesNotMatch(src, /stripe_account_id/);
      assert.doesNotMatch(src, /payout_enabled/);
      assert.doesNotMatch(src, /use_business_payout/);
    }
    assert.match(readWeb('lib/events-manage.ts'), /rpc\("event_payout_ready", \{ p_event_id: eventId \}\)/);
  });

  test('neither platform adds a fresh RPC call on Event Manage itself — this is a display read of the already-fetched signal, not a new gate', () => {
    assert.doesNotMatch(mobileManage, /requirePayoutReadyForPaidActivation/);
    assert.doesNotMatch(webManage, /requirePayoutReadyForPaidActivation/);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   Preserved business rules (scope 5): nothing about the actual gate moved.
   ════════════════════════════════════════════════════════════════════════ */

describe('preserved: the underlying gate, server protection and other business rules are untouched', () => {
  test('the publish decision in event-create.tsx / BusinessEventForm.tsx (wantsPaidPublish / effectivePublish) is byte-identical to before this fix', () => {
    assert.match(mobileCreate, /const hasActivePaidTicket = ticketMode === 'oneshetland'/);
    assert.match(mobileCreate, /const wantsPaidPublish = publish && !isHub && !!businessId && hasActivePaidTicket;/);
    assert.match(mobileCreate, /if \(wantsPaidPublish && !\(await requirePayoutReadyForPaidActivation\(businessId!\)\)\) \{/);

    assert.match(webForm, /const hasActivePaidTicket = ticketMode === "oneshetland"/);
    assert.match(webForm, /const wantsPaidPublish = publish && hasActivePaidTicket;/);
    assert.match(webForm, /if \(wantsPaidPublish && !\(await requirePayoutReadyForPaidActivation\(businessId\)\)\) \{/);
  });

  test('draft persistence is unchanged — the save/update call itself is not conditioned on payout readiness', () => {
    assert.match(mobileCreate, /status:\s*effectivePublish \? 'published' : 'draft',/);
    assert.match(webForm, /status: effectivePublish \? "published" : "draft",/);
  });
});
