/**
 * notify-fanout-authz.node.test.ts — entity-scoped authorisation for the eight
 * notify-* fan-outs docs/action-inventory.md flagged as caller-check gaps.
 *
 * WHAT THIS GUARDS
 *
 * All eight already required a signed-in caller (requireCaller). Signed in is
 * not the same as ENTITLED: booking_id, claim_id, comment_id, job_id,
 * application_id and shift_id all came straight from the request body, so any
 * signed-in account could trigger a real notification about an entity that was
 * never theirs — spoofing or spamming another member, not the open internet
 * (verify_jwt=true already keeps the anon key out).
 *
 * Three of the eight — notify-event-update, notify-claim, notify-hub-content —
 * already had an entity-scoped check inline (added in earlier hardening
 * passes; docs/action-inventory.md predates that work and is stale on them).
 * Their checks are pulled out here unchanged in substance, so they are
 * unit-tested the same way as the five that were genuinely still open:
 * notify-booking, notify-business-claim, notify-engagement, notify-job,
 * notify-shift-status.
 *
 * Each gate is exercised directly against a fake service client — no network,
 * no database — proving for every event: an unrelated signed-in user is
 * refused, the legitimate party is allowed, and the service role (our own
 * backend) is always trusted. A second section proves each index.ts actually
 * calls its gate before doing anything else.
 *
 * SAFETY: pure unit tests. No network call, no database write.
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** A fake service client: named tables of rows, plus an optional RPC stub. */
function fakeSvc(tables: Record<string, Row[]>, rpcImpl?: (name: string, args: Record<string, unknown>) => { data: unknown; error: unknown }) {
  const rpcCalls: { name: string; args: unknown }[] = [];
  return {
    rpcCalls,
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const rowsFor = () => (tables[table] ?? []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => { filters[k] = v; return q; },
        maybeSingle: async () => ({ data: rowsFor()[0] ?? null }),
        limit: async () => ({ data: rowsFor() }),
      };
      return q;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return rpcImpl ? rpcImpl(name, args) : { data: null, error: null };
    },
  };
}

const user = (id: string) => ({ userId: id, isServiceRole: false });
const service = { userId: '', isServiceRole: true };

// Every auth module imports its decision type/helpers from notify-decision.ts;
// load it once and hand it to loadModule as the stub for that import.
const Decision = loadModule('supabase/functions/_shared/notify-decision.ts');
const stubs = { './notify-decision.ts': Decision };
const loadAuth = (rel: string) => loadModule(rel, stubs);

// A stock cast of uuids, reused across sections with domain-appropriate names.
const A = '11111111-1111-4111-8111-111111111111'; // the legitimate party
const B = '22222222-2222-4222-8222-222222222222'; // an unrelated signed-in user
const ENTITY = '33333333-3333-4333-8333-333333333333';
const OTHER_ENTITY = '44444444-4444-4444-8444-444444444444';

/* ── notify-booking ───────────────────────────────────────────────────── */

// deno-lint-ignore no-explicit-any
const Booking: Record<string, any> = loadAuth('supabase/functions/_shared/booking-notify-auth.ts');

describe('notify-booking: only the customer or the business owner may raise a notice', () => {
  const svc = () => fakeSvc({
    book_bookings: [{ id: ENTITY, customer_id: A, business_id: OTHER_ENTITY }],
    local_businesses: [{ id: OTHER_ENTITY, owner_id: 'owner-uuid-0000-0000-000000000000' }],
  });
  const decide = (svc: unknown, caller: unknown, event: string, bookingId: unknown) =>
    Booking.authoriseBookingNotify(svc, caller, { event, bookingId });

  test('an unrelated signed-in user is refused for both events', async () => {
    for (const event of ['created', 'cancelled']) {
      const d = await decide(svc(), user(B), event, ENTITY);
      assert.equal(d.ok, false, event);
      assert.equal(d.status, 403);
    }
  });

  test('the customer who made the booking is allowed', async () => {
    assert.equal((await decide(svc(), user(A), 'created', ENTITY)).ok, true);
    assert.equal((await decide(svc(), user(A), 'cancelled', ENTITY)).ok, true);
  });

  test('the business owner is allowed', async () => {
    const owner = 'owner-uuid-0000-0000-000000000000';
    assert.equal((await decide(svc(), user(owner), 'created', ENTITY)).ok, true);
  });

  test('a booking that does not exist is a 404, not a silent pass', async () => {
    const d = await decide(svc(), user(A), 'created', OTHER_ENTITY);
    assert.equal(d.ok, false);
    assert.equal(d.status, 404);
  });

  test('the service role is trusted', async () => {
    assert.equal((await decide(svc(), service, 'created', ENTITY)).ok, true);
  });

  test('missing or malformed input is a 400 before any lookup', async () => {
    const s = svc();
    assert.equal((await decide(s, user(A), '', ENTITY)).status, 400);
    assert.equal((await decide(s, user(A), 'created', undefined)).status, 400);
  });
});

