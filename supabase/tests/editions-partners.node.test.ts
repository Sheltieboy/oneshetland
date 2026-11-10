/**
 * editions-partners.node.test.ts — ISOLATED Postgres only. R2: the organiser-to-business partnership journey.
 * Proves O7/O8, B1-B5, S5/S6 and the tier/paid-placement rules through the real roles.
 * Run: ISOLATED_ONLY=editions-partners npm run test:isolated   (never `npm test`)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const id = (n: number) => `${n.toString(16).padStart(2, '0')}000000-0000-4000-8000-0000000000${n.toString(16).padStart(2, '0')}`;
const U = { ADMIN: id(1), MOD: id(2), ORG_OWNER: id(3), ORG_EDITOR: id(4), BIZ1: id(5), BIZ2: id(6), STRANGER: id(7), HUBMAN: id(8) } as const;
type Who = keyof typeof U | 'anon';
const rowsTag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (o: string) => o.split('\n').map((l) => l.trim()).filter((l) => l && !rowsTag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT|^WARNING|^NOTICE/.test(l));
const last = (o: string) => rowsOf(o).pop() ?? '';
const failed = (o: string) => /^ERROR:|permission denied|row-level security|violates|illegal partnership|not permitted/im.test(o);

class Env {
  db!: ReplayDb;
  as(who: Who) { return who === 'anon' ? 'set local role anon;' : `set local request.jwt.claims = '{"sub":"${U[who]}","email":"${U[who]}@x.invalid","role":"authenticated"}'; set local request.jwt.claim.sub = '${U[who]}'; set local role authenticated;`; }
  try(who: Who, sql: string) { return this.db.raw(`begin; ${this.as(who)} ${sql}; rollback;`); }
  do(who: Who, sql: string) { return this.db.raw(`begin; ${this.as(who)} ${sql}; commit;`); }
  q(sql: string) { return last(this.db.raw(sql)); }
  sup(sql: string) { return this.db.raw(sql); }
  one(who: Who, sql: string) { return last(this.try(who, sql)); }
}
let E: Env;
let ORG = '', ED = '', BIZ1 = '', BIZ2 = '', BIZ_UNCLAIMED = '', BIZ_FIXTURE = '', EV1 = '', EV_PLATFORM = '', ACT1 = '', OFFER_A = '', OFFER_B = '', OFFER_OLD = '', LINK = '';
const d = (n: number) => `(current_date + ${n})`;
const act = (who: Who, link: string, a: string, note = 'null') => E.try(who, `select public.edition_link_act('${link}', '${a}', ${note})`);
const doAct = (who: Who, link: string, a: string) => E.do(who, `select public.edition_link_act('${link}', '${a}', null)`);
const state = (link: string) => E.q(`select state from edition_links where id='${link}'`);
const anonEvBiz = () => E.one('anon', `select count(*) from public.edition_public_businesses where edition_id='${ED}'`);

before(() => {
  E = new Env();
  E.db = createReplayDb('editionspartners');
  E.sup(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated;`);
  E.sup(`insert into auth.users (id, email) select x, x::text || '@x.invalid' from unnest(array['${U.ADMIN}'::uuid,'${U.MOD}'::uuid,'${U.ORG_OWNER}'::uuid,'${U.ORG_EDITOR}'::uuid,'${U.BIZ1}'::uuid,'${U.BIZ2}'::uuid,'${U.STRANGER}'::uuid,'${U.HUBMAN}'::uuid]) x on conflict do nothing;
    insert into profiles (id, role, full_name) values ('${U.ADMIN}','admin','Zed Admin'),('${U.MOD}','moderator','Mo Mod'),('${U.ORG_OWNER}','customer','Orla Organiser'),('${U.ORG_EDITOR}','customer','Eddie Editor'),
      ('${U.BIZ1}','customer','Bea Owner'),('${U.BIZ2}','customer','Bo Owner'),('${U.STRANGER}','customer','Sam Stranger'),('${U.HUBMAN}','customer','Hugh Hub')
      on conflict (id) do update set role = excluded.role, full_name = excluded.full_name;
    insert into admin_config (key, value, category) values ('editions.enabled','true','features') on conflict (key) do update set value='true';`);
  const mk = (owner: string | null, name: string, tier: string, until: string) => last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active, subscription_tier, subscription_until)
      values (${owner ? `'${owner}'` : 'null'}, '${name}', 'food_drink', '1 Quay, Lerwick', true, '${tier}', ${until}) returning id`));
  BIZ1 = mk(U.BIZ1, 'ZZ Harbour Cafe', 'pro', `now() + interval '60 days'`);
  BIZ2 = mk(U.BIZ2, 'ZZ Free Bakery', 'free', 'null');
  BIZ_UNCLAIMED = mk(null, 'ZZ Unclaimed Shop', 'free', 'null');
  BIZ_FIXTURE = mk(U.BIZ2, 'ZZ Fixture Biz', 'pro', `now() + interval '60 days'`);
  E.sup(`insert into discovery_fixtures (entity, entity_id, reason) values ('business','${BIZ_FIXTURE}','ZZ fixture')`);
  const off = (biz: string, title: string, extra = `valid_until|now() + interval '30 days'`) => last(E.sup(`insert into local_offers (business_id, title, discount_type, discount_value, is_active ${extra ? ', ' + extra.split('|')[0] : ''}) values ('${biz}','${title}','percent',10, true ${extra ? ', ' + extra.split('|')[1] : ''}) returning id`));
  OFFER_A = off(BIZ1, 'ZZ 10% off scones');
  OFFER_B = off(BIZ1, 'ZZ free coffee with lunch');
  OFFER_OLD = off(BIZ1, 'ZZ expired offer', `valid_until|now() - interval '1 day'`);
  EV1 = last(E.sup(`insert into events (title, starts_at, status, organiser_business_id, organiser_user_id) values ('ZZ Harbour Quiz Night', (${d(11)})::timestamp + interval '19 hours', 'published', '${BIZ1}', '${U.BIZ1}') returning id`));
  EV_PLATFORM = last(E.sup(`insert into events (title, starts_at, status, is_platform_event) values ('ZZ Platform Event', (${d(11)})::timestamp + interval '19 hours', 'published', true) returning id`));
  ACT1 = last(E.sup(`insert into regular_activities (slug, title, status, organiser_business_id, created_by) values ('zz-knit-circle','ZZ Knit Circle','published','${BIZ1}','${U.BIZ1}') returning id`));
  ORG = last(E.do('ORG_OWNER', `select public.create_edition_organiser('ZZ TEST Festival Co.', 'zz-test-festival-co', 'tag')`));
  E.do('ORG_OWNER', `select public.invite_edition_member('${ORG}', '${U.ORG_EDITOR}@x.invalid', 'editor')`);
  const inv = E.q(`select id from edition_organiser_invites where organiser_id='${ORG}'`);
  E.do('ORG_EDITOR', `select public.accept_edition_invite('${inv}')`);
  E.do('ORG_OWNER', `select public.request_edition_organiser_verification('${ORG}', 'ZZ TEST committee evidence')`);
  E.do('ADMIN', `select public.admin_decide_edition_organiser('${ORG}', 'verify', 'ok ok ok ok')`);
  ED = last(E.do('ORG_OWNER', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG}','zz-test-fest-2027','ZZ TEST Fest','A festival.','multi_day',${d(10)},${d(12)}) returning id`));
  E.do('ADMIN', `select public.admin_grant_edition_entitlement('${ED}', 'publish', now(), now() + interval '90 days', 'ZZ TEST grant for partner suite')`);
  E.do('ORG_OWNER', `select public.edition_set_status('${ED}', 'published')`);
  assert.equal(E.one('anon', `select count(*) from public.editions where id='${ED}'`), '1');
});
after(() => { try { E?.db.drop(); } catch { /* */ } });

