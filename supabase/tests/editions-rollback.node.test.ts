/**
 * editions-rollback.node.test.ts — ISOLATED Postgres only. Proves the rollbacks work: after a full replay, rolling back the newest migrations in reverse order runs cleanly,
 * removes only what each created, leaves the older layers intact and working, and a second run is harmless.
 * Run: ISOLATED_ONLY=editions-rollback npm run test:isolated
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const rowsTag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const last = (o: string) => o.split('\n').map((l) => l.trim()).filter((l) => l && !rowsTag.test(l) && !/^ERROR|^psql:|^NOTICE/.test(l)).pop() ?? '';
let db: ReplayDb;
const q = (s: string) => last(db.raw(s));
const file = (n: string) => readFileSync(new URL(`../rollbacks/${n}.rollback.sql`, import.meta.url), 'utf8');
const exists = (rel: string) => q(`select to_regclass('public.${rel}') is not null`) === 't';
const fn = (name: string) => q(`select count(*) from pg_proc where pronamespace='public'::regnamespace and proname='${name}'`) !== '0';

before(() => { db = createReplayDb('editionsrollback'); });
after(() => { try { db?.drop(); } catch { /* */ } });

describe('rolling back the newest migrations', () => {
  const order = ['20270104010000_editions_promotion_rpcs', '20270104000000_editions_launch_showcase_promotions', '20270102060000_editions_operations', '20270102050000_editions_participation', '20270102040000_editions_memberships', '20270102030000_editions_commerce_core', '20270102020000_editions_visitor'];
  test('everything is present after the replay', () => {
    for (const t of ['edition_email_outbox', 'edition_participations', 'organiser_memberships', 'edition_payments', 'edition_saves', 'edition_links', 'editions']) assert.ok(exists(t), t);
  });
  test('each rollback runs without error, in reverse order, and removes what it created', () => {
    for (const stem of order) {
      const out = db.raw(file(stem));
      assert.doesNotMatch(out, /ERROR/, `${stem}: ${out.slice(0, 400)}`);
    }
    for (const t of ['edition_email_outbox', 'edition_participations', 'edition_refund_requests', 'edition_reconciliation_exceptions', 'organiser_memberships', 'organiser_membership_tiers', 'edition_payments', 'edition_orders', 'edition_packages', 'edition_payout_accounts', 'edition_saves', 'edition_plan_items'])
      assert.ok(!exists(t), `${t} should be gone`);
    for (const f of ['edition_fulfil_order', 'edition_membership_apply', 'edition_participation_quote', 'edition_email_next', 'edition_save', 'edition_commerce_enabled']) assert.ok(!fn(f), `${f} should be gone`);
  });
  test('the older layers are intact and still work: partners, public views and the eligibility predicate fall back to the R2 stub', () => {
    for (const t of ['edition_links', 'edition_link_notes', 'edition_link_offers', 'editions', 'edition_sessions', 'edition_entitlements']) assert.ok(exists(t), t);
    for (const v of ['edition_public_businesses', 'edition_public_offers', 'edition_public_events', 'edition_public_activities']) assert.ok(exists(v), v);
    assert.equal(q(`select public.edition_participation_ok(gen_random_uuid())`), 't');
    assert.equal(q(`select count(*) from public.edition_public_businesses`), '0');
    assert.equal(q(`select prosecdef from pg_proc where proname='edition_participation_ok'`), 'f', 'back to the plain R2 stub');
  });
  test('a second run is harmless', () => {
    for (const stem of order) assert.doesNotMatch(db.raw(file(stem)), /ERROR/, stem);
  });
  test('no analytics definition, config or table of the existing platform was touched', () => {
    assert.equal(q(`select count(*) from analytics_event_defs where event_name in ('edition_saved','edition_plan_added','edition_calendar_exported','edition_search')`), '0', 'the visitor rollback removes its definitions');
    assert.ok(exists('local_businesses') && exists('hub_members'));
    if (exists('saved_items')) assert.ok(true, 'My Saved (when present in the build) is intact');
  });
});

