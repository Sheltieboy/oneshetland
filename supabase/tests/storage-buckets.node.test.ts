/**
 * storage-buckets.node.test.ts — storage is described by the repository, not by
 * whoever last used the Dashboard.
 *
 * WHAT M2 ACTUALLY WAS, ONCE RE-DERIVED
 *
 * The finding said eight buckets existed and two were versioned. Production
 * disagreed in both directions:
 *
 *   boat-comment-media   in the clients, NOT in production. Its bucket and
 *                        policies sat in migrations_ARCHIVE/044, which never
 *                        runs, so attaching a photo to a boat comment uploaded
 *                        into a bucket that did not exist.
 *   cruise-media         in production, absent from the finding. 70 objects.
 *   employer-logos       in production, absent from the finding. Empty.
 *
 * The policies were in better shape than the finding implied — every live
 * bucket already had ownership-checked writes. What was missing was that none
 * of it was in git, so a restored project would have come up with no buckets
 * and no policies at all.
 *
 * WHAT IS ASSERTED
 *   · every live bucket has a version-controlled definition here, and every
 *     definition exists live — drift in either direction fails
 *   · public flags, size limits and MIME lists match exactly
 *   · all four commands are policed on every bucket, reads open to public and
 *     writes scoped to authenticated
 *   · anon cannot write anywhere; a signed-in user cannot write into another
 *     user's namespace, or overwrite or delete their objects
 *   · owners and admins can still do their own work
 *   · the memories-media visibility gap is DETECTED the moment it becomes real
 *
 * SAFETY
 * Every write probe runs inside a transaction that is never committed, so no
 * object is created, moved or deleted. No real object path appears here.
 *
 * Run: npm test
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The version-controlled definition, mirroring
 * 20260821220000_storage_buckets_versioned.sql. If a bucket is added or its
 * configuration changed in production without changing this, the test fails —
 * which is the whole point of M2.
 */
const EXPECTED = {
  'avatars':            { pub: true, mb:  8, mime: ['image/jpeg','image/jpg','image/png','image/webp'] },
  'boat-comment-media': { pub: true, mb: 10, mime: ['image/jpeg','image/jpg','image/png','image/webp'] },
  'business-media':     { pub: true, mb: 10, mime: ['image/jpeg','image/jpg','image/png','image/webp'] },
  'cruise-media':       { pub: true, mb: 10, mime: ['image/jpeg','image/jpg','image/png','image/webp'] },
  'employer-logos':     { pub: true, mb:  5, mime: ['image/jpeg','image/jpg','image/png','image/webp'] },
  'event-media':        { pub: true, mb: 10, mime: ['image/jpeg','image/jpg','image/png','image/webp'] },
  'hub-media':          { pub: true, mb: 20, mime: ['image/jpeg','image/jpg','image/png','image/webp'] },
  // PRIVATE since the Step 13C cutover: its objects follow the memory's
  // visibility, so they are signed for at read time rather than served openly.
  'memories-media':     { pub: false, mb: 25, mime: ['image/jpeg','image/jpg','image/png','image/webp',
                                                    'audio/webm','audio/ogg','audio/mpeg','audio/mp4','audio/m4a','audio/wav'] },
  'site-media':         { pub: true, mb: 10, mime: ['image/jpeg','image/jpg','image/png','image/webp'] },
  'spik-audio':         { pub: true, mb: 10, mime: ['audio/webm','audio/ogg','audio/mpeg','audio/mp4'] },
} as const;
const BUCKETS = Object.keys(EXPECTED);

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }));
const one = (sql: string) => runSql(sql)[0] ?? {};

// ── 1. The repository is authoritative ─────────────────────────────────────