/* ── notify-business-claim ────────────────────────────────────────────── */

// deno-lint-ignore no-explicit-any
const BizClaim: Record<string, any> = loadAuth('supabase/functions/_shared/business-claim-notify-auth.ts');

describe('notify-business-claim: only the claimant may ask admins to be told', () => {
  const svc = () => fakeSvc({ business_claims: [{ id: ENTITY, user_id: A }] });

  test('an unrelated signed-in user is refused', async () => {
    const d = await BizClaim.authoriseBusinessClaimNotify(svc(), user(B), { claimId: ENTITY });
    assert.equal(d.ok, false);
    assert.equal(d.status, 403);
  });

  test('the claimant themselves is allowed', async () => {
    const d = await BizClaim.authoriseBusinessClaimNotify(svc(), user(A), { claimId: ENTITY });
    assert.equal(d.ok, true);
  });

  test('a claim that does not exist is a 404', async () => {
    const d = await BizClaim.authoriseBusinessClaimNotify(svc(), user(A), { claimId: OTHER_ENTITY });
    assert.equal(d.status, 404);
  });

  test('the service role is trusted; missing claim_id is a 400', async () => {
    assert.equal((await BizClaim.authoriseBusinessClaimNotify(svc(), service, { claimId: ENTITY })).ok, true);
    assert.equal((await BizClaim.authoriseBusinessClaimNotify(svc(), user(A), { claimId: undefined })).status, 400);
  });
});

/* ── notify-claim (outcome) ───────────────────────────────────────────── */

// deno-lint-ignore no-explicit-any
const ClaimOutcome: Record<string, any> = loadAuth('supabase/functions/_shared/claim-outcome-notify-auth.ts');

describe('notify-claim: only an admin may announce a claim outcome', () => {
  const svc = (role: string | null) => fakeSvc({ profiles: role ? [{ id: A, role }] : [] });

  test('an ordinary signed-in user is refused', async () => {
    const d = await ClaimOutcome.authoriseClaimOutcomeNotify(svc('member'), user(A), { claimId: ENTITY, outcome: 'approved' });
    assert.equal(d.ok, false);
    assert.equal(d.status, 403);
  });

  test('an admin is allowed, for either outcome', async () => {
    for (const outcome of ['approved', 'rejected']) {
      const d = await ClaimOutcome.authoriseClaimOutcomeNotify(svc('admin'), user(A), { claimId: ENTITY, outcome });
      assert.equal(d.ok, true, outcome);
    }
  });

  test('the service role is trusted; missing input is a 400 before any lookup', async () => {
    const s = svc('admin');
    assert.equal((await ClaimOutcome.authoriseClaimOutcomeNotify(s, service, { claimId: ENTITY, outcome: 'approved' })).ok, true);
    assert.equal((await ClaimOutcome.authoriseClaimOutcomeNotify(s, user(A), { claimId: ENTITY, outcome: undefined })).status, 400);
  });
});

/* ── notify-engagement ────────────────────────────────────────────────── */

// deno-lint-ignore no-explicit-any
const Engagement: Record<string, any> = loadAuth('supabase/functions/_shared/engagement-notify-auth.ts');