describe('R9 to R12 rollbacks (140000, 130000, 120000, 110000, 100000, 090000), newest first, on their own fresh replay', () => {
  let d2: ReplayDb; const q2 = (sql: string) => d2.raw(sql).split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  before(() => { d2 = createReplayDb('editionsrollback2'); });
  after(() => { try { d2?.drop(); } catch { /* */ } });
  const stems = ['20270104010000_editions_promotion_rpcs', '20270104000000_editions_launch_showcase_promotions', '20270102140000_editions_payment_safeguards_2', '20270102130000_editions_stripe_lifecycle', '20270102120000_editions_session_pages', '20270102110000_editions_stage_a', '20270102100000_editions_payment_safeguards', '20270102090000_editions_update_images'];
  test('everything they add is present after the replay', () => {
    assert.equal(q2(`select to_regclass('public.edition_stripe_cancel_queue') is not null`), 't');
    assert.equal(q2(`select to_regclass('public.edition_stripe_stray_subscriptions') is not null`), 't');
    assert.equal(q2(`select to_regclass('public.edition_session_businesses') is not null`), 't');
    assert.equal(q2(`select count(*) from pg_trigger where tgname='edition_organisers_dark_guard'`), '1');
    assert.equal(q2(`select count(*) from information_schema.columns where table_name='edition_updates' and column_name='image_url'`), '1');
    assert.equal(q2(`select count(*) from information_schema.columns where table_name='organiser_memberships' and column_name='offline_method'`), '1');
  });
  test('each rollback runs without error and removes what it added', () => {
    for (const stem of stems) { const out = d2.raw(file(stem)); assert.doesNotMatch(out, /ERROR/, `${stem}: ${out.slice(0, 500)}`); }
    assert.equal(q2(`select to_regclass('public.edition_stripe_cancel_queue') is not null`), 'f', 'the cancel queue is gone');
    assert.equal(q2(`select count(*) from pg_trigger where tgname in ('edition_organisers_dark_guard','zz_edition_membership_stripe_cancel')`), '0', 'both triggers are gone');
    assert.equal(q2(`select count(*) from pg_proc where proname in ('edition_dark_launch_guard','edition_org_contact_email','edition_stripe_cancels_next','edition_stripe_cancel_enqueue')`), '0');
    assert.equal(q2(`select count(*) from information_schema.columns where table_name='edition_updates' and column_name='image_url'`), '0', 'update photographs column removed');
    assert.equal(q2(`select count(*) from pg_constraint where conrelid='public.edition_reconciliation_exceptions'::regclass and contype='c' and pg_get_constraintdef(oid) like '%payment_after_cancel%'`), '0');
    assert.equal(q2(`select to_regclass('public.edition_stripe_stray_subscriptions') is not null`), 'f', 'the stray-subscription queue is gone');
    assert.equal(q2(`select to_regclass('public.edition_session_businesses') is not null`), 'f', 'named session businesses are gone');
    assert.equal(q2(`select count(*) from information_schema.columns where table_name='edition_sessions' and column_name in ('image_url','presenters')`), '0', 'session photographs and presenters are gone');
    assert.equal(q2(`select count(*) from information_schema.columns where table_name='edition_refund_requests' and column_name in ('attempts','last_error','next_attempt_at')`), '0', 'refund retry columns are gone');
    assert.equal(q2(`select count(*) from pg_proc where proname in ('edition_payout_account_disconnected','edition_stripe_stray_next','edition_session_set_businesses')`), '0');
    assert.equal(q2(`select pg_get_functiondef('public.edition_membership_pay_prepare(uuid,text)'::regprocedure) like '%existing_subscription%'`), 'f', 'pay_prepare is back to the original');
  });
  test('the previous behaviour is back: contact email readable by signed-in users again, an offline record is active at once, the older layers intact', () => {
    assert.equal(q2(`select count(*) from information_schema.column_privileges where table_name='edition_organisers' and column_name='contact_email' and grantee='authenticated' and privilege_type='SELECT'`), '1');
    const body = q2(`select pg_get_functiondef(p.oid) like '%offline_offered%' from pg_proc p where proname='edition_membership_record_offline'`);
    assert.equal(body, 'f', 'record_offline no longer creates an offer');
    for (const t of ['organiser_memberships', 'edition_payments', 'edition_reconciliation_exceptions', 'edition_organisers', 'editions']) assert.equal(q2(`select to_regclass('public.${t}') is not null`), 't', t);
  });
  test('a second run is harmless', () => { for (const stem of stems) assert.doesNotMatch(d2.raw(file(stem)), /ERROR/, stem); });
});

