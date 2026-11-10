/**
 * editions-operations.node.test.ts — ISOLATED Postgres only. R5: email outbox (who is told what, once), receipts, reminders, analytics masking and access,
 * team invitation naming, and a CATALOG-WIDE security review of every Editions table and function.
 * Run: ISOLATED_ONLY=editions-operations npm run test:isolated
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const id = (n: number) => `${n.toString(16).padStart(2, '0')}000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, '0')}`;
const U = { ADMIN: id(1), OWNER: id(3), ORG_ADMIN: id(4), ORG_EDITOR: id(5), BIZ1: id(6), BIZ2: id(7), STRANGER: id(8), VISITOR: id(9) } as const;
type Who = keyof typeof U | 'anon' | 'service';
const rowsTag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (o: string) => o.split('\n').map((l) => l.trim()).filter((l) => l && !rowsTag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^WARNING|^NOTICE/.test(l));
const last = (o: string) => rowsOf(o).pop() ?? '';
const failed = (o: string) => /^ERROR:|permission denied|row-level security|violates/im.test(o);
class Env {
  db!: ReplayDb;
  as(w: Who) { return w === 'anon' ? 'set local role anon;' : w === 'service' ? 'set local role service_role;' : `set local request.jwt.claims = '{"sub":"${U[w]}","email":"${U[w]}@x.invalid","role":"authenticated"}'; set local request.jwt.claim.sub = '${U[w]}'; set local role authenticated;`; }
  try(w: Who, sql: string) { return this.db.raw(`begin; ${this.as(w)} ${sql}; rollback;`); }
  do(w: Who, sql: string) { return this.db.raw(`begin; ${this.as(w)} ${sql}; commit;`); }
  q(sql: string) { return last(this.db.raw(sql)); }
  sup(sql: string) { return this.db.raw(sql); }
  one(w: Who, sql: string) { return last(this.try(w, sql)); }
  doOne(w: Who, sql: string) { return last(this.do(w, sql)); }
}
let E: Env; let ORG = '', ED = '', B1 = '', B2 = '', T = '';
const days = (n: number) => `(now() + interval '${n} days')`; const d = (n: number) => `(current_date + ${n})`;
const outbox = (where = 'true') => E.q(`select coalesce(string_agg(kind || ':' || user_id, ',' order by id), '') from edition_email_outbox where ${where}`);
const U_ = (k: keyof typeof U) => U[k];

before(() => {
  E = new Env(); E.db = createReplayDb('editionsops');
  E.sup(`do $$ begin if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if; end $$;`);
  E.sup(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated;`);
  const all = Object.values(U).map((x) => `'${x}'::uuid`).join(',');
  E.sup(`insert into auth.users (id, email) select x, x::text || '@x.invalid' from unnest(array[${all}]) x on conflict do nothing;
    insert into profiles (id, role, full_name) select x, case when x = '${U.ADMIN}'::uuid then 'admin' else 'customer' end, 'N' from unnest(array[${all}]) x on conflict (id) do update set role = excluded.role;
    insert into admin_config (key, value, category) values ('editions.enabled','true','features'),('editions.commerce.enabled','true','editions') on conflict (key) do update set value = excluded.value;`);
  ORG = last(E.do('OWNER', `select public.create_edition_organiser('ZZ Ops Org', 'zz-ops-org')`));
  E.do('OWNER', `select public.invite_edition_member('${ORG}', '${U.ORG_ADMIN}@x.invalid', 'admin')`);
  E.do('ORG_ADMIN', `select public.accept_edition_invite('${E.q(`select id from edition_organiser_invites where organiser_id='${ORG}' and email='${U.ORG_ADMIN}@x.invalid'`)}')`);
  E.do('OWNER', `select public.invite_edition_member('${ORG}', '${U.ORG_EDITOR}@x.invalid', 'editor')`);
  E.do('ORG_EDITOR', `select public.accept_edition_invite('${E.q(`select id from edition_organiser_invites where organiser_id='${ORG}' and email='${U.ORG_EDITOR}@x.invalid'`)}')`);
  E.do('OWNER', `select public.invite_edition_member('${ORG}', '${U.VISITOR}@x.invalid', 'editor')`);   // left pending on purpose
  E.do('OWNER', `select public.request_edition_organiser_verification('${ORG}', 'evidence evidence')`);
  E.do('ADMIN', `select public.admin_decide_edition_organiser('${ORG}', 'verify', 'ok ok ok ok')`);
  for (const f of ['collect_payments', 'memberships', 'offline_records', 'participation_fees']) E.do('ADMIN', `select public.admin_grant_edition_org_entitlement('${ORG}', '${f}', null, ${days(90)}, 'ZZ ops suite')`);
  E.do('OWNER', `select public.edition_accept_commerce_terms('${ORG}', 'draft-1')`);
  E.do('service', `select public.edition_payout_account_sync('${ORG}', 'acct_ops_1', true, true, true, '[]'::jsonb)`);
  ED = last(E.do('OWNER', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG}','zz-ops-fest','ZZ Ops Fest','x','multi_day',${d(10)},${d(12)}) returning id`));
  E.do('ADMIN', `select public.admin_grant_edition_entitlement('${ED}', 'publish', now(), ${days(90)}, 'ZZ ops suite')`);
  E.do('OWNER', `select public.edition_set_status('${ED}', 'published')`);
  const biz = (o: string, n: string) => last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${o}', '${n}', 'food_drink', 'x', true) returning id`));
  B1 = biz(U.BIZ1, 'ZZ Ops Cafe'); B2 = biz(U.BIZ2, 'ZZ Ops Bakery');
  T = last(E.do('ORG_ADMIN', `select public.edition_tier_save('${ORG}', null, 'ZZ Ops Tier', 'd', '[]'::jsonb, 1000, null, false, 'none', 'application', 'free', null, null, 1)`));
});
after(() => { try { E?.db.drop(); } catch { /* */ } });