describe('notify-engagement: only the real author or the real actor may raise a notice', () => {
  test('memory_comment: only the comment\'s actual author may raise it', async () => {
    const svc = fakeSvc({ memory_comments: [{ id: ENTITY, author_id: A }] });
    assert.equal((await Engagement.authoriseEngagementNotify(svc, user(B), { event: 'memory_comment', commentId: ENTITY })).status, 403);
    assert.equal((await Engagement.authoriseEngagementNotify(svc, user(A), { event: 'memory_comment', commentId: ENTITY })).ok, true);
  });

  test('vessel_comment: same rule, different table', async () => {
    const svc = fakeSvc({ vessel_comments: [{ id: ENTITY, author_id: A }] });
    assert.equal((await Engagement.authoriseEngagementNotify(svc, user(B), { event: 'vessel_comment', commentId: ENTITY })).status, 403);
    assert.equal((await Engagement.authoriseEngagementNotify(svc, user(A), { event: 'vessel_comment', commentId: ENTITY })).ok, true);
  });

  test('a comment that does not exist is a 404', async () => {
    const svc = fakeSvc({ memory_comments: [] });
    assert.equal((await Engagement.authoriseEngagementNotify(svc, user(A), { event: 'memory_comment', commentId: ENTITY })).status, 404);
  });

  test('memory_reaction: naming someone else as actor_id is refused, even before any lookup', async () => {
    const svc = fakeSvc({ memory_reactions: [{ memory_id: ENTITY, user_id: A }] });
    const d = await Engagement.authoriseEngagementNotify(svc, user(B), { event: 'memory_reaction', memoryId: ENTITY, actorId: A });
    assert.equal(d.ok, false);
    assert.equal(d.status, 403);
  });

  test('memory_reaction: the real actor with a genuine reaction row is allowed', async () => {
    const svc = fakeSvc({ memory_reactions: [{ memory_id: ENTITY, user_id: A }] });
    const d = await Engagement.authoriseEngagementNotify(svc, user(A), { event: 'memory_reaction', memoryId: ENTITY, actorId: A });
    assert.equal(d.ok, true);
  });

  test('memory_reaction: claiming your own id but no reaction row exists is refused', async () => {
    const svc = fakeSvc({ memory_reactions: [] });
    const d = await Engagement.authoriseEngagementNotify(svc, user(A), { event: 'memory_reaction', memoryId: ENTITY, actorId: A });
    assert.equal(d.ok, false);
    assert.equal(d.status, 403);
  });

  test('the service role is trusted for every event; an unrecognised event passes through', async () => {
    const svc = fakeSvc({});
    assert.equal((await Engagement.authoriseEngagementNotify(svc, service, { event: 'memory_comment', commentId: ENTITY })).ok, true);
    assert.equal((await Engagement.authoriseEngagementNotify(svc, user(B), { event: 'nonsense' })).ok, true, 'left to the handler\'s own "unknown event" 400');
  });
});

/* ── notify-event-update ──────────────────────────────────────────────── */

// deno-lint-ignore no-explicit-any
const EventUpdate: Record<string, any> = loadAuth('supabase/functions/_shared/event-update-notify-auth.ts');