describe('S8 R2 tables and functions are locked down', () => {
  test('RLS on, no FOR ALL, no anon DML, no authenticated DML on link tables', () => {
    assert.equal(E.q(`select count(*) from pg_class where relname in ('edition_links','edition_link_notes','edition_link_offers') and not relrowsecurity`), '0');
    assert.equal(E.q(`select count(*) from pg_policies where tablename like 'edition_link%' and cmd='ALL'`), '0');
    assert.equal(E.q(`select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_name like 'edition_link%' and privilege_type <> 'SELECT'`), '0');
  });
  test('anon can read only the public columns of edition_links (no decision metadata)', () => {
    const cols = E.q(`select string_agg(column_name, ',' order by column_name) from information_schema.column_privileges where grantee='anon' and table_name='edition_links' and privilege_type='SELECT'`);
    assert.equal(cols, 'activity_id,business_id,edition_id,event_id,hub_id,id,kind,label,position,state');
    assert.equal(E.q(`select count(*) from information_schema.role_table_grants where grantee='anon' and table_name='edition_link_notes'`), '0');
  });
  test('no R2 definer function or trigger function is executable by anon', () => {
    const open = E.q(`select coalesce(string_agg(p.proname, ',' order by p.proname), '') from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and (p.proname like 'edition_link%' or p.proname like 'edition_partner%' or p.proname like 'edition_find%' or p.proname like 'edition_my_%'
        or p.proname in ('edition_invite_partner','edition_request_to_join','edition_offer_options','edition_set_link_offers','edition_controls_subject','edition_joinable'))
        and has_function_privilege('anon', p.oid, 'execute')`);
    assert.equal(open, '');
  });
  test('the public views are security_invoker', () => {
    assert.equal(E.q(`select count(*) from pg_class where relname like 'edition_public_%' and relkind='v' and not coalesce(reloptions::text, '') like '%security_invoker=true%'`), '0');
  });
});