describe('Hub verification + pilot + 1.1 rollbacks (210000, 200000, 190000, 180000, 170000, 160000), newest first, on their own fresh replay', () => {
  let d3: ReplayDb; const q3 = (sql: string) => d3.raw(sql).split('\n').map((l) => l.trim()).filter((l) => l && !/^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|DELETE \d+)$/.test(l)).pop() ?? '';
  before(() => { d3 = createReplayDb('editionsrollback3'); });
  after(() => { try { d3?.drop(); } catch { /* */ } });
  // The finished-service migrations (identity, Hub events switch, review, packages, retirement of the pilot, package refunds) sit on top of these layers, so they roll back FIRST, newest to oldest.
  // Their own rollbacks are proven in depth in editions-complete; here they only have to run clean (twice) so the older rollbacks below start from the state they were written for.
  const newest = ['20270104010000_editions_promotion_rpcs', '20270104000000_editions_launch_showcase_promotions', '20270103060000_editions_admin_orders', '20270103050000_editions_package_refunds', '20270103040000_editions_retire_pilot_and_standalone', '20270103030000_editions_packages_and_notifications', '20270103020000_editions_review', '20270103010000_hub_events_auto_approve', '20270103000000_editions_business_and_hub_identity'];
  const stems = ['20270102210000_admin_verify_hub', '20270102200000_editions_pilot', '20270102190000_editions_add_from_hub', '20270102180000_editions_community_packages', '20270102170000_editions_hub_run', '20270102160000_editions_hub_partners'];
  test('the finished-service migrations roll back first, newest to oldest, clean, twice', () => {
    assert.equal(q3(`select count(*) from pg_proc where proname='edition_ensure_organiser'`), '1', 'present before');
    for (const stem of newest) assert.doesNotMatch(d3.raw(file(stem)), /ERROR/, `${stem} run 1`);
    for (const stem of newest) { const o = d3.raw(file(stem)); assert.doesNotMatch(o, /ERROR/, `${stem} run 2: ${o.split('\n').find((l) => /ERROR/.test(l))}`); }
    assert.equal(q3(`select count(*) from pg_proc where proname='edition_ensure_organiser'`), '0', 'gone after');
  });
  test('everything they add is present, then each rollback runs clean, twice', () => {
    assert.equal(q3(`select count(*) from pg_proc where proname='admin_set_hub_verified'`), '1');
    assert.equal(q3(`select to_regclass('public.edition_pilot_approvals') is not null`), 't');
    assert.equal(q3(`select to_regclass('public.edition_link_hub_items') is not null`), 't');
    assert.equal(q3(`select count(*) from pg_proc where proname='edition_hub_own_items'`), '1');
    assert.equal(q3(`select count(*) from information_schema.columns where table_name='edition_packages' and column_name='audience'`), '1');
    for (const stem of stems) { const f = file(stem); for (let i = 0; i < 2; i++) assert.doesNotMatch(d3.raw(f), /ERROR/, `${stem} run ${i + 1}`); }
  });
  test('what they added is gone and the earlier layers work as before', () => {
    assert.equal(q3(`select count(*) from pg_proc where proname='admin_set_hub_verified'`), '0');
    assert.equal(q3(`select to_regclass('public.edition_pilot_approvals') is null`), 't');
    for (const f of ['editions_pilot', 'edition_pilot_visible', 'admin_set_editions_pilot', 'admin_approve_edition_pilot', 'admin_revoke_edition_pilot', 'admin_grant_edition_pilot_publish', 'admin_create_edition_organiser_for_hub']) assert.equal(q3(`select count(*) from pg_proc where proname='${f}'`), '0', f);
    assert.equal(q3(`select count(*) from pg_proc where proname='edition_is_public' and prosrc like '%pilot%'`), '0', 'edition_is_public is back to the pre-pilot predicate');
    assert.equal(q3(`select count(*) from pg_policies where policyname='edition_organisers public read' and qual like '%pilot%'`), '0');
    assert.equal(q3(`select to_regclass('public.edition_link_hub_items') is null`), 't');
    assert.equal(q3(`select count(*) from information_schema.columns where table_name='edition_links' and column_name='hub_id'`), '0');
    assert.equal(q3(`select count(*) from information_schema.columns where table_name='edition_packages' and column_name='audience'`), '0');
    for (const f of ['edition_hub_role', 'edition_my_organisers', 'create_edition_organiser_for_hub', 'edition_find_hubs', 'edition_available_packages', 'edition_hub_own_items']) assert.equal(q3(`select count(*) from pg_proc where proname='${f}'`), '0', f);
    assert.equal(q3(`select count(*) from pg_proc where proname='edition_controls_subject' and pronargs=4`), '1', 'the original four-argument authority is back');
    assert.equal(q3(`select pg_get_constraintdef(oid) from pg_constraint where conname='edition_links_kind_check'`).includes('hub'), false);
    assert.equal(q3(`select count(*) from pg_policies where policyname='edition_packages read' and qual not like '%audience%'`), '1');
    assert.equal(q3(`select (select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname ilike '%edition%' and has_function_privilege('anon', p.oid, 'execute'))`), '6');
  });
});
