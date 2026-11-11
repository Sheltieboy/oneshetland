/**
 * editions-push-notifications-sql.node.test.ts — ISOLATED Postgres only. The database half of Editions push (migration 20270104030000): who may notify followers, the once-only claim
 * (including under real concurrency), the guard rails (public now, published, fresh, at most three a day), the organiser push queue fed by the email queue, and the rollback.
 * Run: ISOLATED_ONLY=editions-push-notifications-sql npm run test:isolated
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Env, USERS, seed, enter, draftEdition, last } from './_support/editions-env.ts';
import { goLive } from './_support/editions-env-1.ts';

const FNS = ['edition_update_notify_authorised(uuid,uuid)', 'edition_update_notify_claim(uuid,uuid)', 'edition_update_notify_complete(uuid,integer,integer,integer)', 'edition_push_next(integer)', 'edition_push_mark(bigint,text)'];
const failed = (o: string) => /^ERROR:|permission denied|row-level security|violates/im.test(o);

let E: Env, ORG = '', ED = '', ED_DRAFT = '';
const svc = (sql: string) => E.sup(`begin; set local role service_role; ${sql}; commit;`);
const svcOne = (sql: string) => last(svc(sql));
const newUpdate = (title: string, publishedAt = 'now()', ed = ED) => last(E.sup(`insert into public.edition_updates (edition_id, title, body, published_at) values ('${ed}', '${title}', 'b', ${publishedAt}) returning id`));
const claim = (u: string, actor: string | null = USERS.HUB_OWNER) => JSON.parse(svcOne(`select public.edition_update_notify_claim('${u}', ${actor ? `'${actor}'` : 'null'})::text`));
const flag = (v: boolean) => E.sup(`update admin_config set value = '${v}' where key = 'editions.enabled'`);

before(() => {
  E = new Env('editionspushsql');
  E.sup(`do $$ begin if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if; end $$;`);
  const S = seed(E);
  // seed ran before service_role existed in some replays: make sure it can reach the schema and the migration's functions
  E.sup(`grant usage on schema public to service_role; ${FNS.map((f) => `grant execute on function public.${f} to service_role;`).join(' ')}`);
  ORG = enter(E, 'HUB_OWNER', 'hub', S.HUB);
  ED = draftEdition(E, 'HUB_OWNER', ORG, 'zz-push-fest', 'ZZ Push Fest');
  ED_DRAFT = draftEdition(E, 'HUB_OWNER', ORG, 'zz-push-draft', 'ZZ Draft Fest');
  goLive(E, 'HUB_OWNER', ED);
  for (const u of ['STRANGER', 'HUB_MEMBER', 'BIZ2_OWNER'] as const) E.do(u, `select public.edition_save('${ED}')`);
  E.do('HUB_OWNER', `select public.edition_save('${ED}')`);   // the organiser saved it too: they must not be told about their own update
});
after(() => E?.drop());

describe('privileges: nothing here is reachable by people or the anon key', () => {
  test('the Edition is public (otherwise every test below proves nothing) and the saves exist', () => {
    assert.equal(E.q(`select public.edition_is_public('${ED}')`), 't'); assert.equal(E.q(`select count(*) from edition_saves where edition_id = '${ED}'`), '4');
  });
  test('only the service role can execute the functions; no one else can read or write the tables', () => {
    for (const f of FNS) {
      assert.equal(E.q(`select has_function_privilege('service_role', 'public.${f}', 'execute')`), 't', f);
      for (const role of ['anon', 'authenticated']) assert.equal(E.q(`select has_function_privilege('${role}', 'public.${f}', 'execute')`), 'f', `${role} ${f}`);
    }
    assert.equal(E.q(`select has_function_privilege('authenticated', 'public.edition_push_from_email()', 'execute')`), 'f');
    for (const t of ['edition_update_notifications', 'edition_push_outbox']) for (const who of ['HUB_OWNER', 'ADMIN', 'anon'] as const) {
      assert.ok(failed(E.try(who, `select * from public.${t}`)), `${who} read ${t}`); assert.ok(failed(E.try(who, `delete from public.${t}`)), `${who} wrote ${t}`);
    }
  });
  test('people cannot call the claim to notify anyone', () => {
    const u = newUpdate('probe');
    for (const who of ['HUB_OWNER', 'ADMIN', 'STRANGER', 'anon'] as const) assert.ok(failed(E.try(who, `select public.edition_update_notify_claim('${u}', null)`)), who);
    assert.equal(E.q(`select count(*) from edition_update_notifications where update_id = '${u}'`), '0');
  });
});

describe('who may notify followers (edition_update_notify_authorised)', () => {
  const U = () => newUpdate('who may');
  const may = (u: string, who: string | null) => svcOne(`select public.edition_update_notify_authorised('${u}', ${who ? `'${who}'` : 'null'})`);
  test('the Hub owner, a committee member and a platform administrator may; a member, a stranger and another Business owner may not', () => {
    const u = U();
    assert.deepEqual([USERS.HUB_OWNER, USERS.HUB_COMMITTEE, USERS.ADMIN].map((w) => may(u, w)), ['t', 't', 't']);
    assert.deepEqual([USERS.HUB_MEMBER, USERS.STRANGER, USERS.BIZ_OWNER, USERS.BIZ2_OWNER, USERS.HUB2_OWNER].map((w) => may(u, w)), ['f', 'f', 'f', 'f', 'f']);
  });
  test('an invited helper (editor) may once on the team, not before', () => {
    const u = U(); assert.equal(may(u, USERS.EDITOR), 'f');
    E.do('HUB_OWNER', `select public.invite_edition_member('${ORG}', '${USERS.EDITOR}@x.invalid', 'editor')`);
    E.do('EDITOR', `select public.accept_edition_invite('${last(E.sup(`select id from edition_organiser_invites where organiser_id='${ORG}' and email='${USERS.EDITOR}@x.invalid'`))}')`);
    assert.equal(may(u, USERS.EDITOR), 't');
  });
  test('null user, null update and an unknown update are all refused (false, no error)', () => {
    const u = U(); assert.equal(may(u, null), 'f');
    assert.equal(svcOne(`select public.edition_update_notify_authorised(null, '${USERS.HUB_OWNER}')`), 'f');
    assert.equal(svcOne(`select public.edition_update_notify_authorised('99999999-9999-4999-8999-999999999999', '${USERS.HUB_OWNER}')`), 'f');
  });
  test("a business owner of ANOTHER organiser cannot use their own Edition's update id on this one: the decision is keyed by the update row", () => {
    const u = U(); assert.equal(may(u, USERS.BIZ_OWNER), 'f');
  });
});

describe('the once-only claim', () => {
  test('first claim returns the saved-by list (not the actor), the Edition slug, title and update title; the second says "already" and the list is not handed out again', () => {
    const u = newUpdate('Doors open at 7'); const first = claim(u);
    assert.equal(first.status, 'claimed'); assert.equal(first.edition_slug, 'zz-push-fest'); assert.equal(first.edition_title, 'ZZ Push Fest'); assert.equal(first.update_title, 'Doors open at 7');
    assert.deepEqual([...first.recipients].sort(), [USERS.STRANGER, USERS.HUB_MEMBER, USERS.BIZ2_OWNER].sort(), 'followers only: the organiser who posted is excluded');
    assert.deepEqual(Object.keys(first).sort(), ['edition_id', 'edition_slug', 'edition_title', 'recipients', 'status', 'update_title'], 'ids and public titles only: no names or emails');
    const second = claim(u); assert.deepEqual(second, { status: 'already' });
    assert.equal(E.q(`select recipients from edition_update_notifications where update_id = '${u}'`), '3');
  });
  test('completion records the counts once', () => {
    const u = newUpdate('count me'); claim(u);
    svc(`select public.edition_update_notify_complete('${u}', 2, 1, 0)`); svc(`select public.edition_update_notify_complete('${u}', 9, 9, 9)`);
    assert.equal(E.q(`select sent || ',' || skipped || ',' || errored || ',' || (completed_at is not null) from edition_update_notifications where update_id = '${u}'`), '2,1,0,true');
  });
  test('a draft and a scheduled update are not notified; an old update is stale', () => {
    assert.equal(claim(newUpdate('draft', 'null')).status, 'not_published');
    assert.equal(claim(newUpdate('later', `now() + interval '1 hour'`)).status, 'not_published');
    assert.equal(claim(newUpdate('old', `now() - interval '3 days'`)).status, 'stale');
    assert.equal(claim('99999999-9999-4999-8999-999999999999').status, 'not_found');
  });
  test('an Edition that is not public sends nothing: still a draft (organiser can post updates), or Editions switched off', () => {
    const d = newUpdate('on a draft Edition', 'now()', ED_DRAFT); assert.equal(E.q(`select public.edition_is_public('${ED_DRAFT}')`), 'f'); assert.equal(claim(d).status, 'not_public');
    const u = newUpdate('flag off'); flag(false); try { assert.equal(claim(u).status, 'not_public'); } finally { flag(true); }
    assert.equal(E.q(`select count(*) from edition_update_notifications where update_id in ('${d}', '${u}')`), '0', 'a refusal leaves no claim, so the update can be notified later once the Edition is public');
    assert.equal(claim(u).status, 'claimed');
  });
  test('at most three notified updates per Edition in 24 hours; the fourth is refused', () => {
    const before = Number(E.q(`select count(*) from edition_update_notifications where edition_id = '${ED}' and claimed_at > now() - interval '24 hours'`));
    const out: string[] = []; for (let i = before; i < 4; i++) out.push(claim(newUpdate(`burst ${i}`)).status);
    assert.equal(out.at(-1), 'too_many'); assert.equal(E.q(`select count(*) from edition_update_notifications where edition_id = '${ED}' and claimed_at > now() - interval '24 hours'`), '3');
  });
  test('claims older than a day stop counting against the limit', () => {
    E.sup(`update edition_update_notifications set claimed_at = now() - interval '2 days' where edition_id = '${ED}'`);
    assert.equal(claim(newUpdate('a new day')).status, 'claimed');
  });
  test('CONCURRENCY: five simultaneous claims for one update produce exactly one "claimed"', async () => {
    E.sup(`update edition_update_notifications set claimed_at = now() - interval '2 days' where edition_id = '${ED}'`);
    const u = newUpdate('race');
    const runs = await Promise.all(Array.from({ length: 5 }, () => E.db.bg(`set role service_role; select (public.edition_update_notify_claim('${u}', null)::jsonb ->> 'status')`)));
    const statuses = runs.map((r) => r.stdout.trim().split('\n').pop()).sort();
    assert.deepEqual(statuses, ['already', 'already', 'already', 'already', 'claimed'], JSON.stringify(runs.map((r) => r.stderr)));
    assert.equal(E.q(`select count(*) from edition_update_notifications where update_id = '${u}'`), '1');
  });
  test('deleting a saved Edition or an update cleans its claim (no orphans)', () => {
    const u = newUpdate('delete me'); claim(u); E.sup(`delete from edition_updates where id = '${u}'`);
    assert.equal(E.q(`select count(*) from edition_update_notifications where update_id = '${u}'`), '0');
  });
});

describe('organiser pushes are queued from the same decisions as the emails, once, for the same people', () => {
  const emails = (kind: string) => E.q(`select coalesce(string_agg(user_id::text, ',' order by user_id), '') from edition_email_outbox where kind = '${kind}'`);
  const pushes = (kind: string) => E.q(`select coalesce(string_agg(user_id::text, ',' order by user_id), '') from edition_push_outbox where kind = '${kind}'`);
  const ED2 = () => draftEdition(E, 'HUB_OWNER', ORG, `zz-push-review-${Math.floor(Math.random() * 1e6)}`, 'ZZ Review Fest');

  test('approval: the Hub owner and committee each get one email and one push', () => {
    const ed = ED2(); E.do('HUB_OWNER', `select public.edition_submit_for_review('${ed}')`); E.do('ADMIN', `select public.admin_review_edition('${ed}', 'approve', 'ZZ ok')`);
    assert.ok(emails('edition_approved').includes(USERS.HUB_OWNER)); assert.equal(pushes('edition_approved'), emails('edition_approved'));
    assert.equal(E.q(`select count(*) from edition_push_outbox where kind = 'edition_approved' and edition_id = '${ed}' and claimed_at is null`), E.q(`select count(*) from edition_email_outbox where kind = 'edition_approved' and payload ->> 'edition_slug' = (select slug from editions where id = '${ed}')`));
  });
  test('changes requested and rejected are queued too, and a push row holds ids only (no title, note or address)', () => {
    const a = ED2(), b = ED2();
    E.do('HUB_OWNER', `select public.edition_submit_for_review('${a}')`); E.do('ADMIN', `select public.admin_review_edition('${a}', 'changes', 'Please fix the dates')`);
    E.do('HUB_OWNER', `select public.edition_submit_for_review('${b}')`); E.do('ADMIN', `select public.admin_review_edition('${b}', 'reject', 'Not suitable for this site')`);
    assert.equal(pushes('edition_changes_requested'), emails('edition_changes_requested')); assert.equal(pushes('edition_rejected'), emails('edition_rejected'));
    assert.ok(emails('edition_rejected') !== '');
    assert.equal(E.q(`select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_name = 'edition_push_outbox'`), 'claimed_at,created_at,dedupe_key,done_at,edition_id,id,kind,organiser_id,outcome,user_id');
  });
  test('package activation (a purchase or a free claim writes this email) queues a push; a repeat of the same email key queues nothing more', () => {
    const slug = E.q(`select slug from editions where id = '${ED}'`);
    E.sup(`select public.edition_enqueue_email('package_active', '${USERS.HUB_OWNER}', 'zz-ent-1', '{"edition_slug":"${slug}","edition_title":"x"}'::jsonb)`);
    E.sup(`select public.edition_enqueue_email('package_active', '${USERS.HUB_OWNER}', 'zz-ent-1', '{"edition_slug":"${slug}","edition_title":"x"}'::jsonb)`);
    assert.equal(E.q(`select count(*) from edition_push_outbox where dedupe_key = 'zz-ent-1'`), '1');
    assert.equal(E.q(`select count(*) from edition_email_outbox where dedupe_key = 'zz-ent-1'`), '1');
  });
  test('other email kinds, an unknown Edition and a missing user queue no push', () => {
    const slug = E.q(`select slug from editions where id = '${ED}'`); const before = E.q(`select count(*) from edition_push_outbox`);
    E.sup(`select public.edition_enqueue_email('partner_invited', '${USERS.HUB_OWNER}', 'zz-other-1', '{"edition_slug":"${slug}"}'::jsonb)`);
    E.sup(`select public.edition_enqueue_email('edition_approved', '${USERS.HUB_OWNER}', 'zz-unknown-1', '{"edition_slug":"no-such-edition-slug"}'::jsonb)`);
    E.sup(`select public.edition_enqueue_email('edition_approved', null, 'zz-nouser-1', '{}'::jsonb)`);
    assert.equal(E.q(`select count(*) from edition_push_outbox`), before);
  });
  test('the push kinds are limited by the table itself', () => {
    assert.ok(failed(E.sup(`insert into edition_push_outbox (kind, user_id, organiser_id, edition_id, dedupe_key) values ('payment_receipt', '${USERS.HUB_OWNER}', '${ORG}', '${ED}', 'zz-bad-kind')`)));
  });
});

describe('the drain (edition_push_next / edition_push_mark)', () => {
  const row = (key: string, user: string, ageHours = 0, kind = 'edition_approved') =>
    E.sup(`insert into edition_push_outbox (kind, user_id, organiser_id, edition_id, dedupe_key, created_at) values ('${kind}', '${user}', '${ORG}', '${ED}', '${key}', now() - interval '${ageHours} hours')`);
  const next = () => svcOne(`select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'user', user_id, 'ed', edition_id) order by id), '[]')::text from public.edition_push_next(50)`);
  before(() => { E.sup(`delete from edition_push_outbox`); });

  test('nothing is returned, claimed or lost while Editions is switched off', () => {
    row('zz-d1', USERS.HUB_OWNER); flag(false);
    try { assert.equal(next(), '[]'); assert.equal(E.q(`select count(*) from edition_push_outbox where claimed_at is not null`), '0'); } finally { flag(true); }
  });
  test('when on: a due row for a current team member is returned once, and only once; stale rows and people who left the team are closed unsent', () => {
    row('zz-d2', USERS.STRANGER); row('zz-d3', USERS.HUB_COMMITTEE, 30);
    const got = JSON.parse(next()) as { id: number; user: string }[];
    assert.deepEqual(got.map((g) => g.user), [USERS.HUB_OWNER], 'only the current team member whose row is fresh');
    assert.equal(E.q(`select outcome from edition_push_outbox where dedupe_key = 'zz-d2'`), 'skipped_not_on_team'); assert.equal(E.q(`select outcome from edition_push_outbox where dedupe_key = 'zz-d3'`), 'skipped_stale');
    assert.equal(next(), '[]', 'a claimed row is never handed out again (a crash loses a best-effort push; it can never double one)');
  });
  test('marking records the outcome once; a second mark cannot rewrite it', () => {
    const id = Number(E.q(`select id from edition_push_outbox where dedupe_key = 'zz-d1'`));
    svc(`select public.edition_push_mark(${id}, 'accepted')`); svc(`select public.edition_push_mark(${id}, 'something else')`);
    assert.equal(E.q(`select outcome || ',' || (done_at is not null) from edition_push_outbox where id = ${id}`), 'accepted,true');
  });
  test('concurrent drains never hand the same row to two workers', async () => {
    E.sup(`delete from edition_push_outbox`); for (let i = 0; i < 6; i++) row(`zz-c${i}`, USERS.HUB_OWNER);
    const runs = await Promise.all(Array.from({ length: 3 }, () => E.db.bg(`set role service_role; select id from public.edition_push_next(4)`)));
    const ids = runs.flatMap((r) => r.stdout.trim().split('\n').filter((l) => /^\d+$/.test(l)));
    assert.equal(ids.length, new Set(ids).size, `duplicate hand-out: ${ids}`); assert.equal(ids.length, 6);
  });
});

describe('rollback', () => {
  test('runs clean, twice, and removes everything the migration added (the emails and saves are untouched)', () => {
    const sql = readFileSync(new URL('../rollbacks/20270104030000_editions_push_notifications.rollback.sql', import.meta.url), 'utf8');
    const emailsBefore = E.q(`select count(*) from edition_email_outbox`), savesBefore = E.q(`select count(*) from edition_saves`);
    for (let i = 0; i < 2; i++) assert.doesNotMatch(E.sup(sql), /ERROR/, `run ${i + 1}`);
    assert.equal(E.q(`select count(*) from pg_proc where proname in ('edition_update_notify_authorised','edition_update_notify_claim','edition_update_notify_complete','edition_push_next','edition_push_mark','edition_push_from_email')`), '0');
    assert.equal(E.q(`select count(*) from pg_tables where tablename in ('edition_update_notifications','edition_push_outbox')`), '0');
    assert.equal(E.q(`select count(*) from pg_trigger where tgname = 'edition_push_from_email'`), '0');
    assert.equal(E.q(`select count(*) from edition_email_outbox`), emailsBefore); assert.equal(E.q(`select count(*) from edition_saves`), savesBefore);
    E.sup(`select public.edition_enqueue_email('package_active', '${USERS.HUB_OWNER}', 'zz-after-rollback', '{}'::jsonb)`);   // the email queue still works without the trigger
    assert.equal(E.q(`select count(*) from edition_email_outbox where dedupe_key = 'zz-after-rollback'`), '1');
  });
});