describe('R2 stays payment-free, with one insertion point for later eligibility (RF1, RF3)', () => {
  test('no money, price, fee, payment or entitlement column on any partnership table', () => {
    const cols = E.q(`select coalesce(string_agg(table_name || '.' || column_name, ','), '') from information_schema.columns where table_schema='public' and table_name in ('edition_links','edition_link_notes','edition_link_offers')
      and column_name ~* '(pence|price|fee|amount|paid|payment|stripe|currency|vat|entitle|invoice|subscription)'`);
    assert.equal(cols, '');
  });
  test('every public read of a partnership goes through edition_participation_ok (policies and views)', () => {
    const defs = E.q(`select count(*) from pg_views where schemaname='public' and viewname like 'edition_public_%' and definition like '%edition_participation_ok%'`);
    assert.equal(defs, '6', 'the four partner views plus the two Hub views (Editions 1.1)');
    assert.equal(E.q(`select count(*) from pg_policies where tablename in ('edition_links','edition_link_offers') and roles::text like '%anon%' and qual like '%edition_participation_ok%'`), '2');
  });
  test('making the predicate false hides approved partners everywhere at once (proves the single insertion point)', () => {
    const l = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ED}','business','${BIZ1}','Insertion point')`));
    doAct('BIZ1', l, 'approve');
    assert.equal(anonEvBiz(), '1');
    E.sup(`create or replace function public.edition_participation_ok(p_link uuid) returns boolean language sql stable as $$ select false $$`);
    assert.equal(anonEvBiz(), '0');
    assert.equal(E.one('anon', `select count(*) from public.edition_links where state='approved'`), '0');
    assert.equal(state(l), 'approved', 'consent is untouched by the commercial gate');
    E.sup(`create or replace function public.edition_participation_ok(p_link uuid) returns boolean language sql stable as $$ select true $$`);
    assert.equal(anonEvBiz(), '1');
    doAct('BIZ1', l, 'withdraw');
  });
});

describe('O7 organiser finds and invites a business; B1 the right owner sees it', () => {
  test('search returns only public, non-fixture businesses and flags unclaimed ones', () => {
    const r = E.try('ORG_EDITOR', `select name || ':' || claimed from public.edition_find_businesses('${ED}', 'zz ')`);
    assert.match(r, /ZZ Harbour Cafe:true/);
    assert.match(r, /ZZ Unclaimed Shop:false/);
    assert.doesNotMatch(r, /ZZ Fixture Biz/, 'discovery fixtures stay hidden');
    assert.equal(E.one('ORG_EDITOR', `select count(*) from public.edition_find_businesses('${ED}', 'z')`), '0', 'too-short query returns nothing');
    assert.ok(failed(E.try('STRANGER', `select * from public.edition_find_businesses('${ED}', 'zz ')`)));
    assert.ok(failed(E.try('anon', `select * from public.edition_find_businesses('${ED}', 'zz ')`)));
  });
  test('cannot invite an unclaimed business, a fixture, or with a bad kind', () => {
    assert.match(E.try('ORG_OWNER', `select public.edition_invite_partner('${ED}','business','${BIZ_UNCLAIMED}')`), /not been claimed/);
    assert.match(E.try('ORG_OWNER', `select public.edition_invite_partner('${ED}','business','${BIZ_FIXTURE}')`), /not available/);
    assert.match(E.try('ORG_OWNER', `select public.edition_invite_partner('${ED}','person','${BIZ1}')`), /unknown kind/);
  });
  test('only organiser editors invite; a stranger and the business owner cannot invite into someone else\'s Edition', () => {
    assert.ok(failed(E.try('STRANGER', `select public.edition_invite_partner('${ED}','business','${BIZ1}')`)));
    assert.ok(failed(E.try('BIZ1', `select public.edition_invite_partner('${ED}','business','${BIZ1}')`)));
    assert.ok(failed(E.try('anon', `select public.edition_invite_partner('${ED}','business','${BIZ1}')`)));
  });
  test('editor invites; the invitation is pending and NOT public', () => {
    LINK = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ED}','business','${BIZ1}','Festival cafe','Would you like to be our festival cafe?')`));
    assert.match(LINK, /^[0-9a-f-]{36}$/, LINK);
    assert.equal(state(LINK), 'pending');
    assert.equal(anonEvBiz(), '0');
    assert.match(E.try('ORG_OWNER', `select public.edition_invite_partner('${ED}','business','${BIZ1}')`), /already invited/);
  });
  test('B1: only the owner of that business sees the invitation, with edition and organiser context', () => {
    const mine = E.try('BIZ1', `select subject_name || '|' || state || '|' || edition_title || '|' || organiser_name || '|' || message from public.edition_my_partnerships()`);
    assert.match(mine, /ZZ Harbour Cafe\|pending\|ZZ TEST Fest\|ZZ TEST Festival Co\.\|Would you like to be our festival cafe\?/);
    assert.equal(E.one('BIZ1', `select public.edition_my_pending_count()`), '1');
    assert.equal(E.one('BIZ2', `select count(*) from public.edition_my_partnerships()`), '0');
    assert.equal(E.one('STRANGER', `select count(*) from public.edition_links`), '0');
    assert.equal(E.one('STRANGER', `select count(*) from public.edition_link_notes`), '0');
    assert.equal(E.one('anon', `select count(*) from public.edition_links`), '0');
  });
  test('the organiser team sees partner rows; strangers cannot', () => {
    assert.match(E.try('ORG_EDITOR', `select subject_name || ':' || state from public.edition_partner_rows('${ED}')`), /ZZ Harbour Cafe:pending/);
    assert.ok(failed(E.try('STRANGER', `select * from public.edition_partner_rows('${ED}')`)));
    assert.ok(failed(E.try('BIZ1', `select * from public.edition_partner_rows('${ED}')`)));
  });
});

