/**
 * fetch-v2-flag.node.test.ts — the Fetch v2 feature flag (migration 20261127000000), against the real SQL.
 *
 * WHAT IT PROVES (every earlier migration replayed into a private database, then the flag migration applied):
 *   · the default is off, and off means nobody — not admins, not testers, not anon;
 *   · each audience (admins / testers / everyone) admits exactly the right callers, by the database's own answer;
 *   · testers are the ENABLED testers of the 'fetch-v2' Launch Test Centre programme only — not disabled ones, not deleted accounts,
 *     not testers of another programme;
 *   · any unrecognised audience value fails closed; case and whitespace are tolerated;
 *   · fetch_v2_require() is the server gate: it raises 42501 for everyone the flag excludes;
 *   · clients can ask about themselves (fetch_v2_enabled) but never about another user (fetch_v2_enabled_for), and cannot change the switch;
 *   · the migration changes nothing about current Fetch (policies, triggers and grants on the Fetch tables are identical before and after);
 *   · mutation controls: loosening each protection makes the matching check fail.
 *
 * SAFETY — ISOLATED DATABASE ONLY (PASS_PROOF_DSN). Fake users; nothing near production.
 * Run: ISOLATED_ONLY=fetch-v2-flag npm run test:isolated
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayDb, type ReplayDb } from './_support/replay-db.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIX_NAME = '20261127000000_fetch_v2_feature_flag.sql';
const FIX = join(REPO_ROOT, 'supabase/migrations', FIX_NAME);

let db: ReplayDb;
const tag = /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|DO|GRANT|REVOKE|COMMENT|CREATE .*|DROP .*|ALTER .*|INSERT \d+ \d+|UPDATE \d+|DELETE \d+)$/;
const rowsOf = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && !tag.test(l) && !/^ERROR|^psql:|^LINE |^\s*\^|^DETAIL|^HINT|^CONTEXT/.test(l));
const lastRow = (o: string) => rowsOf(o).pop() ?? '';
const scalar = (sql: string) => lastRow(db.raw(sql));

const ids = {
  ADMIN: 'ad000000-0000-4000-8000-0000000000ad',
  TESTER: 'a1000000-0000-4000-8000-000000000001',
  DISABLED: 'd1000000-0000-4000-8000-000000000002',
  OTHERPROG: 'b1000000-0000-4000-8000-000000000003',
  MEMBER: 'e1000000-0000-4000-8000-000000000004',
  GONE: 'f1000000-0000-4000-8000-000000000005',
} as const;
type Who = keyof typeof ids | 'anon';
const WHO: Who[] = ['anon', 'ADMIN', 'TESTER', 'DISABLED', 'OTHERPROG', 'MEMBER', 'GONE'];
const roleSql = (w: Who) => (w === 'anon' ? 'set local role anon;' : `set local request.jwt.claim.sub = '${ids[w]}'; set local role authenticated;`);
const tryAs = (w: Who, sql: string) => db.raw(`begin; ${roleSql(w)} ${sql}; rollback;`);
const doAs = (w: Who, sql: string) => db.raw(`begin; ${roleSql(w)} ${sql}; commit;`);
const denied = (o: string) => /permission denied/i.test(o);

const setAudience = (v: string) => { const o = db.raw(`update public.admin_config set value = '${v}' where key = 'fetch.v2.audience'`); assert.doesNotMatch(o, /ERROR/, o); };
const enabled = (w: Who) => lastRow(tryAs(w, 'select public.fetch_v2_enabled()'));
const requireOut = (w: Who) => tryAs(w, 'select public.fetch_v2_require()');
const admitted = () => WHO.filter((w) => enabled(w) === 't');

// The Fetch tables' security surface, so we can prove the flag migration leaves current Fetch alone.
const FETCH_TABLES = `'delivery_requests','runs','driver_profiles','waiting_events','delivery_pricing_config','fetch_authorisation_attempts','fetch_authorisation_generations'`;
const fetchSurface = () => scalar(`select md5(string_agg(x, '|' order by x)) from (
    select 'pol:' || tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual,'') || ':' || coalesce(with_check,'') x from pg_policies where schemaname='public' and tablename in (${FETCH_TABLES})
    union all select 'trg:' || c.relname || ':' || t.tgname || ':' || pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid where not t.tgisinternal and c.relname in (${FETCH_TABLES})
    union all select 'acl:' || c.relname || ':' || coalesce(c.relacl::text,'') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (${FETCH_TABLES})
  ) s`);

const S: Record<string, string> = {};

before(() => {
  db = createReplayDb('fetchv2flag', { stopBefore: FIX_NAME });
  const all = Object.values(ids).map((i) => `'${i}'::uuid`).join(',');
  const seed = db.raw(`
    insert into auth.users (id, email) select x, 'u' || substr(x::text,1,4) || '@example.org' from unnest(array[${all}]) x on conflict do nothing;
    insert into public.profiles (id, full_name) select x, 'Fixture ' || substr(x::text,1,4) from unnest(array[${all}]) x on conflict (id) do nothing;
    update public.profiles set role = 'admin' where id = '${ids.ADMIN}';`);
  assert.doesNotMatch(seed, /ERROR/, seed);
  S.surfaceBefore = fetchSurface();
  S.apply = db.rawFile(FIX);
  assert.doesNotMatch(S.apply, /ERROR/, S.apply);
  S.surfaceAfter = fetchSurface();

  // Testers are managed through the real Launch Test Centre admin functions — no special path for Fetch.
  const prog = scalar(`select id from public.launch_test_programmes where slug = 'fetch-v2'`);
  const other = scalar(`insert into public.launch_test_programmes (slug, name, status) values ('other-prog', 'Other programme', 'active') returning id`);
  const add = (p: string, w: Who) => lastRow(doAs('ADMIN', `select public.launch_test_admin_add_tester('${p}', 'u${ids[w as keyof typeof ids].slice(0, 4)}@example.org', '{}', null)`));
  add(prog, 'TESTER');
  const dis = add(prog, 'DISABLED');
  doAs('ADMIN', `select public.launch_test_admin_update_tester('${dis}', false, null, 'left')`);
  add(other, 'OTHERPROG');
  add(prog, 'GONE');
  db.raw(`update auth.users set deleted_at = now() where id = '${ids.GONE}'`);
  S.testers = scalar(`select count(*) from public.launch_testers t join public.launch_test_programmes g on g.id = t.programme_id where g.slug = 'fetch-v2'`);
});
after(() => { db?.drop(); });

describe('0 · the migration', () => {
  test('applies clean, seeds the switch at off and a draft fetch-v2 programme', () => {
    assert.equal(scalar(`select value || ':' || category from public.admin_config where key = 'fetch.v2.audience'`), 'off:fetch');
    assert.equal(scalar(`select status from public.launch_test_programmes where slug = 'fetch-v2'`), 'draft');
    assert.equal(S.testers, '3', 'TESTER, DISABLED and GONE were added to fetch-v2');
  });
  test('changes nothing about current Fetch: policies, triggers and grants on the Fetch tables are identical', () => {
    assert.ok(S.surfaceBefore && S.surfaceBefore.length === 32);
    assert.equal(S.surfaceAfter, S.surfaceBefore);
  });
  test('re-applying is harmless and does not reset a changed audience', () => {
    setAudience('testers');
    const again = db.rawFile(FIX);
    assert.doesNotMatch(again, /ERROR/, again);
    assert.equal(scalar(`select value from public.admin_config where key = 'fetch.v2.audience'`), 'testers');
    assert.equal(scalar(`select count(*) from public.launch_test_programmes where slug = 'fetch-v2'`), '1');
    setAudience('off');
  });
});

describe('1 · audiences', () => {
  test('off (the default): nobody, not even an administrator', () => {
    setAudience('off');
    assert.deepEqual(admitted(), []);
  });
  test('admins: administrators only', () => {
    setAudience('admins');
    assert.deepEqual(admitted(), ['ADMIN']);
  });
  test('testers: administrators and ENABLED fetch-v2 testers with live accounts — not disabled, deleted or other-programme testers', () => {
    setAudience('testers');
    assert.deepEqual(admitted(), ['ADMIN', 'TESTER']);
  });
  test('everyone: every caller, signed in or not', () => {
    setAudience('everyone');
    assert.deepEqual(admitted(), WHO);
  });
  test('a tester disabled through the Test Centre loses access immediately', () => {
    setAudience('testers');
    const t = scalar(`select t.id from public.launch_testers t join public.launch_test_programmes g on g.id=t.programme_id where g.slug='fetch-v2' and t.user_id='${ids.TESTER}'`);
    doAs('ADMIN', `select public.launch_test_admin_update_tester('${t}', false, null, 'paused')`);
    assert.equal(enabled('TESTER'), 'f');
    doAs('ADMIN', `select public.launch_test_admin_update_tester('${t}', true, null, 'back')`);
    assert.equal(enabled('TESTER'), 't');
  });
  test('unrecognised values fail closed; case and whitespace are tolerated', () => {
    for (const v of ['', 'on', 'true', 'all', 'tester', 'everyone please']) {
      setAudience(v);
      assert.equal(scalar('select public.fetch_v2_audience()'), 'off', `value ${JSON.stringify(v)}`);
      assert.deepEqual(admitted(), [], `value ${JSON.stringify(v)}`);
    }
    setAudience('  Testers ');
    assert.equal(scalar('select public.fetch_v2_audience()'), 'testers');
    setAudience('off');
  });
  test('a missing switch row is off', () => {
    const o = db.raw(`begin; delete from public.admin_config where key = 'fetch.v2.audience';
      select public.fetch_v2_audience() || ':' || public.fetch_v2_enabled_for('${ids.ADMIN}')::text; rollback;`);
    assert.equal(lastRow(o), 'off:false');
  });
});

describe('2 · the server gate', () => {
  test('fetch_v2_require raises 42501 "Fetch is not available" for every excluded caller', () => {
    setAudience('testers');
    for (const w of ['MEMBER', 'DISABLED', 'OTHERPROG', 'GONE'] as Who[]) {
      const o = requireOut(w);
      assert.match(o, /ERROR:\s+Fetch is not available/, `${w}: ${o}`);
    }
    assert.ok(denied(requireOut('anon')), 'anon cannot even call the gate (Fetch v2 actions need a member)');
  });
  test('fetch_v2_require passes silently for admitted callers', () => {
    setAudience('testers');
    for (const w of ['ADMIN', 'TESTER'] as Who[]) assert.doesNotMatch(requireOut(w), /ERROR/, w);
    setAudience('off');
    assert.match(requireOut('ADMIN'), /Fetch is not available/);
  });
  test('the error code is 42501 (insufficient_privilege), as other server gates use', () => {
    setAudience('off');
    const o = tryAs('MEMBER', `do $$ begin perform public.fetch_v2_require(); exception when insufficient_privilege then raise notice 'code-ok'; end $$`);
    assert.match(o, /code-ok/);
  });
});

describe('3 · what clients may ask and change', () => {
  test('clients can ask about themselves', () => {
    for (const w of ['anon', 'MEMBER'] as Who[]) assert.ok(!denied(tryAs(w, 'select public.fetch_v2_enabled()')), w);
  });
  test('clients cannot ask about anyone else, or read the raw audience', () => {
    for (const w of ['anon', 'MEMBER', 'TESTER', 'ADMIN'] as Who[]) {
      assert.ok(denied(tryAs(w, `select public.fetch_v2_enabled_for('${ids.ADMIN}')`)), `${w} enabled_for`);
      assert.ok(denied(tryAs(w, 'select public.fetch_v2_audience()')), `${w} audience`);
    }
  });
  test('only an administrator can change the switch; members and anon cannot', () => {
    setAudience('off');
    for (const w of ['anon', 'MEMBER', 'TESTER'] as Who[]) {
      tryAs(w, `update public.admin_config set value = 'everyone' where key = 'fetch.v2.audience'`);
      doAs(w, `update public.admin_config set value = 'everyone' where key = 'fetch.v2.audience'`);
      assert.equal(scalar(`select value from public.admin_config where key = 'fetch.v2.audience'`), 'off', w);
    }
    doAs('ADMIN', `update public.admin_config set value = 'admins' where key = 'fetch.v2.audience'`);
    assert.equal(scalar(`select value from public.admin_config where key = 'fetch.v2.audience'`), 'admins');
    setAudience('off');
  });
  test('a non-admin cannot read the switch row either', () => {
    assert.equal(lastRow(tryAs('MEMBER', `select count(*) from public.admin_config where key = 'fetch.v2.audience'`)), '0');
  });
  test('a tester cannot add themselves (or anyone) to the fetch-v2 programme', () => {
    const prog = scalar(`select id from public.launch_test_programmes where slug = 'fetch-v2'`);
    const o = tryAs('MEMBER', `select public.launch_test_admin_add_tester('${prog}', 'u${ids.MEMBER.slice(0, 4)}@example.org', '{}', null)`);
    assert.match(o, /ERROR/);
    const direct = tryAs('MEMBER', `insert into public.launch_testers (programme_id, user_id) values ('${prog}', '${ids.MEMBER}')`);
    assert.match(direct, /ERROR/);
  });
});

describe('4 · mutation controls (each loosened protection is caught)', () => {
  const mutated = (body: string, check: string) => db.raw(`begin;
    create or replace function public.fetch_v2_enabled_for(p_user uuid) returns boolean
      language plpgsql stable security definer set search_path = public, pg_temp as $f$ ${body} $f$;
    update public.admin_config set value = 'testers' where key = 'fetch.v2.audience';
    ${check}; rollback;`);
  const asWho = (w: Who) => `${roleSql(w)} select public.fetch_v2_enabled()`;

  test('without the enabled check, a disabled tester gets in — the testers assertion would fail', () => {
    const o = mutated(`begin return exists (select 1 from public.launch_testers t join public.launch_test_programmes g on g.id = t.programme_id
      where g.slug = 'fetch-v2' and t.user_id = p_user); end;`, asWho('DISABLED'));
    assert.equal(lastRow(o), 't');
  });
  test('without the programme check, another programme\'s tester gets in', () => {
    const o = mutated(`begin return exists (select 1 from public.launch_testers t where t.user_id = p_user and t.enabled); end;`, asWho('OTHERPROG'));
    assert.equal(lastRow(o), 't');
  });
  test('failing open on an unknown value would admit a member', () => {
    const o = db.raw(`begin;
      create or replace function public.fetch_v2_audience() returns text language sql stable security definer set search_path = public, pg_temp
        as $f$ select coalesce((select value from public.admin_config where key = 'fetch.v2.audience'), 'off') $f$;
      create or replace function public.fetch_v2_enabled_for(p_user uuid) returns boolean language sql stable security definer set search_path = public, pg_temp
        as $f$ select public.fetch_v2_audience() <> 'off' $f$;
      update public.admin_config set value = 'on' where key = 'fetch.v2.audience';
      ${asWho('MEMBER')}; rollback;`);
    assert.equal(lastRow(o), 't');
  });
  test('granting fetch_v2_enabled_for to clients would let a member probe the administrator', () => {
    const o = db.raw(`begin; grant execute on function public.fetch_v2_enabled_for(uuid) to authenticated;
      update public.admin_config set value = 'admins' where key = 'fetch.v2.audience';
      ${roleSql('MEMBER')} select public.fetch_v2_enabled_for('${ids.ADMIN}'); rollback;`);
    assert.equal(lastRow(o), 't');
  });
});
