/**
 * fetch-v2-scenarios.node.test.ts — Fetch v2 Step 13: the product's acceptance scenarios A–J, end to end, against the whole backend.
 *
 * Every migration (Steps 0–11) replayed into a throwaway database; the REAL edge-function handlers for payments, photos and
 * notifications run with in-memory Stripe, storage and push (_support/fetch-v2-world.ts). Each step asserts the SERVER's state —
 * the row, the event trail, the hold at the fake Stripe, the notification outbox — never what a client believes.
 *
 * These are the same ten scenarios the website and the app preview (Steps 11–12) and the Step 14 real-device acceptance use:
 *   A sofa Yell ← Lerwick   B journey match   C parcel to Unst   D bank check (3DS)   E cancel before collection
 *   F waiting   G cannot deliver → return   H safe place with photo   I verification lapses before collection   J claim race
 *
 * SAFETY — ISOLATED DATABASE ONLY (PASS_PROOF_DSN). Fake users, fake Stripe, fake storage, fake push. No network.
 * Run: ISOLATED_ONLY=fetch-v2-scenarios npm run test:isolated
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { handleAccept, handleRequesterPayment, handleDriverAction, handleAdmin } from '../functions/_shared/fetch-v2-payments.ts';
import { handlePhotos, handleSupportAdmin } from '../functions/_shared/fetch-v2-photos.ts';
import { drainNotifications } from '../functions/_shared/fetch-v2-notify.ts';
import { createFetchWorld, ids, JPEG, ok, type Id, type World } from './_support/fetch-v2-world.ts';

let w: World;
before(() => { w = createFetchWorld('fetchv2aj'); });
after(() => { w?.drop(); });

type J = Record<string, unknown>;
const row = (id: string, cols: string) => w.scalar(`select ${cols} from public.delivery_requests where id = '${id}'`);
const events = (id: string) => w.scalar(`select string_agg(event, ',' order by id) from public.fetch_request_events where request_id = '${id}'`);
const outbox = (id: string): { kind: string; recipient_id: string; audience: string; data: J }[] =>
  JSON.parse(w.scalar(`select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'recipient_id', recipient_id, 'audience', audience, 'data', data) order by id), '[]') from public.fetch_notifications where request_id = '${id}'`));
const accept = (d: Id, id: string) => handleAccept(ids[d], { request_id: id, vehicle_confirmed: true }, w.payDeps());
const driverAct = (d: Id, id: string, action: string, extra: J = {}) => handleDriverAction(ids[d], { request_id: id, action, ...extra }, w.payDeps());
const pay = (who: Id, id: string, action: string) => handleRequesterPayment(ids[who], { request_id: id, action }, w.payDeps());
const admin = (id: string, action: string, extra: J = {}) => handleAdmin(ids.ADMIN, { request_id: id, action, ...extra }, w.payDeps());
const collect = (d: Id, id: string) => w.call<J>(d, `public.fetch_v2_mark_collected('${id}')`);
async function upload(who: Id, id: string, kind: string, o: { board?: boolean; issue?: string } = {}) {
  const b = await handlePhotos(ids[who], { action: 'begin_upload', request_id: id, kind, mime_type: 'image/jpeg', size_bytes: JPEG.length, show_on_board: o.board, issue_id: o.issue }, w.photoDeps());
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(w.storage.clientUpload(String(b.body.upload_token), JPEG), 'ok');
  const s = await handlePhotos(ids[who], { action: 'submit', upload_id: b.body.upload_id }, w.photoDeps());
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return String(s.body.photo_id);
}
const board = (d: Id, all = false): J[] => JSON.parse(w.scalar(`begin; set local request.jwt.claim.sub = '${ids[d]}'; set local role authenticated; select coalesce(jsonb_agg(b), '[]'::jsonb) from public.fetch_v2_board(${all}) b; commit;`) || '[]');
const terms = (id: string, col: string) => Number(w.scalar(`select ${col} from public.fetch_v2_terms where request_id = '${id}'`));

describe('A · requester in Yell needs a sofa collected in Lerwick', () => {
  let id = '';
  test('posting prices it on the server: bulky minimum rules, one flat ferry extra, frozen terms; nothing client-supplied', () => {
    id = w.job('REQ', 'lerwick', 'midyell', { category_slug: 'furniture', item_description: 'Two-seater sofa (grey)', size_class: 'bulky',
      approx_dimensions_cm: { l: 180, w: 85, h: 80 }, handling_flags: ['heavy_two_person'], base_fee_pence: 1, total_fee_pence: 1 });
    assert.equal(row(id, `status || ':' || ferry_required || ':' || ferry_supplement_pence`), 'pending:true:200');
    assert.ok(terms(id, 'delivery_fee_pence') >= 800, 'bulky never below the £8 minimum');
    assert.ok(Number(row(id, 'total_fee_pence')) > 1, 'client price ignored');
    assert.ok(terms(id, 'max_hold_pence') > terms(id, 'total_pence'), 'the hold covers waiting and a return, above the expected total');
  });
  test('a bulky job cannot be accepted until the requester adds an item photo; with one shown to drivers, it can', async () => {
    assert.equal((await accept('D_VAN', id)).body.code, 'item_photo_required');
    const photo = await upload('REQ', id, 'item', { board: true });
    assert.equal(w.scalar(`select matching_visible from public.fetch_request_photos where id = '${photo}'`), 't');
    const item = board('D_VAN', true).find((b) => b.request_id === id)!;
    assert.deepEqual(item.matching_photo_ids, [photo]);
    assert.ok(!JSON.stringify(item).match(/Example Quay|Example Cottage|07000|Harbour Furniture|Morag/), 'board: area only, no identity, address or phone');
  });
});

describe('B · a driver already travelling Lerwick → Yell sees it as a journey match', () => {
  test('the run makes the job "your_run" on the board and the outbox offers it as a journey match', () => {
    w.run('D_VAN', 'lerwick', 'midyell');
    const id = w.job('REQ', 'lerwick', 'midyell', { size_class: 'medium', item_description: 'Two boxes' });
    const mine = board('D_VAN').find((b) => b.request_id === id);
    assert.equal(mine?.match, 'your_run', JSON.stringify(mine));
    assert.ok(mine?.fits_run_id, 'the run it fits is named');
    const offers = outbox(id).filter((n) => n.audience === 'opportunity');
    assert.ok(offers.some((n) => n.recipient_id === ids.D_VAN && /run/.test(n.kind)), JSON.stringify(offers));
    assert.ok(!offers.some((n) => n.recipient_id === ids.REQ), 'never offered to the requester');
  });
});

describe('C · a small parcel to Unst', () => {
  test('the minimum driver payment applies and one ferry extra covers both crossings', () => {
    const id = w.job('REQ_UNST', 'midyell', 'baltasound', { item_description: 'Small parcel' });
    assert.equal(row(id, `ferry_required || ':' || ferry_supplement_pence`), 'true:200');
    assert.ok(terms(id, 'delivery_fee_pence') >= 400);
    assert.equal(terms(id, 'service_fee_pence'), 150);
  });
});

describe('D · the card hold needs the requester\'s bank check (3DS)', () => {
  test('accept keeps the job but blocks collection; the requester is told; after the check the driver can collect', async () => {
    w.stripe.behaviour = { cus_REQ_SCA: 'sca' };
    const id = w.job('REQ_SCA', 'lerwick', 'scalloway');
    const r = await accept('D_CAR', id);
    assert.equal(`${r.body.payment}:${r.body.can_collect}`, 'requester_action_required:false');
    assert.equal(row(id, `status || ':' || payment_status`), 'matched:requires_action');
    assert.equal(collect('D_CAR', id).code, 'payment_not_ready');
    const notice = outbox(id).find((n) => n.recipient_id === ids.REQ_SCA && String(n.data?.route ?? '').endsWith('/payment'));
    assert.ok(notice, `the requester gets a payment notice: ${JSON.stringify(outbox(id))}`);
    const c = await pay('REQ_SCA', id, 'complete');
    assert.equal(typeof c.body.client_secret, 'string');
    w.stripe.complete(w.stripe.allFor(id)[0].id);
    assert.equal((await pay('REQ_SCA', id, 'refresh')).body.payment, 'authorised');
    assert.equal(collect('D_CAR', id).status, 'collected');
  });
});

describe('E · the requester asks to cancel before collection', () => {
  test('a request, not a cancellation: collection is blocked; the driver agrees; cancelled and the hold voided', async () => {
    const id = w.job('REQ', 'lerwick', 'scalloway');
    assert.equal((await accept('D_CAR', id)).body.payment, 'authorised');
    assert.equal(w.call<J>('REQ', `public.fetch_v2_request_cancellation('${id}', 'Bought one locally')`).ok, true);
    assert.equal(row(id, 'status'), 'matched');
    assert.equal(collect('D_CAR', id).code, 'cancellation_pending');
    const r = await driverAct('D_CAR', id, 'agree_cancellation');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(row(id, 'status'), 'cancelled');
    assert.equal(w.stripe.allFor(id)[0].status, 'canceled');
    assert.equal(w.stripe.captures(id).length, 0, 'nothing taken');
  });
});

describe('F · the driver arrives and has to wait', () => {
  test('arrival starts the server\'s clock; the fee is measured at collection, not entered by anyone', async () => {
    const id = w.job('REQ', 'lerwick', 'scalloway');
    await accept('D_CAR', id);
    w.call('REQ', `public.fetch_v2_confirm_ready('${id}')`);
    w.call('D_CAR', `public.fetch_v2_mark_arrived('${id}')`);
    ok(w.db.raw(`update public.waiting_events set arrived_at = now() - interval '12 minutes' where request_id = '${id}'`));
    assert.match(w.asClient('D_CAR', `update public.delivery_requests set waiting_fee_pence = 600 where id = '${id}'`), /ERROR|UPDATE 0/);
    const c = collect('D_CAR', id);
    assert.equal(`${c.status}:${c.waiting_fee_pence}`, 'collected:150');
    assert.match(events(id), /arrived.*collected/);
  });
});

describe('G · the driver cannot deliver after collection', () => {
  test('structured reason → undeliverable with an issue; return photo; return reported; an administrator resolves the money', async () => {
    const id = w.job('REQ', 'lerwick', 'scalloway');
    await accept('D_CAR', id); collect('D_CAR', id);
    assert.equal(w.call<J>('D_CAR', `public.fetch_v2_mark_undeliverable('${id}', 'recipient_absent')`).ok, true);
    assert.equal(row(id, 'status'), 'undeliverable');
    assert.ok(Number(w.scalar(`select count(*) from public.fetch_issues where request_id = '${id}'`)) >= 1, 'an issue is opened for the return');
    assert.equal(w.call<J>('D_CAR', `public.fetch_v2_report_return('${id}', 'Back at the shop')`).code, 'return_photo_required');
    await upload('D_CAR', id, 'return');
    assert.equal(w.call<J>('D_CAR', `public.fetch_v2_report_return('${id}', 'Back at the shop')`).ok, true);
    const r = await admin(id, 'resolve_return', { outcome: 'returned_to_sender', fault: 'not_driver' });
    assert.equal(r.body.payment, 'captured', JSON.stringify(r.body));
    assert.equal(row(id, 'status'), 'returned');
    assert.equal(w.stripe.captures(id).length, 1);
  });
});

describe('H · safe-place delivery with a photo', () => {
  test('refused without a delivery photo (nothing captured); accepted with one; captured exactly once; a repeat is safe', async () => {
    const id = w.job('REQ', 'lerwick', 'scalloway', { safe_place_allowed: true, safe_place_note: 'In the porch' });
    await accept('D_CAR', id); collect('D_CAR', id);
    const no = await driverAct('D_CAR', id, 'deliver', { left_in_safe_place: true });
    assert.equal(no.body.code, 'delivery_photo_required');
    assert.equal(w.stripe.captures(id).length, 0);
    await upload('D_CAR', id, 'delivery');
    const yes = await driverAct('D_CAR', id, 'deliver', { left_in_safe_place: true });
    assert.equal(yes.body.status, 'delivered', JSON.stringify(yes.body));
    assert.equal((await driverAct('D_CAR', id, 'deliver', { left_in_safe_place: true })).body.already, true);
    assert.equal(w.stripe.captures(id).length, 1, 'one capture');
    assert.equal(w.stripe.allFor(id)[0].amount_received, terms(id, 'total_pence'), 'only the expected total is taken; the rest of the hold is released');
  });
});

describe('I · verification expires before collection', () => {
  test('the job stays the driver\'s but collection is refused with the reason; never silently collected; renewal unblocks it', async () => {
    const id = w.job('REQ', 'lerwick', 'scalloway');
    assert.equal((await accept('D_EXP', id)).body.payment, 'authorised');
    ok(w.db.raw(`update public.driver_verification_items set expires_at = now() - interval '1 hour' where driver_id = '${ids.D_EXP}' and kind = 'insurance'`));
    const r = collect('D_EXP', id);
    assert.equal(r.code ?? r.reason, 'driver_verification_expired', JSON.stringify(r));
    assert.equal(row(id, `status || ':' || (collected_at is null)`), 'matched:true');
    assert.equal(w.call<J>('D_EXP', `public.fetch_v2_my_eligibility()`).driver_problem, 'driver_verification_expired');
    ok(w.db.raw(`update public.driver_verification_items set expires_at = now() + interval '200 days' where driver_id = '${ids.D_EXP}' and kind = 'insurance'`));
    assert.equal(collect('D_EXP', id).status, 'collected');
  });
});

describe('J · another driver takes the job just before this one presses Accept', () => {
  test('two simultaneous accepts: exactly one wins, the other is told already_taken, and only one hold exists', async () => {
    const id = w.job('REQ', 'lerwick', 'scalloway');
    const [a, b] = await Promise.all([accept('D_CAR', id), accept('D_B', id)]);
    const codes = [a, b].map((x) => (x.status === 200 ? 'won' : x.body.code)).sort();
    assert.deepEqual(codes, ['already_taken', 'won']);
    assert.equal(w.stripe.allFor(id).length, 1);
    const winner = a.status === 200 ? ids.D_CAR : ids.D_B;
    assert.equal(row(id, 'driver_id'), winner);
  });
});

describe('along the way · messages, issues, photos and the notification outbox', () => {
  test('messages between requester and current driver only; an issue with a photo; the outbox drains to push and the inbox', async () => {
    const id = w.job('REQ', 'lerwick', 'scalloway');
    await accept('D_CAR', id);
    assert.equal(w.call<J>('REQ', `public.fetch_v2_send_message('${id}', 'It is the grey one', '${crypto.randomUUID()}')`).ok, true);
    assert.equal(w.call<J>('D_CAR', `public.fetch_v2_send_message('${id}', 'Thanks — there at 2', '${crypto.randomUUID()}')`).ok, true);
    assert.match(w.asClient('MEMBER', `select public.fetch_v2_messages('${id}')`), /not found|ERROR/i, 'an outsider sees nothing');
    const issue = w.call<J>('REQ', `public.fetch_v2_report_issue('${id}', 'damaged', 'Corner scuffed', '${crypto.randomUUID()}')`);
    assert.equal(issue.ok, true, JSON.stringify(issue));
    await upload('REQ', id, 'issue', { issue: String(issue.issue_id) });
    assert.equal(w.scalar(`select count(*) from public.fetch_request_photos where request_id = '${id}' and kind = 'issue'`), '1');
    const stored = [...w.storage.objects.values()].pop()!;
    assert.ok(!Buffer.from(stored).toString('latin1').includes('GPS'), 'photo metadata stripped before registration');
    const before = w.push.sent.length;
    await drainNotifications({ rpc: w.rpc, push: w.push });
    assert.ok(w.push.sent.length > before, 'notices were pushed');
    assert.ok(w.push.sent.every((p) => !/07000|Example Quay|Example Cottage/.test(JSON.stringify(p.m))), 'no contact details in pushes');
    const support = await handleSupportAdmin(ids.ADMIN, { area: 'support', action: 'resolve_issue', issue_id: issue.issue_id, resolution: 'Refund agreed', reason: 'Photo shows damage' }, w.photoDeps());
    assert.equal(support.status, 200, JSON.stringify(support.body));
  });
});