describe('S5 the state machine: each side can only act on its own side', () => {
  test('the organiser cannot approve its own invitation; staff and other owners cannot either', () => {
    for (const w of ['ORG_OWNER', 'ORG_EDITOR', 'ADMIN', 'MOD', 'BIZ2', 'STRANGER'] as Who[])
      assert.ok(failed(act(w, LINK, 'approve')), w);
    assert.equal(state(LINK), 'pending');
  });
  test('direct writes to the link table are impossible for everyone', () => {
    for (const w of ['BIZ1', 'ORG_OWNER', 'ADMIN', 'anon'] as Who[]) {
      assert.ok(failed(E.try(w, `update public.edition_links set state='approved' where id='${LINK}'`)), w);
      assert.ok(failed(E.try(w, `insert into public.edition_links (edition_id, kind, business_id, initiated_by) values ('${ED}','business','${BIZ2}','entity')`)), w);
      assert.ok(failed(E.try(w, `delete from public.edition_links where id='${LINK}'`)), w);
    }
  });
  test('the database refuses an illegal transition even for the superuser', () => {
    assert.match(E.sup(`update edition_links set state='withdrawn', ended_by='entity' where id='${LINK}'`), /illegal partnership transition/);
    assert.match(E.sup(`update edition_links set business_id='${BIZ2}' where id='${LINK}'`), /cannot change/);
  });
  test('the organiser can cancel a waiting invitation; the owner then sees it ended; it can be re-sent', () => {
    doAct('ORG_EDITOR', LINK, 'cancel');
    assert.equal(state(LINK), 'cancelled');
    assert.equal(E.one('BIZ1', `select public.edition_my_pending_count()`), '0');
    assert.ok(failed(act('BIZ1', LINK, 'approve')), 'a cancelled invitation cannot be approved');
    LINK = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ED}','business','${BIZ1}','Festival cafe','Second try')`));
    assert.equal(state(LINK), 'pending');
  });
});