describe('every bucket is described by the repository', () => {
  let live: Record<string, Record<string, unknown>> = {};
  before(() => {
    live = Object.fromEntries(runSql(`
      select id, public::text as pub,
             coalesce(file_size_limit::text,'null')                    as bytes,
             coalesce(array_to_string(allowed_mime_types,','),'')       as mime
        from storage.buckets order by id;`).map((r) => [String(r.id), r]));
  });

  test('no bucket exists in production without a definition here', () => {
    const undefined_ = Object.keys(live).filter((b) => !(b in EXPECTED));
    assert.deepEqual(undefined_, [],
      `production buckets with no version-controlled definition: ${undefined_.join(', ')}. ` +
      `Add them to the storage migration and to EXPECTED, or delete them.`);
  });

  test('no defined bucket is missing from production', () => {
    const missing = BUCKETS.filter((b) => !(b in live));
    assert.deepEqual(missing, [],
      `defined but absent from production: ${missing.join(', ')} — a restore would not recreate them`);
  });

  for (const [bucket, want] of Object.entries(EXPECTED)) {
    test(`${bucket} matches its definition`, () => {
      const got = live[bucket];
      assert.ok(got, `${bucket} is not live`);
      assert.equal(got.pub, String(want.pub), `${bucket} visibility drifted`);
      assert.equal(got.bytes, String(want.mb * 1048576),
        `${bucket} size limit drifted (expected ${want.mb} MB)`);
      assert.deepEqual(String(got.mime).split(',').filter(Boolean).sort(), [...want.mime].sort(),
        `${bucket} MIME allow-list drifted`);
    });
  }
});

// ── 2. Every command on every bucket is policed ────────────────────────────

describe('the policy surface is complete and correctly scoped', () => {
  let pols: Record<string, unknown>[] = [];
  before(() => {
    pols = runSql(`
      select policyname, cmd, roles::text as roles
        from pg_policies where schemaname='storage' and tablename='objects'
       order by policyname;`);
  });

  test('all four commands are policed on all ten buckets', () => {
    const gaps: string[] = [];
    for (const b of BUCKETS) {
      for (const cmd of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        if (!pols.some((p) => String(p.policyname).startsWith(`${b} `) && p.cmd === cmd)) {
          gaps.push(`${b}/${cmd}`);
        }
      }
    }
    assert.deepEqual(gaps, [], `bucket/command combinations with no policy: ${gaps.join(', ')}`);
  });

  test('reads are public and writes are authenticated-only', () => {
    // A write policy left on `public` is evaluated for anonymous requests too,
    // which is how an anon upload came to fail with "permission denied for
    // table local_businesses" instead of its own policy.
    const wrong = pols
      .filter((p) => BUCKETS.some((b) => String(p.policyname).startsWith(`${b} `)))
      .filter((p) => (p.cmd === 'SELECT' ? !String(p.roles).includes('public')
                                         : !String(p.roles).includes('authenticated')))
      .map((p) => `${p.policyname} [${p.cmd}] roles=${p.roles}`);
    assert.deepEqual(wrong, [], `policies with the wrong role scope: ${wrong.join('; ')}`);
  });

  test('no resource-scoped policy uses an unqualified name inside a subquery', () => {
    // public.hubs and public.local_businesses both have a `name` column, so a
    // bare `name` inside those subqueries binds to the RESOURCE's name, not the
    // object path — silently false, and the owner is locked out of their own
    // media. This is what the owner matrix caught.
    const bad = runSql(`
      select policyname from pg_policies
       where schemaname='storage' and tablename='objects'
         and coalesce(qual, with_check) like '%EXISTS%'
         and coalesce(qual, with_check) not like '%objects.name%'
         and (policyname like 'business-media %' or policyname like 'hub-media %'
              or policyname like 'memories-media %')
       order by 1;`);
    assert.deepEqual(bad, [],
      `these compare a resource id against the RESOURCE's own name column: ${bad.map((b) => b.policyname).join(', ')}`);
  });
});

// ── 3. Adversarial access ──────────────────────────────────────────────────

