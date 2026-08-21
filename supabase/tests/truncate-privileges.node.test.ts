/**
 * truncate-privileges.node.test.ts — no client role may empty a table.
 *
 * WHY THIS TEST EXISTS
 *
 * Every table in `public` was created carrying the same grant:
 *
 *   anon=arwdDxtm/postgres | authenticated=arwdDxtm/postgres
 *
 * The `D` is TRUNCATE, and 122 of 127 tables handed it to both client roles.
 * Nobody wrote that grant — it comes from a pg_default_acl entry on the schema,
 * so it arrived automatically on every table ever created and would have
 * arrived on every future one.
 *
 * TRUNCATE is not filtered by RLS. Row policies decide which rows a statement
 * may see; TRUNCATE does not read rows, so there is nothing to filter. Proven
 * against production before the fix, on a throwaway table:
 *
 *   authenticated    TRUNCATE SUCCEEDED    rows_left=0
 *   anon             TRUNCATE SUCCEEDED    rows_left=0
 *
 * It was not reachable through the public API — PostgREST answers the TRUNCATE
 * verb with 501, and no client-callable function runs one. It was a loaded
 * privilege with no trigger attached, removed because nothing used it.
 *
 * WHAT IS ASSERTED
 *   · no table in `public` grants TRUNCATE to anon or authenticated — the list
 *     is read from the catalogue at run time, so a table added next month is
 *     covered by this test the day it exists, without editing anything here
 *   · service_role still holds TRUNCATE on every one of them
 *   · the other privileges survived: this was a one-letter change
 *   · a NEWLY CREATED table does not receive TRUNCATE — the default-privilege
 *     fix, re-proven on a real table each run rather than assumed
 *   · attempting it as anon and as authenticated fails with 42501, and DELETE
 *     on the same table still works, so the denial is specific to TRUNCATE
 *   · neither repository contains a TRUNCATE a client could reach
 *
 * THE KNOWN GAP, ASSERTED RATHER THAN ASSUMED AWAY
 *
 * `public` carries a SECOND default-privileges entry whose grantor is
 * `supabase_admin`. This connection is `postgres` — not a superuser, not a
 * member of that role — so it cannot be altered:
 *
 *   ERROR 42501: permission denied to change default privileges
 *
 * Every table in `public` is owned by `postgres`, so nothing here creates
 * tables by that path. The gap cannot be closed from this connection, so the
 * first test below covers it instead: it enumerates tables regardless of who
 * created them, and fails if any of them grants TRUNCATE to a client role.
 * The gap is not sealed. It is alarmed.
 *
 * SAFETY
 * Every table this test creates is made inside a transaction that is never
 * committed, and the final test asserts none of them leaked. No production
 * table is ever truncated: the one TRUNCATE that runs is expected to be
 * refused, and runs against a throwaway table inside that same transaction.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');

const CLIENT_ROLES = ['anon', 'authenticated'] as const;

function runSql(sql: string): string {
  try {
    return execFileSync('npx', ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    throw new Error(`supabase db query failed: ${err.stdout || err.stderr || err.message}`);
  }
}

function rowsOf(out: string): Record<string, unknown>[] {
  const parsed = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (parsed._tag === 'Error' || parsed.error) {
    throw new Error(`supabase db query returned an error: ${JSON.stringify(parsed.error).slice(0, 400)}`);
  }
  return parsed.rows ?? [];
}
const queryAll = (sql: string) => rowsOf(runSql(sql));
const query = (sql: string) => queryAll(sql)[0] ?? {};

/**
 * A transaction that is never committed. The CLI opens a connection per
 * invocation and closes it at the end, and Postgres rolls back whatever is
 * still open — verified directly: after running one of these, the probe table
 * was gone and pg_default_acl was untouched.
 *
 * The final SELECT has to be the last statement because the CLI returns only
 * the last result set, which is also why an explicit ROLLBACK cannot be used
 * here: it would discard the output along with the work.
 */
const rolledBack = (body: string) => `begin;\n${body}`;