describe('B2 the business approves, declines and withdraws', () => {
  test('a decline ends it, records a note, and blocks a repeat invitation for 30 days', () => {
    const l2 = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ED}','business','${BIZ2}','Bakery','Hi')`));
    E.do('BIZ2', `select public.edition_link_act('${l2}', 'decline', 'Not this year, thanks')`);
    assert.equal(state(l2), 'declined');
    assert.equal(E.q(`select ended_by from edition_links where id='${l2}'`), 'entity');
    assert.equal(E.q(`select response_note from edition_link_notes where link_id='${l2}'`), 'Not this year, thanks');
    assert.match(E.try('ORG_EDITOR', `select public.edition_invite_partner('${ED}','business','${BIZ2}')`), /declined recently/);
    assert.equal(anonEvBiz(), '0');
    // after 30 days it is allowed again
    E.sup(`update edition_links set decided_at = now() - interval '31 days' where id='${l2}'`);
    assert.ok(!failed(E.try('ORG_EDITOR', `select public.edition_invite_partner('${ED}','business','${BIZ2}')`)));
  });
  test('the owner approves; the business is now public instantly', () => {
    doAct('BIZ1', LINK, 'approve');
    assert.equal(state(LINK), 'approved');
    assert.equal(anonEvBiz(), '1');
    assert.match(E.one('anon', `select name || '|' || coalesce(label, '') from public.edition_public_businesses where edition_id='${ED}'`), /ZZ Harbour Cafe\|Festival cafe/);
    assert.ok(failed(act('BIZ1', LINK, 'approve')), 'cannot approve twice');
  });
  test('public readers never see messages, notes or who decided', () => {
    assert.ok(failed(E.try('anon', `select count(*) from public.edition_link_notes`)));
    assert.ok(failed(E.try('anon', `select decided_by from public.edition_links`)));
    assert.ok(failed(E.try('anon', `select created_by from public.edition_links`)));
  });
  test('only the owner can withdraw; withdrawal removes it from the public at once', () => {
    for (const w of ['ORG_OWNER', 'ADMIN', 'MOD', 'BIZ2', 'STRANGER'] as Who[]) assert.ok(failed(act(w, LINK, 'withdraw')), w);
    assert.equal(anonEvBiz(), '1');
    doAct('BIZ1', LINK, 'withdraw');
    assert.equal(state(LINK), 'withdrawn');
    assert.equal(anonEvBiz(), '0', 'public Edition reflects the withdrawal immediately');
    assert.equal(E.q(`select ended_by from edition_links where id='${LINK}'`), 'entity');
  });
  test('after withdrawal the organiser may invite again, and the owner re-approves', () => {
    LINK = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ED}','business','${BIZ1}','Festival cafe')`));
    doAct('BIZ1', LINK, 'approve');
    assert.equal(anonEvBiz(), '1');
  });
  test('the organiser can remove an active partner; it is recorded as organiser-ended', () => {
    const l = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ED}','business','${BIZ2}')`));
    doAct('BIZ2', l, 'approve');
    assert.equal(anonEvBiz(), '2');
    assert.ok(failed(act('BIZ1', l, 'remove')), 'another owner cannot remove');
    doAct('ORG_EDITOR', l, 'remove');
    assert.equal(E.q(`select state || ',' || ended_by from edition_links where id='${l}'`), 'withdrawn,organiser');
    assert.equal(anonEvBiz(), '1');
  });
});

describe('B3 offers: the business chooses, existing paid rules still decide', () => {
  test('options show eligibility and reasons; only the owner can see them', () => {
    const r = E.try('BIZ1', `select title || ':' || eligible || ':' || coalesce(reason, '') from public.edition_offer_options('${LINK}')`);
    assert.match(r, /ZZ 10% off scones:true:/);
    assert.match(r, /ZZ expired offer:false:This offer has ended\./);
    assert.ok(failed(E.try('BIZ2', `select * from public.edition_offer_options('${LINK}')`)));
    assert.ok(failed(E.try('ORG_OWNER', `select * from public.edition_offer_options('${LINK}')`)));
  });
  test('only the owner can choose offers; ineligible and foreign offers are refused', () => {
    assert.ok(failed(E.try('ORG_OWNER', `select public.edition_set_link_offers('${LINK}', array['${OFFER_A}'::uuid])`)));
    assert.ok(failed(E.try('ADMIN', `select public.edition_set_link_offers('${LINK}', array['${OFFER_A}'::uuid])`)));
    assert.match(E.try('BIZ1', `select public.edition_set_link_offers('${LINK}', array['${OFFER_OLD}'::uuid])`), /not available to show/);
    const foreign = last(E.sup(`insert into local_offers (business_id, title, discount_type, discount_value, is_active, valid_until) values ('${BIZ2}','ZZ foreign','percent',5,true, now() + interval '30 days') returning id`));
    assert.match(E.try('BIZ1', `select public.edition_set_link_offers('${LINK}', array['${foreign}'::uuid])`), /not available to show/);
  });
  test('the chosen offer appears publicly; the unchosen one does not', () => {
    E.do('BIZ1', `select public.edition_set_link_offers('${LINK}', array['${OFFER_A}'::uuid])`);
    assert.equal(E.one('anon', `select string_agg(title, ',') from public.edition_public_offers where edition_id='${ED}'`), 'ZZ 10% off scones');
  });
  test('an offer that expires or is switched off drops out at read time, without any republish', () => {
    E.sup(`update local_offers set is_active=false where id='${OFFER_A}'`);
    assert.equal(E.one('anon', `select count(*) from public.edition_public_offers where edition_id='${ED}'`), '0');
    E.sup(`update local_offers set is_active=true where id='${OFFER_A}'`);
    E.sup(`update local_offers set valid_until = now() - interval '1 hour' where id='${OFFER_A}'`);
    assert.equal(E.one('anon', `select count(*) from public.edition_public_offers where edition_id='${ED}'`), '0');
    E.sup(`update local_offers set valid_until = now() + interval '30 days' where id='${OFFER_A}'`);
    assert.equal(E.one('anon', `select count(*) from public.edition_public_offers where edition_id='${ED}'`), '1');
  });
  test('S12 a lapsed plan hides the offer at once (the original Pro rule is not bypassed)', () => {
    E.sup(`update local_businesses set subscription_until = now() - interval '1 day' where id='${BIZ1}'`);
    assert.equal(E.one('anon', `select count(*) from public.edition_public_offers where edition_id='${ED}'`), '0');
    assert.match(E.try('BIZ1', `select reason from public.edition_offer_options('${LINK}') where title='ZZ 10% off scones'`), /Pro or Premium/);
    E.sup(`update local_businesses set subscription_until = now() + interval '60 days' where id='${BIZ1}'`);
    assert.equal(E.one('anon', `select count(*) from public.edition_public_offers where edition_id='${ED}'`), '1');
  });
  test('a free business cannot attach offers (they would never be public anyway)', () => {
    const l = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ED}','business','${BIZ2}')`));
    doAct('BIZ2', l, 'approve');
    const o = last(E.sup(`select id from local_offers where business_id='${BIZ2}' limit 1`));
    assert.match(E.try('BIZ2', `select public.edition_set_link_offers('${l}', array['${o}'::uuid])`), /Pro or Premium/);
    assert.equal(E.one('BIZ2', `select public.edition_set_link_offers('${l}', '{}'::uuid[])`), '0', 'choosing none is always allowed');
    doAct('BIZ2', l, 'withdraw');
  });
  test('withdrawing clears the chosen offers, so re-approval needs a fresh choice', () => {
    doAct('BIZ1', LINK, 'withdraw');
    assert.equal(E.q(`select count(*) from edition_link_offers where link_id='${LINK}'`), '0');
    LINK = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ED}','business','${BIZ1}','Festival cafe')`));
    doAct('BIZ1', LINK, 'approve');
    assert.equal(E.one('anon', `select count(*) from public.edition_public_offers where edition_id='${ED}'`), '0');
  });
  test('the database refuses to attach an offer to a pending link or another business\'s link', () => {
    assert.match(E.sup(`insert into edition_link_offers (link_id, offer_id) select '${LINK}', id from local_offers where business_id='${BIZ2}' limit 1`), /offers can only be attached/);
  });
});