describe('notify-event-update: only the organiser (or the org that organises) may email ticket holders', () => {
  const UPDATE = ENTITY;
  const EVENT_ID = OTHER_ENTITY;
  const BIZ = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const HUB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  test('an unrelated signed-in user is refused', async () => {
    const svc = fakeSvc({
      event_updates: [{ id: UPDATE, event_id: EVENT_ID }],
      events: [{ id: EVENT_ID, organiser_user_id: A, organiser_business_id: null, organiser_hub_id: null }],
      profiles: [{ id: B, role: 'member' }],
    });
    const d = await EventUpdate.authoriseEventUpdateNotify(svc, user(B), { updateId: UPDATE });
    assert.equal(d.ok, false);
    assert.equal(d.status, 403);
  });

  test('the organiser themselves is allowed', async () => {
    const svc = fakeSvc({
      event_updates: [{ id: UPDATE, event_id: EVENT_ID }],
      events: [{ id: EVENT_ID, organiser_user_id: A, organiser_business_id: null, organiser_hub_id: null }],
    });
    assert.equal((await EventUpdate.authoriseEventUpdateNotify(svc, user(A), { updateId: UPDATE })).ok, true);
  });

  test('the organising business\'s owner is allowed', async () => {
    const svc = fakeSvc({
      event_updates: [{ id: UPDATE, event_id: EVENT_ID }],
      events: [{ id: EVENT_ID, organiser_user_id: null, organiser_business_id: BIZ, organiser_hub_id: null }],
      local_businesses: [{ id: BIZ, owner_id: A }],
    });
    assert.equal((await EventUpdate.authoriseEventUpdateNotify(svc, user(A), { updateId: UPDATE })).ok, true);
  });

  test('the organising hub\'s owner is allowed', async () => {
    const svc = fakeSvc({
      event_updates: [{ id: UPDATE, event_id: EVENT_ID }],
      events: [{ id: EVENT_ID, organiser_user_id: null, organiser_business_id: null, organiser_hub_id: HUB }],
      hubs: [{ id: HUB, owner_id: A }],
    });
    assert.equal((await EventUpdate.authoriseEventUpdateNotify(svc, user(A), { updateId: UPDATE })).ok, true);
  });

  test('a global admin is allowed even with no organiser link', async () => {
    const svc = fakeSvc({
      event_updates: [{ id: UPDATE, event_id: EVENT_ID }],
      events: [{ id: EVENT_ID, organiser_user_id: null, organiser_business_id: null, organiser_hub_id: null }],
      profiles: [{ id: A, role: 'admin' }],
    });
    assert.equal((await EventUpdate.authoriseEventUpdateNotify(svc, user(A), { updateId: UPDATE })).ok, true);
  });

  test('an update that does not exist is a 404; the service role is trusted', async () => {
    const svc = fakeSvc({ event_updates: [] });
    assert.equal((await EventUpdate.authoriseEventUpdateNotify(svc, user(A), { updateId: UPDATE })).status, 404);
    assert.equal((await EventUpdate.authoriseEventUpdateNotify(svc, service, { updateId: UPDATE })).ok, true);
  });
});

/* ── notify-hub-content ───────────────────────────────────────────────── */

// deno-lint-ignore no-explicit-any
const HubContent: Record<string, any> = loadAuth('supabase/functions/_shared/hub-content-notify-auth.ts');

describe('notify-hub-content: only the hub\'s owner or admin may push to its whole membership', () => {
  const HUB = ENTITY;

  test('an unrelated signed-in user is refused', async () => {
    const svc = fakeSvc(
      { hubs: [{ id: HUB, owner_id: A }], profiles: [{ id: B, role: 'member' }] },
      (name) => (name === 'is_hub_admin' ? { data: false, error: null } : { data: null, error: null }),
    );
    const d = await HubContent.authoriseHubContentNotify(svc, user(B), { event: 'notice', hubId: HUB });
    assert.equal(d.ok, false);
    assert.equal(d.status, 403);
  });

  test('the hub owner is allowed', async () => {
    const svc = fakeSvc({ hubs: [{ id: HUB, owner_id: A }] });
    assert.equal((await HubContent.authoriseHubContentNotify(svc, user(A), { event: 'event', hubId: HUB })).ok, true);
  });

  test('a hub admin (not the owner) is allowed', async () => {
    const svc = fakeSvc(
      { hubs: [{ id: HUB, owner_id: 'someone-else-0000-0000-000000000000' }] },
      (name, args) => (name === 'is_hub_admin' && args.p_hub === HUB && args.p_user === A ? { data: true, error: null } : { data: false, error: null }),
    );
    assert.equal((await HubContent.authoriseHubContentNotify(svc, user(A), { event: 'notice', hubId: HUB })).ok, true);
  });

  test('a global admin is allowed even with no hub link', async () => {
    const svc = fakeSvc(
      { hubs: [{ id: HUB, owner_id: 'someone-else-0000-0000-000000000000' }], profiles: [{ id: A, role: 'admin' }] },
      () => ({ data: false, error: null }),
    );
    assert.equal((await HubContent.authoriseHubContentNotify(svc, user(A), { event: 'notice', hubId: HUB })).ok, true);
  });

  test('an admin of a DIFFERENT hub cannot push to this one', async () => {
    const svc = fakeSvc(
      { hubs: [{ id: HUB, owner_id: 'someone-else-0000-0000-000000000000' }] },
      (name, args) => (name === 'is_hub_admin' && args.p_hub === HUB ? { data: false, error: null } : { data: true, error: null }),
    );
    assert.equal((await HubContent.authoriseHubContentNotify(svc, user(A), { event: 'notice', hubId: HUB })).ok, false);
  });

  test('the service role is trusted; missing input is a 400', async () => {
    const svc = fakeSvc({});
    assert.equal((await HubContent.authoriseHubContentNotify(svc, service, { event: 'notice', hubId: HUB })).ok, true);
    assert.equal((await HubContent.authoriseHubContentNotify(svc, user(A), { event: '', hubId: HUB })).status, 400);
  });
});