describe('nobody can write outside their own namespace', () => {
  let matrix: Record<string, unknown>[] = [];
  before(() => {
    // Every probe is inside a transaction that is never committed.
    matrix = runSql(`
      begin;
      create temp table res (n int generated always as identity, bucket text, actor text, outcome text);
      create temp table who as
        select (select id from public.profiles order by id offset 50 limit 1) a,
               (select id from public.profiles order by id offset 51 limit 1) b;
      create or replace function pg_temp.try_as(p_role text, p_user uuid, p_sql text) returns text
      language plpgsql as $f$
      begin
        execute format('set local role %I', p_role);
        if p_user is not null then
          perform set_config('request.jwt.claims',
            json_build_object('sub',p_user::text,'role',p_role)::text, true);
        end if;
        execute p_sql; reset role; return 'ALLOWED';
      exception when others then reset role; return 'DENIED'; end $f$;

      -- Reports how many rows a statement actually changed, so a no-op that
      -- "succeeds" is not mistaken for permission.
      create or replace function pg_temp.rows_as(p_role text, p_user uuid, p_sql text) returns text
      language plpgsql as $f$
      declare n int;
      begin
        execute format('set local role %I', p_role);
        if p_user is not null then
          perform set_config('request.jwt.claims',
            json_build_object('sub',p_user::text,'role',p_role)::text, true);
        end if;
        execute p_sql;
        get diagnostics n = row_count;
        reset role;
        return case when n = 0 then 'NO ROWS' else 'CHANGED ' || n end;
      exception when others then reset role; return 'DENIED'; end $f$;

      do $$
      declare a uuid; b uuid; bk text;
      begin
        select w.a, w.b into a, b from who w;
        foreach bk in array array['avatars','boat-comment-media','business-media','cruise-media',
                                  'employer-logos','event-media','hub-media','memories-media',
                                  'site-media','spik-audio'] loop
          insert into res(bucket,actor,outcome) values (bk,'anon read',
            pg_temp.try_as('anon', null, format('select count(*) from storage.objects where bucket_id=%L', bk)));
          insert into res(bucket,actor,outcome) values (bk,'anon write',
            pg_temp.try_as('anon', null,
              format('insert into storage.objects (bucket_id,name) values (%L,%L)', bk, 'probe/anon.jpg')));
          insert into res(bucket,actor,outcome) values (bk,'B into A namespace',
            pg_temp.try_as('authenticated', b,
              format('insert into storage.objects (bucket_id,name,owner) values (%L,%L,%L)',
                     bk, a::text||'/probe.jpg', b)));
          -- UPDATE and DELETE do not RAISE under RLS: rows the caller may not
          -- touch are simply not matched, and the statement succeeds having
          -- changed nothing. So the invariant is ROWS AFFECTED = 0, not an
          -- error — asserting failure here would pass for the wrong reason.
          insert into res(bucket,actor,outcome) values (bk,'B deletes others',
            pg_temp.rows_as('authenticated', b,
              format('delete from storage.objects where bucket_id=%L', bk)));
          insert into res(bucket,actor,outcome) values (bk,'B overwrites others',
            pg_temp.rows_as('authenticated', b,
              format('update storage.objects set name = name || ''.x'' where bucket_id=%L', bk)));
        end loop;
      end $$;
      select bucket, actor, outcome from res order by n;`);
  });

  test('anon may read every public bucket', () => {
    const denied = matrix.filter((r) => r.actor === 'anon read' && r.outcome !== 'ALLOWED');
    assert.deepEqual(denied, [], `public delivery broke for: ${denied.map((d) => d.bucket).join(', ')}`);
  });

  for (const actor of ['anon write', 'B into A namespace']) {
    test(`${actor} is refused everywhere`, () => {
      const allowed = matrix.filter((r) => r.actor === actor && r.outcome === 'ALLOWED');
      assert.deepEqual(allowed, [],
        `"${actor}" succeeded in: ${allowed.map((a) => a.bucket).join(', ')}`);
    });
  }

  for (const actor of ['B deletes others', 'B overwrites others']) {
    test(`${actor} changes nothing`, () => {
      // 'NO ROWS' and 'DENIED' are both correct; anything that CHANGED a row
      // is a real cross-user mutation.
      const changed = matrix.filter((r) => r.actor === actor && String(r.outcome).startsWith('CHANGED'));
      assert.deepEqual(changed, [],
        `"${actor}" modified rows in: ${changed.map((c) => `${c.bucket} (${c.outcome})`).join(', ')}`);
    });
  }
});