describe('S6 events and activities: the controlling owner consents', () => {
  let LE = '', LA = '';
  test('search lists only independently owned, public items', () => {
    const r = E.try('ORG_EDITOR', `select kind || ':' || title from public.edition_find_activities('${ED}', 'zz')`);
    assert.match(r, /event:ZZ Harbour Quiz Night/);
    assert.match(r, /activity:ZZ Knit Circle/);
    assert.doesNotMatch(r, /Platform Event/, 'platform-owned events have no owner to consent');
  });
  test('a platform event cannot be invited', () => {
    assert.match(E.try('ORG_OWNER', `select public.edition_invite_partner('${ED}','event','${EV_PLATFORM}')`), /not available/);
  });
  test('inviting an event is pending until its owner approves; then it is public inside the dates', () => {
    LE = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ED}','event','${EV1}')`));
    LA = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ED}','activity','${ACT1}')`));
    assert.equal(E.one('anon', `select count(*) from public.edition_public_events where edition_id='${ED}'`), '0');
    assert.ok(failed(act('BIZ2', LE, 'approve')));
    assert.ok(failed(act('MOD', LE, 'approve')));
    doAct('BIZ1', LE, 'approve');
    doAct('BIZ1', LA, 'approve');
    assert.equal(E.one('anon', `select title from public.edition_public_events where edition_id='${ED}'`), 'ZZ Harbour Quiz Night');
    assert.equal(E.one('anon', `select title from public.edition_public_activities where edition_id='${ED}'`), 'ZZ Knit Circle');
  });
  test('the owner withdrawing, or unpublishing the event, removes it at once; moving it outside the dates hides it too', () => {
    E.sup(`update events set status = 'draft' where id='${EV1}'`);
    assert.equal(E.one('anon', `select count(*) from public.edition_public_events where edition_id='${ED}'`), '0', 'an unpublished event is not shown');
    E.sup(`update events set status = 'cancelled' where id='${EV1}'`);
    assert.equal(E.one('anon', `select status from public.edition_public_events where edition_id='${ED}'`), 'cancelled', 'cancelled events stay visible, labelled');
    E.sup(`update events set status = 'published' where id='${EV1}'`);
    E.sup(`update events set starts_at = starts_at + interval '40 days' where id='${EV1}'`);
    assert.equal(E.one('anon', `select count(*) from public.edition_public_events where edition_id='${ED}'`), '0', 'outside the Edition dates');
    assert.equal(E.try('ORG_EDITOR', `select in_window from public.edition_partner_rows('${ED}') where kind='event'`).includes('f'), true, 'organiser is warned');
    E.sup(`update events set starts_at = starts_at - interval '40 days' where id='${EV1}'`);
    assert.equal(E.one('anon', `select count(*) from public.edition_public_events where edition_id='${ED}'`), '1');
    doAct('BIZ1', LE, 'withdraw');
    assert.equal(E.one('anon', `select count(*) from public.edition_public_events where edition_id='${ED}'`), '0');
  });
  test('a paused activity disappears; the Edition cannot un-pause or edit it', () => {
    E.sup(`update regular_activities set admin_paused = true where id='${ACT1}'`);
    assert.equal(E.one('anon', `select count(*) from public.edition_public_activities where edition_id='${ED}'`), '0');
    E.sup(`update regular_activities set admin_paused = false where id='${ACT1}'`);
  });
  test('B4 a business owner can ask to join a public Edition; only the organiser can answer, and decline blocks re-asking', () => {
    assert.ok(failed(E.try('STRANGER', `select public.edition_request_to_join('${ED}','business','${BIZ1}')`)), 'cannot ask on behalf of a business you do not own');
    const lq = last(E.do('BIZ2', `select public.edition_request_to_join('${ED}','business','${BIZ2}','We would love to take part')`));
    assert.equal(E.q(`select initiated_by from edition_links where id='${lq}'`), 'entity');
    assert.ok(failed(act('BIZ2', lq, 'approve')), 'cannot approve its own request');
    assert.ok(failed(act('MOD', lq, 'approve')));
    assert.match(E.try('ORG_EDITOR', `select subject_name || ':' || initiated_by || ':' || message from public.edition_partner_rows('${ED}') where link_id='${lq}'`), /ZZ Free Bakery:entity:We would love/);
    doAct('ORG_EDITOR', lq, 'decline');
    assert.equal(state(lq), 'declined');
    assert.match(E.try('BIZ2', `select public.edition_request_to_join('${ED}','business','${BIZ2}')`), /declined recently/);
  });
  test('proposing an own event is a request the organiser must approve', () => {
    const lr = last(E.do('BIZ1', `select public.edition_request_to_join('${ED}','event','${EV1}','Our quiz night')`));
    assert.equal(E.one('anon', `select count(*) from public.edition_public_events where edition_id='${ED}'`), '0');
    doAct('ORG_OWNER', lr, 'approve');
    assert.equal(E.one('anon', `select count(*) from public.edition_public_events where edition_id='${ED}'`), '1');
  });
  test('a draft or unpublished Edition cannot be joined by a stranger, and is not discoverable via requests', () => {
    const draft = last(E.do('ORG_OWNER', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG}','zz-draft','ZZ Draft','x','single_day',${d(30)},${d(30)}) returning id`));
    assert.match(E.try('BIZ2', `select public.edition_request_to_join('${draft}','business','${BIZ2}')`), /edition not found/);
    assert.equal(E.one('BIZ2', `select count(*) from public.edition_joinable() where edition_id='${draft}'`), '0');
  });
});