/* ── notify-job ────────────────────────────────────────────────────────── */

// deno-lint-ignore no-explicit-any
const Job: Record<string, any> = loadAuth('supabase/functions/_shared/job-notify-auth.ts');

describe('notify-job: the applicant owns their application; the employer owns the job', () => {
  const JOB = ENTITY;
  const APP = OTHER_ENTITY;

  test('application / withdrawn: an unrelated user is refused, the applicant is allowed', async () => {
    const svc = fakeSvc({ job_applications: [{ id: APP, applicant_id: A, job_id: JOB }] });
    for (const event of ['application', 'withdrawn']) {
      assert.equal((await Job.authoriseJobNotify(svc, user(B), { event, applicationId: APP })).status, 403, event);
      assert.equal((await Job.authoriseJobNotify(svc, user(A), { event, applicationId: APP })).ok, true, event);
    }
  });

  test('status: only the employer may move an applicant\'s stage', async () => {
    const svc = fakeSvc({
      job_applications: [{ id: APP, applicant_id: A, job_id: JOB }],
      jobs: [{ id: JOB, employer_id: 'employer-0000-0000-0000-000000000000' }],
    });
    // Neither the applicant nor an unrelated user is the employer.
    assert.equal((await Job.authoriseJobNotify(svc, user(A), { event: 'status', applicationId: APP })).status, 403);
    assert.equal((await Job.authoriseJobNotify(svc, user(B), { event: 'status', applicationId: APP })).status, 403);
    assert.equal((await Job.authoriseJobNotify(svc, user('employer-0000-0000-0000-000000000000'), { event: 'status', applicationId: APP })).ok, true);
  });

  test('job_closed: only the employer may close their job\'s notifications', async () => {
    const svc = fakeSvc({ jobs: [{ id: JOB, employer_id: A }] });
    assert.equal((await Job.authoriseJobNotify(svc, user(B), { event: 'job_closed', jobId: JOB })).status, 403);
    assert.equal((await Job.authoriseJobNotify(svc, user(A), { event: 'job_closed', jobId: JOB })).ok, true);
  });

  test('a missing application or job is a 404; the service role is trusted', async () => {
    const svc = fakeSvc({});
    assert.equal((await Job.authoriseJobNotify(svc, user(A), { event: 'application', applicationId: APP })).status, 404);
    assert.equal((await Job.authoriseJobNotify(svc, user(A), { event: 'job_closed', jobId: JOB })).status, 404);
    assert.equal((await Job.authoriseJobNotify(svc, service, { event: 'status', applicationId: APP })).ok, true);
  });
});

/* ── notify-shift-status ──────────────────────────────────────────────── */

// deno-lint-ignore no-explicit-any
const ShiftStatus: Record<string, any> = loadAuth('supabase/functions/_shared/shift-status-notify-auth.ts');