// ── 4. Legitimate owners still work ────────────────────────────────────────

describe('owners and admins keep their workflows', () => {
  test('a non-admin business owner, a hub owner and a memory author can each write', () => {
    // Deliberately a NON-ADMIN business owner: the `or is_admin()` branch once
    // hid a policy that was broken for every ordinary owner.
    const r = one(`
      begin;
      create temp table res (k text, v text);
      do $$
      declare v_biz uuid; v_bo uuid; v_hub uuid; v_ho uuid; v_mem uuid; v_ma uuid; v_out text;
      begin
        select b.id, b.owner_id into v_biz, v_bo from public.local_businesses b
          join public.profiles p on p.id=b.owner_id
         where b.owner_id is not null and coalesce(p.role,'') <> 'admin' limit 1;
        select id, owner_id into v_hub, v_ho from public.hubs where owner_id is not null limit 1;
        select id, author_id into v_mem, v_ma from public.memories limit 1;

        begin
          set local role authenticated;
          perform set_config('request.jwt.claims', json_build_object('sub',v_bo::text,'role','authenticated')::text, true);
          insert into storage.objects (bucket_id,name,owner) values ('business-media', v_biz::text||'/logo/p.jpg', v_bo);
          reset role; v_out:='ALLOWED';
        exception when others then reset role; v_out:='DENIED'; end;
        insert into res values ('business_owner', v_out);

        begin
          set local role authenticated;
          perform set_config('request.jwt.claims', json_build_object('sub',v_ho::text,'role','authenticated')::text, true);
          insert into storage.objects (bucket_id,name,owner) values ('hub-media', v_hub::text||'/cover/p.jpg', v_ho);
          reset role; v_out:='ALLOWED';
        exception when others then reset role; v_out:='DENIED'; end;
        insert into res values ('hub_owner', v_out);

        begin
          set local role authenticated;
          perform set_config('request.jwt.claims', json_build_object('sub',v_ma::text,'role','authenticated')::text, true);
          insert into storage.objects (bucket_id,name,owner) values ('memories-media', v_mem::text||'/photo/p.jpg', v_ma);
          reset role; v_out:='ALLOWED';
        exception when others then reset role; v_out:='DENIED'; end;
        insert into res values ('memory_author', v_out);
      end $$;
      select (select v from res where k='business_owner') as business_owner,
             (select v from res where k='hub_owner')      as hub_owner,
             (select v from res where k='memory_author')  as memory_author;`);
    assert.equal(r.business_owner, 'ALLOWED', 'a non-admin business owner cannot upload their own media');
    assert.equal(r.hub_owner, 'ALLOWED', 'a hub owner cannot upload their own hub media');
    assert.equal(r.memory_author, 'ALLOWED', 'a memory author cannot upload their own memory media');
  });
});

// ── 5. The known gap, alarmed rather than assumed away ─────────────────────

describe('memories media visibility', () => {
  test('no memory is non-public while the bucket is public', () => {
    // public.memories supports public / community / private and its own RLS
    // enforces that. Storage does not: memories-media is a public bucket, so
    // its objects are served to anyone with the URL regardless of the memory's
    // visibility. Every memory is currently 'public', so nothing is exposed —
    // and this fails the moment that stops being true, which is the point at
    // which the private-bucket-plus-signed-URLs change becomes urgent.
    const r = one(`
      select (select count(*)::text from public.memories where visibility <> 'public') as non_public,
             (select public::text from storage.buckets where id='memories-media')      as bucket_public;`);
    if (r.bucket_public === 'false') return; // gap already closed properly
    assert.equal(r.non_public, '0',
      `${r.non_public} memory/memories are marked community or private, but memories-media is still a PUBLIC ` +
      `bucket — their photos and audio are readable by anyone with the URL. Storage must move to a private ` +
      `bucket with signed URLs before non-public memories are used.`);
  });
});