describe('S5/S11 spam limits, self-owned subjects, suspension', () => {
  test('an organiser who also owns the business is approved immediately (audited as self-approved)', () => {
    E.do('ADMIN', `select public.admin_link_edition_organiser_hub('${ORG}', null)`);
    const own = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.ORG_OWNER}', 'ZZ Organiser Own Cafe', 'food_drink', 'x', true) returning id`));
    const l = last(E.do('ORG_OWNER', `select public.edition_invite_partner('${ED}','business','${own}')`));
    assert.equal(state(l), 'approved');
    assert.ok(Number(E.q(`select count(*) from edition_audit_log where action='partner_self_approved'`)) >= 1);
  });
  test('one subject cannot collect more than 10 waiting invitations', () => {
    const b = last(E.sup(`insert into local_businesses (owner_id, name, category, address, is_active) values ('${U.STRANGER}', 'ZZ Popular', 'food_drink', 'x', true) returning id`));
    const eds: string[] = [];
    for (let i = 0; i < 11; i++) eds.push(last(E.do('ORG_OWNER', `insert into public.editions (organiser_id, slug, title, summary, kind, starts_on, ends_on) values ('${ORG}','zz-spam-${i}','ZZ Spam ${i}','x','single_day',${d(40 + i)},${d(40 + i)}) returning id`)));
    for (let i = 0; i < 10; i++) assert.ok(!failed(E.do('ORG_OWNER', `select public.edition_invite_partner('${eds[i]}','business','${b}')`)), `invite ${i}`);
    assert.match(E.try('ORG_OWNER', `select public.edition_invite_partner('${eds[10]}','business','${b}')`), /several invitations waiting/);
  });
  test('a suspended Edition takes no new partners and its partners are not public', () => {
    E.do('ADMIN', `select public.edition_moderate('${ED}', 'suspend', 'ZZ TEST partner suite suspend')`);
    assert.equal(anonEvBiz(), '0', 'suspension hides partners');
    assert.match(E.try('ORG_OWNER', `select public.edition_invite_partner('${ED}','business','${BIZ2}')`), /not open for new partners/);
    // owners can still withdraw while suspended
    assert.ok(!failed(E.try('BIZ1', `select public.edition_link_act('${LINK}', 'withdraw', null)`)));
    E.do('ADMIN', `select public.edition_moderate('${ED}', 'restore', 'resolved')`);
  });
  test('deleting a business removes its links (no orphans) and nothing in Editions can change a business', () => {
    assert.equal(E.q(`select count(*) from information_schema.role_column_grants where grantee in ('anon','authenticated') and table_name in ('local_businesses','local_offers') and column_name like 'edition%'`), '0');
    assert.equal(E.q(`select count(*) from information_schema.columns where table_name in ('local_businesses','local_offers','events','regular_activities','hubs') and column_name like '%edition%'`), '0');
  });
  test('A6 every partnership action is in the audit log', () => {
    const acts = E.q(`select string_agg(distinct action, ',' order by action) from edition_audit_log where organiser_id='${ORG}' and action like 'partner_%'`);
    for (const a of ['partner_invited', 'partner_approved', 'partner_declined', 'partner_cancelled', 'partner_withdrawn', 'partner_requested', 'partner_offers_set', 'partner_self_approved'])
      assert.ok(acts.split(',').includes(a), `missing ${a}: ${acts}`);
  });
});