describe('notify-shift-status: only the employer cancels; only the withdrawing worker withdraws', () => {
  const SHIFT = ENTITY;
  const APP = OTHER_ENTITY;

  test('cancelled: an unrelated user is refused, the shift\'s employer is allowed', async () => {
    const svc = fakeSvc({ shifts: [{ id: SHIFT, employer_id: A }] });
    assert.equal((await ShiftStatus.authoriseShiftStatusNotify(svc, user(B), { event: 'cancelled', shiftId: SHIFT })).status, 403);
    assert.equal((await ShiftStatus.authoriseShiftStatusNotify(svc, user(A), { event: 'cancelled', shiftId: SHIFT })).ok, true);
  });

  test('withdrawn: only the worker who is actually withdrawing may raise it', async () => {
    const svc = fakeSvc({ shift_applications: [{ id: APP, worker_id: A }] });
    assert.equal((await ShiftStatus.authoriseShiftStatusNotify(svc, user(B), { event: 'withdrawn', applicationId: APP })).status, 403);
    assert.equal((await ShiftStatus.authoriseShiftStatusNotify(svc, user(A), { event: 'withdrawn', applicationId: APP })).ok, true);
  });

  test('a missing shift or application is a 404; the service role is trusted', async () => {
    const svc = fakeSvc({});
    assert.equal((await ShiftStatus.authoriseShiftStatusNotify(svc, user(A), { event: 'cancelled', shiftId: SHIFT })).status, 404);
    assert.equal((await ShiftStatus.authoriseShiftStatusNotify(svc, user(A), { event: 'withdrawn', applicationId: APP })).status, 404);
    assert.equal((await ShiftStatus.authoriseShiftStatusNotify(svc, service, { event: 'cancelled', shiftId: SHIFT })).ok, true);
  });
});

/* ── every fan-out applies its gate before it does anything ──────────── */

describe('each fan-out calls its gate before any lookup or send', () => {
  const cases: { fn: string; gateCall: string; markers: string[] }[] = [
    { fn: 'notify-booking', gateCall: 'authoriseBookingNotify(', markers: ["from('book_bookings')", 'sendUserPush(svc'] },
    { fn: 'notify-business-claim', gateCall: 'authoriseBusinessClaimNotify(', markers: ["from('business_claims')", 'sendPush('] },
    { fn: 'notify-claim', gateCall: 'authoriseClaimOutcomeNotify(', markers: ["from('business_claims')", 'sendUserPush(svc'] },
    { fn: 'notify-engagement', gateCall: 'authoriseEngagementNotify(', markers: ["from('memory_comments')", "from('vessel_comments')", 'sendUserPush(svc', 'sendUserPushBulk(svc'] },
    { fn: 'notify-event-update', gateCall: 'authoriseEventUpdateNotify(', markers: ["from('event_updates')", "from('events')", 'sendUserPushBulk(svc', 'sendEmail('] },
    { fn: 'notify-hub-content', gateCall: 'authoriseHubContentNotify(', markers: ["from('hubs')", "from('hub_members')", 'sendUserPushBulk(svc'] },
    { fn: 'notify-job', gateCall: 'authoriseJobNotify(', markers: ['jobContext(svc, job_id)', "from('job_applications')", 'sendUserPush(svc', 'sendUserPushBulk(svc'] },
    { fn: 'notify-shift-status', gateCall: 'authoriseShiftStatusNotify(', markers: ["from('shifts')", "from('shift_applications')", 'sendUserPush(svc', 'sendUserPushBulk(svc'] },
  ];

  for (const { fn, gateCall, markers } of cases) {
    test(`${fn}: the gate runs before any lookup or send`, () => {
      const src = read(`supabase/functions/${fn}/index.ts`);
      const gateAt = src.indexOf(gateCall);
      assert.ok(gateAt > 0, `${fn}: does not call its gate (${gateCall})`);
      for (const marker of markers) {
        const at = src.indexOf(marker);
        assert.ok(at > gateAt, `${fn}: "${marker}" must come AFTER the gate`);
      }
    });

    test(`${fn}: a denial returns before anything else runs`, () => {
      const src = read(`supabase/functions/${fn}/index.ts`);
      assert.match(src, /if \(!decision\.ok\) return json\(\{ error: decision\.error \}, decision\.status\)/,
        `${fn}: does not act on its gate's refusal the standard way`);
    });

    test(`${fn}: still requires a real caller and is still rate limited`, () => {
      const src = read(`supabase/functions/${fn}/index.ts`);
      assert.match(src, /requireCaller\(req, corsHeaders\)/, `${fn}: no requireCaller`);
      assert.match(src, new RegExp(`enforceRateLimit\\('${fn}'`), `${fn}: no rate limit`);
    });
  }
});