// ── 1. Today's tables, enumerated live ──────────────────────────────────────

describe('no client role holds TRUNCATE', () => {
  for (const role of CLIENT_ROLES) {
    test(`${role} cannot TRUNCATE any table in public`, () => {
      // Read from pg_class rather than a hardcoded list: a table created after
      // this test was written is included automatically, whoever created it.
      const offenders = queryAll(`
        select c.relname as tbl, pg_get_userbyid(c.relowner) as owner
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and c.relkind in ('r','p')
           and has_table_privilege('${role}', c.oid, 'TRUNCATE')
         order by c.relname;`);
      assert.deepEqual(offenders, [],
        `${role} can empty ${offenders.length} table(s): ` +
        offenders.map((o) => `${o.tbl} (owned by ${o.owner})`).join(', '));
    });
  }

  test('the inventory is actually being read, not silently empty', () => {
    // Guards the tests above: "no offenders" is only meaningful if tables were
    // examined at all. A broken query returning nothing would otherwise pass.
    const r = query(`
      select count(*)::text as n
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p');`);
    assert.ok(Number(r.n) > 100, `expected the public schema to hold its tables, counted ${r.n}`);
  });

  test('service_role kept TRUNCATE on every table', () => {
    const missing = queryAll(`
      select c.relname as tbl
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p')
         and not has_table_privilege('service_role', c.oid, 'TRUNCATE')
       order by c.relname;`);
    assert.deepEqual(missing, [],
      `service_role lost TRUNCATE on: ${missing.map((m) => m.tbl).join(', ')}`);
  });
});

// ── 2. Nothing else moved ───────────────────────────────────────────────────

describe('only TRUNCATE was taken away', () => {
  test('ordinary tables keep full DML for both client roles', () => {
    // Two representative tables — an ordinary one and a logging one. If the
    // revoke had been written too broadly, this is where it would show.
    const rows = queryAll(`
      select r.rolname as role_name, c.relname as tbl,
             has_table_privilege(r.rolname, c.oid, 'SELECT')::text as sel,
             has_table_privilege(r.rolname, c.oid, 'INSERT')::text as ins,
             has_table_privilege(r.rolname, c.oid, 'UPDATE')::text as upd,
             has_table_privilege(r.rolname, c.oid, 'DELETE')::text as del
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        cross join (select rolname from pg_roles where rolname in ('anon','authenticated')) r
       where n.nspname = 'public' and c.relname in ('driver_profiles','analytics_events')
       order by c.relname, r.rolname;`);
    assert.equal(rows.length, 4, 'expected two tables × two client roles');
    for (const r of rows) {
      for (const p of ['sel', 'ins', 'upd', 'del'] as const) {
        assert.equal(r[p], 'true', `${r.role_name} lost ${p.toUpperCase()} on ${r.tbl} — the revoke was too broad`);
      }
    }
  });

  test('the wallet tables keep the tighter grants Step 6 gave them', () => {
    // local_wallet_balances is deliberately SELECT-only for client roles:
    // balances move through the ledger functions, never by direct write. This
    // asserts the TRUNCATE work neither loosened nor tightened that.
    const rows = queryAll(`
      select r.rolname as role_name,
             has_table_privilege(r.rolname,'public.local_wallet_balances','SELECT')::text   as sel,
             has_table_privilege(r.rolname,'public.local_wallet_balances','INSERT')::text   as ins,
             has_table_privilege(r.rolname,'public.local_wallet_balances','UPDATE')::text   as upd,
             has_table_privilege(r.rolname,'public.local_wallet_balances','DELETE')::text   as del,
             has_table_privilege(r.rolname,'public.local_wallet_balances','TRUNCATE')::text as trunc
        from (select rolname from pg_roles where rolname in ('anon','authenticated')) r
       order by r.rolname;`);
    for (const r of rows) {
      assert.equal(r.sel, 'true', `${r.role_name} lost SELECT on local_wallet_balances`);
      assert.equal(r.ins, 'false', `${r.role_name} gained INSERT on local_wallet_balances`);
      assert.equal(r.upd, 'false', `${r.role_name} gained UPDATE on local_wallet_balances`);
      assert.equal(r.del, 'false', `${r.role_name} gained DELETE on local_wallet_balances`);
      assert.equal(r.trunc, 'false', `${r.role_name} can empty the wallet balances table`);
    }
  });
});