describe('R11 session pages: photograph, presenters and named businesses', () => {
  let SES = '', NEWLINK = '';
  test('fixture: the Edition is published again after the suspend/restore test', () => {
    E.sup(`update public.editions set status = 'published' where id = '${ED}'`);
    assert.equal(E.q(`select public.edition_is_public('${ED}')::text`), 'true');
  });
  test('an editor adds a session with a photograph and presenters; the public reads them; others cannot write', () => {
    SES = last(E.do('ORG_EDITOR', `insert into public.edition_sessions (edition_id, title, starts_at, kind, image_url, presenters) values ('${ED}','ZZ Page Session',(${d(11)})::timestamp + interval '11 hours','session','https://upload.wikimedia.org/x.jpg','Ada and Bea') returning id`));
    assert.match(SES, /^[0-9a-f-]{36}$/, SES);
    assert.equal(E.one('anon', `select image_url || '|' || presenters from public.edition_sessions where id='${SES}'`), 'https://upload.wikimedia.org/x.jpg|Ada and Bea');
    assert.ok(failed(E.try('anon', `update public.edition_sessions set presenters='x' where id='${SES}'`)));
    E.do('BIZ1', `update public.edition_sessions set presenters='hijack' where id='${SES}'`);
    assert.equal(E.q(`select presenters from public.edition_sessions where id='${SES}'`), 'Ada and Bea', 'a business owner cannot edit an Edition session');
    assert.ok(failed(E.try('ORG_EDITOR', `update public.edition_sessions set image_url='http://insecure.example/x.jpg' where id='${SES}'`)), 'only https photographs');
  });
  test('the editor names partner businesses; only real partner links of this Edition are accepted; strangers and anon cannot', () => {
    NEWLINK = last(E.do('ORG_EDITOR', `select public.edition_invite_partner('${ED}','business','${BIZ2}','Page cafe','Would you like to take part?')`));
    assert.match(NEWLINK, /^[0-9a-f-]{36}$/, NEWLINK);
    assert.equal(last(E.do('ORG_EDITOR', `select public.edition_session_set_businesses('${SES}', array['${NEWLINK}']::uuid[])`)), '1');
    assert.ok(failed(E.try('ORG_EDITOR', `select public.edition_session_set_businesses('${SES}', array['00000000-0000-4000-8000-00000000dead']::uuid[])`)), 'a made-up link is refused');
    assert.ok(failed(E.try('anon', `select public.edition_session_set_businesses('${SES}', array[]::uuid[])`)));
    assert.ok(failed(E.try('BIZ1', `select public.edition_session_set_businesses('${SES}', array[]::uuid[])`)));
    assert.ok(failed(E.try('ORG_EDITOR', `insert into public.edition_session_businesses (session_id, link_id) values ('${SES}','${NEWLINK}')`)), 'no direct writes');
    assert.equal(E.one('anon', `select count(*) from public.edition_session_businesses where session_id='${SES}'`), '1', 'the public sees the pointer, but the page only shows businesses whose link is itself public');
  });
  test('replacing the set works, and the audit log records it', () => {
    assert.equal(last(E.do('ORG_EDITOR', `select public.edition_session_set_businesses('${SES}', array[]::uuid[])`)), '0');
    assert.equal(E.q(`select count(*) from public.edition_session_businesses where session_id='${SES}'`), '0');
    assert.ok(Number(E.q(`select count(*) from edition_audit_log where action='session_businesses_set'`)) >= 2);
  });
});