describe('email outbox: the right people, once, with no address or body stored', () => {
  test('nothing is readable or callable by people; the table holds no email address column', () => {
    for (const w of ['OWNER', 'ADMIN', 'BIZ1', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select * from public.edition_email_outbox`)), w);
    assert.equal(E.q(`select count(*) from information_schema.columns where table_name='edition_email_outbox' and column_name ~* '(email|address|body|html|text)'`), '0');
    for (const fn of ['edition_email_next', 'edition_email_mark', 'edition_membership_enqueue_reminders', 'edition_enqueue_email']) {
      const grants = E.q(`select count(*) from pg_proc p where proname='${fn}' and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`);
      assert.equal(grants, '0', fn);
    }
  });
  test('an invitation to a business tells its owner once; a request tells the organiser admins; answers tell the other side', () => {
    const l = last(E.do('ORG_ADMIN', `select public.edition_invite_partner('${ED}','business','${B1}','Cafe','Hi')`));
    assert.equal(outbox(`kind='partner_invited'`), `partner_invited:${U.BIZ1}`);
    E.do('BIZ1', `select public.edition_link_act('${l}','approve',null)`);
    assert.equal(outbox(`kind='partner_answered'`), `partner_answered:${U.OWNER},partner_answered:${U.ORG_ADMIN}`.split(',').sort().join(',') === outbox(`kind='partner_answered'`).split(',').sort().join(',') ? outbox(`kind='partner_answered'`) : 'MISMATCH');
    assert.match(outbox(`kind='partner_answered'`), new RegExp(U.OWNER)); assert.match(outbox(`kind='partner_answered'`), new RegExp(U.ORG_ADMIN));
    assert.doesNotMatch(outbox(`kind='partner_answered'`), new RegExp(U.ORG_EDITOR), 'editors are not emailed');
    const before = E.q(`select count(*) from edition_email_outbox`);
    E.do('BIZ1', `select public.edition_link_act('${l}','withdraw',null)`);
    assert.match(outbox(`kind='partner_withdrew'`), new RegExp(U.OWNER));
    const lr = last(E.do('BIZ2', `select public.edition_request_to_join('${ED}','business','${B2}','Please')`));
    assert.match(outbox(`kind='partner_requested'`), new RegExp(U.ORG_ADMIN));
    E.do('ORG_ADMIN', `select public.edition_link_act('${lr}','approve',null)`);
    assert.equal(outbox(`kind='partner_request_answered'`), `partner_request_answered:${U.BIZ2}`);
    E.do('ORG_ADMIN', `select public.edition_link_act('${lr}','remove',null)`);
    assert.equal(outbox(`kind='partner_removed'`), `partner_removed:${U.BIZ2}`);
    assert.ok(Number(E.q(`select count(*) from edition_email_outbox`)) > Number(before));
  });
  test('payload carries only titles and names, never contact details', () => {
    const p = E.q(`select payload::text from edition_email_outbox where kind='partner_invited'`);
    assert.match(p, /ZZ Ops Fest/); assert.match(p, /ZZ Ops Org/); assert.doesNotMatch(p, /@|phone|password/i);
  });
  test('repeating the same event does not queue a second message (dedupe)', () => {
    const n = E.q(`select count(*) from edition_email_outbox`);
    E.sup(`update edition_links set label = label where kind='business'`);
    E.sup(`select public.edition_enqueue_email('partner_invited', '${U.BIZ1}', (select dedupe_key from edition_email_outbox where kind='partner_invited' limit 1), '{}'::jsonb)`);
    assert.equal(E.q(`select count(*) from edition_email_outbox`), n);
  });
  test('membership emails: applied tells admins; approved/declined and welcome tell the business; failure and expiry tell the business', () => {
    const m = last(E.do('BIZ1', `select public.edition_membership_apply('${T}', '${B1}', 'monthly', 'Hello')`));
    assert.match(outbox(`kind='membership_applied'`), new RegExp(U.ORG_ADMIN));
    E.do('ORG_ADMIN', `select public.edition_membership_decide('${m}', 'approve')`);
    assert.equal(outbox(`kind='membership_approved'`), `membership_approved:${U.BIZ1}`);
    E.do('service', `select public.edition_membership_payment_succeeded('${m}', 'sub_o', 'pi_o', 'in_o', 'ch_o', now(), ${days(30)}, 1000, null, null)`);
    assert.equal(outbox(`kind='membership_welcome'`), `membership_welcome:${U.BIZ1}`);
    assert.equal(outbox(`kind='payment_receipt'`), `payment_receipt:${U.BIZ1}`);
    assert.match(E.q(`select payload::text from edition_email_outbox where kind='payment_receipt'`), /"charge_pence": 1000/);
    E.do('service', `select public.edition_membership_payment_failed('${m}', 'in_o2', 1)`);
    assert.equal(outbox(`kind='membership_payment_failed'`), `membership_payment_failed:${U.BIZ1}`);
    E.sup(`update organiser_memberships set past_due_since = now() - interval '30 days' where id='${m}'`);
    E.do('service', `select public.edition_membership_sweep()`);
    assert.equal(outbox(`kind='membership_expired'`), `membership_expired:${U.BIZ1}`);
    const b3 = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.STRANGER}', 'ZZ Decline Shop', 'retail', 'x', true) returning id`));
    const m3 = last(E.do('STRANGER', `select public.edition_membership_apply('${T}', '${b3}', 'monthly')`)); E.do('ORG_ADMIN', `select public.edition_membership_decide('${m3}', 'decline', 'Not now')`);
    assert.equal(outbox(`kind='membership_declined'`), `membership_declined:${U.STRANGER}`);
  });
  test('invited members and offline renewals: invitation emailed; reminders queue once per period via the service function', () => {
    const b4 = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.VISITOR}', 'ZZ Invite Shop', 'retail', 'x', true) returning id`));
    E.do('ORG_ADMIN', `select public.edition_membership_invite('${ORG}', '${T}', '${b4}', 'monthly', 'Join us')`);
    assert.equal(outbox(`kind='membership_invited'`), `membership_invited:${U.VISITOR}`);
    const mo = last(E.do('ORG_ADMIN', `select public.edition_membership_record_offline('${ORG}', '${T}', '${B2}', 'offline', now(), ${days(20)}, 5000, 'cheque', 'Cheque 5')`));
    E.do('BIZ2', `select public.edition_membership_respond('${mo}', true)`);   // consent: the business owner accepts the recorded membership
    assert.equal(E.q(`select public.edition_membership_enqueue_reminders()`), '1');
    assert.match(outbox(`kind like 'membership_renewal_%'`), new RegExp(`membership_renewal_30d:${U.BIZ2}`));
    assert.equal(E.doOne('service', `select public.edition_membership_enqueue_reminders()`), '0', 'already reminded for this period');
    assert.ok(failed(E.try('OWNER', `select public.edition_membership_enqueue_reminders()`)));
    E.sup(`select 1 from organiser_memberships where id='${mo}'`);
  });
  test('the sender sees addresses only through the service function, which skips sent and exhausted messages and marks results', () => {
    const rows = E.do('service', `select id || '|' || kind || '|' || email from public.edition_email_next(100)`);
    assert.match(rows, /@x\.invalid/);
    const first = E.q(`select min(id) from edition_email_outbox where sent_at is null`);
    E.do('service', `select public.edition_email_mark(${first}, true)`);
    assert.doesNotMatch(E.do('service', `select id::text from public.edition_email_next(100)`), new RegExp(`^${first}$`, 'm'));
    const second = E.q(`select min(id) from edition_email_outbox where sent_at is null`);
    for (let i = 0; i < 5; i++) E.do('service', `select public.edition_email_mark(${second}, false, 'smtp down')`);
    assert.equal(E.q(`select attempts from edition_email_outbox where id=${second}`), '5');
    assert.doesNotMatch(E.do('service', `select id::text from public.edition_email_next(100)`), new RegExp(`^${second}$`, 'm'), 'stops after 5 attempts');
    for (const w of ['OWNER', 'ADMIN', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select * from public.edition_email_next(10)`)), w);
  });
});

describe('analytics: aggregates, masked small counts, team only', () => {
  test('visitor events are counted; counts under 5 are masked; exact structure counts are never masked', () => {
    for (let i = 0; i < 7; i++) E.sup(`insert into analytics_events (event_name, object_type, object_id, anon_id, platform, consent) values ('edition_viewed', 'edition', '${ED}', 'a${i}', 'web', true)`);
    for (let i = 0; i < 3; i++) E.sup(`insert into analytics_events (event_name, object_type, object_id, anon_id, platform, consent) values ('ticket_outbound_clicked', 'edition', '${ED}', 'b${i}', 'web', true)`);
    const r = E.one('ORG_EDITOR' as Who, `select string_agg(metric || '=' || coalesce(value::text, 'masked'), ',' order by metric) from public.edition_org_analytics('${ORG}', '${ED}', 30)`);
    assert.match(r, /page_views=7/); assert.match(r, /ticket_clicks=masked/); assert.match(r, /sessions=\d/); assert.match(r, /partners_waiting=\d/);
    assert.doesNotMatch(E.one('ORG_ADMIN', `select string_agg(metric, ',') from public.edition_org_analytics('${ORG}', null, 30)`), /user|anon|email/);
  });
  test('only the organiser team and admins; other organisers and the public cannot', () => {
    for (const w of ['STRANGER', 'BIZ1', 'VISITOR', 'anon'] as Who[]) assert.ok(failed(E.try(w, `select * from public.edition_org_analytics('${ORG}', null, 30)`)), w);
    assert.ok(!failed(E.try('ADMIN', `select * from public.edition_org_analytics('${ORG}', null, 30)`)));
  });
  test('the window is clamped and saves are counted from rows', () => {
    E.do('VISITOR', `select public.edition_save('${ED}')`);
    assert.match(E.one('ORG_ADMIN', `select coalesce(value::text, 'masked') from public.edition_org_analytics('${ORG}', '${ED}', 99999) where metric='saves'`), /masked/);
  });
});

describe('team invitations name the organiser', () => {
  test('an invited person sees who invited them and in what role; nobody else sees it', () => {
    assert.match(E.one('VISITOR', `select organiser_name || '|' || role from public.edition_my_org_invites()`), /ZZ Ops Org\|editor/, E.try('VISITOR', `select * from public.edition_my_org_invites()`) + E.q(`select email || status from edition_organiser_invites where email like '${U.VISITOR}%'`));
    assert.equal(E.one('STRANGER', `select count(*) from public.edition_my_org_invites()`), '0');
    assert.ok(failed(E.try('anon', `select * from public.edition_my_org_invites()`)));
  });
});

describe('security review: every Editions table and function, from the catalog', () => {
  const T = `(relname like 'edition%' or relname like 'organiser_membership%' or relname = 'editions')`;
  test('every Editions table has RLS, no FOR ALL policy, no anon write, no authenticated write (all writes go through functions)', () => {
    assert.equal(E.q(`select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and ${T} and not c.relrowsecurity`), '0');
    assert.equal(E.q(`select count(*) from pg_policies where schemaname='public' and (tablename like 'edition%' or tablename like 'organiser_membership%') and cmd='ALL'`), '0');
    assert.equal(E.q(`select count(*) from information_schema.role_table_grants where table_schema='public' and grantee='anon' and (table_name like 'edition%' or table_name like 'organiser_membership%') and privilege_type <> 'SELECT'`), '0');
  });
  test('the only tables a signed-in person may write directly are the R1 content tables guarded by role policies (never money, memberships, links, saves or ledgers)', () => {
    const writable = E.q(`select coalesce(string_agg(distinct t, ',' order by t), '') from (
      select table_name t from information_schema.role_table_grants where table_schema='public' and grantee='authenticated' and (table_name like 'edition%' or table_name like 'organiser_membership%') and privilege_type in ('INSERT','UPDATE','DELETE')
      union select table_name from information_schema.column_privileges where table_schema='public' and grantee='authenticated' and (table_name like 'edition%' or table_name like 'organiser_membership%') and privilege_type in ('INSERT','UPDATE')) x`);
    assert.equal(writable, 'edition_pages,edition_series,edition_sessions,edition_sponsors,edition_updates,edition_venues,editions,edition_organisers'.split(',').sort().join(','));
  });
  test('every SECURITY DEFINER function pins its search_path', () => {
    const unpinned = E.q(`select coalesce(string_agg(p.proname, ','), '') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and (p.proname like 'edition%' or p.proname like 'admin_%edition%' or p.proname like 'organiser_membership%' or p.proname like 'editions%')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
    assert.equal(unpinned, '');
  });
  test('no Editions function is executable by PUBLIC; anon runs only the allow-listed read helpers', () => {
    assert.equal(E.q(`select coalesce(string_agg(p.proname, ','), '') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'edition%' or p.proname like 'admin_%edition%' or p.proname like 'organiser_membership%') and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0)`), '');
    const anon = E.q(`select coalesce(string_agg(p.proname, ',' order by p.proname), '') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'edition%' or p.proname like 'admin_%edition%' or p.proname like 'organiser_membership%' or p.proname like 'editions%') and has_function_privilege('anon', p.oid, 'execute')`);
    assert.equal(anon, 'edition_entitled,edition_is_public,edition_participation_ok,edition_pilot_visible,edition_public_tiers,edition_role_rank,editions_enabled');   // edition_role_rank is a pure ranking function (no data access)
  });
  test('money and provider functions are never executable by a signed-in person', () => {
    const exposed = E.q(`select coalesce(string_agg(p.proname, ',' order by p.proname), '') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and has_function_privilege('authenticated', p.oid, 'execute')
      and p.proname in ('edition_fulfil_order','edition_order_failed','edition_refund_order','edition_payout_account_sync','edition_membership_payment_succeeded','edition_membership_payment_failed','edition_membership_subscription_changed','edition_membership_sweep',
        'edition_participation_payment_succeeded','edition_participation_payment_failed','edition_payment_refunded','edition_payment_disputed','edition_reconcile_apply','edition_refunds_next','edition_refund_request_mark','edition_record_payment_row','edition_record_exception',
        'edition_webhook_begin','edition_webhook_done','edition_payment_known','edition_customer_get','edition_customer_set','edition_payout_account_for','edition_tier_set_stripe_price','edition_email_next','edition_email_mark','edition_enqueue_email')`);
    assert.equal(exposed, '');
  });
  test('the simulator is absent from every migration (it exists only in the local stack)', () => {
    assert.equal(E.q(`select count(*) from pg_proc where proname like 'edition_local_simulate%'`), '0');
  });
  test('Editions touched no existing table: no new column on shared tables, no trigger added to them except through the edition tables', () => {
    assert.equal(E.q(`select count(*) from information_schema.columns where table_schema='public' and table_name in ('local_businesses','local_offers','events','regular_activities','hubs','hub_members','profiles','saved_items') and column_name ~* '(edition|organiser_member)'`), '0');
    assert.equal(E.q(`select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid where not t.tgisinternal and c.relname in ('local_businesses','local_offers','events','regular_activities','hubs','hub_members') and t.tgname ~* 'edition'`), '0');
  });
  test('the ledger and entitlement tables reject deletes and unsanctioned updates even for the superuser', () => {
    assert.match(E.sup(`delete from edition_payments`), /cannot be deleted/); assert.match(E.sup(`delete from edition_entitlements`), /cannot be deleted/); assert.match(E.sup(`delete from edition_organiser_entitlements`), /cannot be deleted/);
  });
});