// ── 3. Tomorrow's tables ────────────────────────────────────────────────────

describe('a newly created table does not arrive with TRUNCATE', () => {
  test('the default privileges on public no longer carry D for client roles', () => {
    const rows = queryAll(`
      select pg_get_userbyid(d.defaclrole) as grantor,
             array_to_string(d.defaclacl, ' | ') as acl
        from pg_default_acl d
        join pg_namespace n on n.oid = d.defaclnamespace
       where n.nspname = 'public' and d.defaclobjtype = 'r'
       order by 1;`);
    const postgresDefault = rows.find((r) => r.grantor === 'postgres');
    assert.ok(postgresDefault, 'the postgres default-privileges entry for public tables has gone missing');
    for (const role of CLIENT_ROLES) {
      const m = String(postgresDefault.acl).match(new RegExp(`${role}=([a-zA-Z]*)/`));
      assert.ok(m, `no default-privilege entry for ${role}: ${postgresDefault.acl}`);
      assert.ok(!m[1].includes('D'),
        `the default still grants TRUNCATE to ${role} (${m[1]}) — new tables will arrive with it`);
    }
  });

  test('proved on a real new table, created and rolled back', () => {
    // The mechanism is re-proven rather than trusted. The equivalent move for
    // FUNCTIONS is a silent no-op — Postgres re-merges the built-in EXECUTE TO
    // PUBLIC default at CREATE time — so "it worked for functions' cousin" is
    // not an argument that it works here. It is checked against a real table.
    const r = query(rolledBack(`
      create table public.s9_regression_probe (id int);
      select has_table_privilege('anon','public.s9_regression_probe','TRUNCATE')::text          as anon_trunc,
             has_table_privilege('authenticated','public.s9_regression_probe','TRUNCATE')::text as auth_trunc,
             has_table_privilege('anon','public.s9_regression_probe','SELECT')::text            as anon_select,
             has_table_privilege('service_role','public.s9_regression_probe','TRUNCATE')::text  as svc_trunc;`));
    assert.equal(r.anon_trunc, 'false', 'a brand-new table still hands TRUNCATE to anon');
    assert.equal(r.auth_trunc, 'false', 'a brand-new table still hands TRUNCATE to authenticated');
    assert.equal(r.anon_select, 'true', 'the default now withholds more than TRUNCATE — new tables are unreadable');
    assert.equal(r.svc_trunc, 'true', 'a brand-new table withholds TRUNCATE from service_role');
  });
});

// ── 4. Behaviour, not just catalogue state ──────────────────────────────────

describe('the refusal is real and specific', () => {
  test('TRUNCATE as anon and as authenticated is refused with 42501', () => {
    // Against a throwaway table inside a transaction that is never committed —
    // never a production table. DELETE is attempted on the same table by the
    // same role: if that succeeds and TRUNCATE does not, the denial is
    // specifically about TRUNCATE and not about access in general.
    //
    // 42501 is asserted rather than "it failed somehow". An earlier attempt to
    // prove this produced 55006 (a lock conflict from calling TRUNCATE inside a
    // function that a still-running SELECT was scanning) which reads like a
    // denial and is not one. Only 42501 means "not permitted".
    const rows = queryAll(rolledBack(`
      create table public.s9_behaviour_probe (id int);
      insert into public.s9_behaviour_probe values (1),(2),(3);
      create temp table s9out (n int generated always as identity, role_name text, op text, outcome text, rows_left int);

      do $$
      declare v_role text; v_rows int; v_out text;
      begin
        foreach v_role in array array['anon','authenticated'] loop
          begin
            execute format('set local role %I', v_role);
            truncate table public.s9_behaviour_probe;
            reset role;
            v_out := 'SUCCEEDED';
          exception when others then
            reset role;
            v_out := sqlstate;
          end;
          select count(*) into v_rows from public.s9_behaviour_probe;
          insert into s9out(role_name, op, outcome, rows_left) values (v_role, 'truncate', v_out, v_rows);

          begin
            execute format('set local role %I', v_role);
            delete from public.s9_behaviour_probe where id = 3;
            reset role;
            v_out := 'SUCCEEDED';
          exception when others then
            reset role;
            v_out := sqlstate;
          end;
          select count(*) into v_rows from public.s9_behaviour_probe;
          insert into s9out(role_name, op, outcome, rows_left) values (v_role, 'delete', v_out, v_rows);
          -- put the deleted row back so the second role meets the same table
          insert into public.s9_behaviour_probe values (3);
        end loop;
      end $$;

      select role_name, op, outcome, rows_left::text as rows_left from s9out order by n;`));

    assert.equal(rows.length, 4, 'expected a TRUNCATE and a DELETE attempt per client role');
    for (const r of rows) {
      if (r.op === 'truncate') {
        assert.equal(r.outcome, '42501',
          `${r.role_name} TRUNCATE returned ${r.outcome}, not a permission denial`);
        assert.equal(r.rows_left, '3', `${r.role_name} emptied the probe table`);
      } else {
        assert.equal(r.outcome, 'SUCCEEDED',
          `${r.role_name} lost DELETE too — the revoke took more than TRUNCATE`);
      }
    }
  });
});

// ── 5. Nothing in either repository asks for it ─────────────────────────────

/** grep exits 1 when it finds nothing. That is the passing case, not a failure. */
function grepLines(root: string, includes: string[], pattern: string): string[] {
  try {
    const out = execFileSync('grep', [
      '-rniE', pattern, ...includes,
      '--exclude-dir=node_modules', '--exclude-dir=.next', '--exclude-dir=.git',
      root,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.split('\n').filter(Boolean);
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    if (err.status === 1) return [];
    return (err.stdout ?? '').split('\n').filter(Boolean);
  }
}

describe('no client code truncates', () => {
  test('neither repository contains a client-reachable TRUNCATE', () => {
    const hits: string[] = [];
    for (const [label, root] of [['app+backend', REPO_ROOT], ['website', WEB_ROOT]] as const) {
      const lines = [
        // SQL files: any TRUNCATE at all is worth looking at.
        ...grepLines(root, ['--include=*.sql'], '\\btruncate\\b'),
        // Code files: only a real statement. A bare "truncate" in TypeScript is
        // overwhelmingly Tailwind's text-overflow class, which is not this.
        ...grepLines(root, ['--include=*.ts', '--include=*.tsx', '--include=*.js'],
          '\\btruncate[[:space:]]+(table|only|public\\.)'),
      ];
      for (const line of lines) {
        // The revokes written in Steps 6 and 9 are the fix, not a use of it.
        if (/revoke|\balter default privileges\b/i.test(line)) continue;
        // This test file describes the thing it forbids.
        if (line.includes('truncate-privileges.node.test')) continue;
        // The probe above runs against a throwaway table, inside a rollback.
        if (/s9_behaviour_probe/.test(line)) continue;
        hits.push(`${label}: ${line.slice(0, 160)}`);
      }
    }
    assert.deepEqual(hits, [], `TRUNCATE appears in source:\n  ${hits.join('\n  ')}`);
  });
});

// ── 6. The probes cleaned up after themselves ───────────────────────────────

describe('this test leaves nothing behind', () => {
  test('no probe table survived into production', () => {
    const left = queryAll(`
      select c.relname as tbl
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname like 's9\\_%'
       order by 1;`);
    assert.deepEqual(left, [],
      `a probe table was committed to production: ${left.map((l) => l.tbl).join(', ')}`);
  });
});
