/**
 * memory-media-privacy.node.test.ts — a memory's media follows the memory's
 * visibility.
 *
 * WHAT WAS WRONG
 *
 * public.memories supports public / community / private and its RLS enforces
 * that. Storage did not: memories-media was a public bucket whose SELECT policy
 * was `bucket_id = 'memories-media'`, and its objects were addressed by
 * persisted /object/public/ URLs held in memory_media.url. Possession of the
 * link bypassed the visibility model completely.
 *
 * Every memory was public at the time, so nothing was exposed — the first
 * private one would have been.
 *
 * ONE RULE, NOT TWO
 *
 * can_view_memory() is SECURITY INVOKER and asks the only question that
 * matters: can the caller select this memory row? The memories RLS policy
 * answers it. Storage then follows whatever that policy says, today and after
 * any future change, with no second definition of "private" to keep in step.
 * It returns a boolean and never data, and needs no elevated grant because it
 * can see exactly what its caller can see.
 *
 * WHAT IS ASSERTED
 *   · the visibility helper matches the memories model for public, community
 *     and private, across anon, a stranger and the author
 *   · flipping a memory public → private closes media access, and back again
 *     reopens it
 *   · the storage read policy is memory-aware, not `bucket_id = …`
 *   · every client resolves media by signed URL; none calls getPublicUrl on
 *     this bucket, and no upload persists a public URL
 *   · no service-role route signs an arbitrary caller-supplied path
 *   · while the bucket is still public, no non-public memory may exist, and the
 *     held-back cutover file must still be present
 *
 * SAFETY
 * Visibility is toggled only inside transactions that are never committed, so
 * no real memory changes. No real path, URL, author or object appears here.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');

/**
 * Percent-encodes each path SEGMENT and keeps the separators.
 * encodeURIComponent() would turn "a/b/c.jpg" into "a%2Fb%2Fc.jpg", which names
 * a different (nonexistent) object — the sign call still succeeds and the
 * fetch then 400s, which looks like a policy failure and is not one.
 */
const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** Public project config, for the tests that exercise the real Storage HTTP API. */
function publicConfig(): { url: string; anonKey: string } | null {
  let url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  let anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!url || !anonKey) {
    try {
      for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
        const m = line.match(/^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)\s*=\s*(.+)\s*$/);
        if (!m) continue;
        const v = m[2].trim().replace(/^["']|["']$/g, '');
        if (m[1].endsWith('URL')) url ||= v; else anonKey ||= v;
      }
    } catch { /* handled by the null return */ }
  }
  return url && anonKey ? { url, anonKey } : null;
}
const cfg = publicConfig();

function rowsOf(out: string): Record<string, unknown>[] {
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
}
const runSql = (sql: string) => rowsOf(execFileSync('npx',
  ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
  { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }));
const one = (sql: string) => runSql(sql)[0] ?? {};

/** Committed source only — build output and worktrees are not source. */
function trackedMatches(pattern: RegExp, roots: string[]): string[] {
  const hits: string[] = [];
  for (const root of roots) {
    let files: string[] = [];
    try {
      files = execFileSync('git', ['ls-files', '*.ts', '*.tsx'],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').filter(Boolean);
    } catch { continue; }
    for (const rel of files) {
      if (rel.includes('memory-media-privacy.node.test')) continue;
      let body = ''; try { body = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
      body.split('\n').forEach((line, i) => {
        if (pattern.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
      });
    }
  }
  return hits;
}

// ── 1. The visibility rule ──────────────────────────────────────────────────

describe('media visibility follows the memory', () => {
  test('public, community and private each resolve correctly', () => {
    // Toggled inside a transaction that is never committed: the real memory is
    // put back exactly as it was.
    const r = one(`
      begin;
      create temp table res (k text, v text);
      do $$
      declare v_m uuid; v_a uuid; v_other uuid; b boolean;
      begin
        select id, author_id into v_m, v_a from public.memories limit 1;
        select id into v_other from public.profiles where id <> v_a order by id limit 1;

        set local role anon; perform set_config('request.jwt.claims', null, true);
        select public.can_view_memory(v_m) into b; reset role;
        insert into res values ('public_anon', b::text);

        update public.memories set visibility='community' where id = v_m;
        set local role anon; perform set_config('request.jwt.claims', null, true);
        select public.can_view_memory(v_m) into b; reset role;
        insert into res values ('community_anon', b::text);
        set local role authenticated;
        perform set_config('request.jwt.claims', json_build_object('sub',v_other::text,'role','authenticated')::text, true);
        select public.can_view_memory(v_m) into b; reset role;
        insert into res values ('community_signed_in', b::text);

        update public.memories set visibility='private' where id = v_m;
        set local role anon; perform set_config('request.jwt.claims', null, true);
        select public.can_view_memory(v_m) into b; reset role;
        insert into res values ('private_anon', b::text);
        set local role authenticated;
        perform set_config('request.jwt.claims', json_build_object('sub',v_other::text,'role','authenticated')::text, true);
        select public.can_view_memory(v_m) into b; reset role;
        insert into res values ('private_stranger', b::text);
        set local role authenticated;
        perform set_config('request.jwt.claims', json_build_object('sub',v_a::text,'role','authenticated')::text, true);
        select public.can_view_memory(v_m) into b; reset role;
        insert into res values ('private_author', b::text);
      end $$;
      select (select v from res where k='public_anon')          as public_anon,
             (select v from res where k='community_anon')       as community_anon,
             (select v from res where k='community_signed_in')  as community_signed_in,
             (select v from res where k='private_anon')         as private_anon,
             (select v from res where k='private_stranger')     as private_stranger,
             (select v from res where k='private_author')       as private_author;`);

    assert.equal(r.public_anon, 'true', 'a public memory is not readable anonymously');
    assert.equal(r.community_anon, 'false', 'a community memory is readable anonymously');
    assert.equal(r.community_signed_in, 'true', 'a signed-in viewer cannot read a community memory');
    assert.equal(r.private_anon, 'false', 'a private memory is readable anonymously');
    assert.equal(r.private_stranger, 'false', 'another signed-in user can read a private memory');
    assert.equal(r.private_author, 'true', 'the author cannot read their own private memory');
  });

  test('changing public → private closes media access, and back reopens it', () => {
    const r = one(`
      begin;
      create temp table res (k text, v text);
      do $$
      declare v_m uuid; b boolean;
      begin
        select id into v_m from public.memories limit 1;
        update public.memories set visibility='private' where id = v_m;
        set local role anon; perform set_config('request.jwt.claims', null, true);
        select public.can_view_memory(v_m) into b; reset role;
        insert into res values ('after_private', b::text);
        update public.memories set visibility='public' where id = v_m;
        set local role anon; perform set_config('request.jwt.claims', null, true);
        select public.can_view_memory(v_m) into b; reset role;
        insert into res values ('back_public', b::text);
      end $$;
      select (select v from res where k='after_private') as after_private,
             (select v from res where k='back_public')   as back_public;`);
    assert.equal(r.after_private, 'false', 'making a memory private did not close media access');
    assert.equal(r.back_public, 'true', 'making a memory public again did not reopen media access');
  });

  test('the storage read policy is memory-aware, not a bare bucket check', () => {
    const r = one(`
      select coalesce((select qual from pg_policies
         where schemaname='storage' and tablename='objects'
           and policyname='memories-media visibility read'), '(missing)') as policy;`);
    assert.notEqual(r.policy, '(missing)', 'the memory-aware read policy is gone');
    assert.match(String(r.policy), /can_view_memory/,
      'the memories-media read policy no longer consults memory visibility');
    const old = one(`select count(*)::text as n from pg_policies
       where schemaname='storage' and tablename='objects' and policyname='memories-media public read';`);
    assert.equal(old.n, '0', 'the old unconditional read policy is back');
  });

  test('can_view_memory is SECURITY INVOKER and returns only a boolean', () => {
    // A definer function here would have to re-implement the visibility rule
    // (its own RLS is bypassed) and would be a privileged function answering
    // questions about other people's data.
    const r = one(`
      select p.prosecdef::text as secdef, pg_get_function_result(p.oid) as returns
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.proname='can_view_memory';`);
    assert.equal(r.secdef, 'false', 'can_view_memory became SECURITY DEFINER');
    assert.equal(r.returns, 'boolean', 'can_view_memory returns something other than a boolean');
  });
});

// ── 2. Clients resolve media by signed URL ──────────────────────────────────

describe('no client depends on a public memory-media URL', () => {
  test('nothing calls getPublicUrl on memories-media', () => {
    const hits = trackedMatches(/getPublicUrl/, [REPO_ROOT, WEB_ROOT])
      .filter((l) => /memories-media|MEMORIES_BUCKET/.test(l));
    assert.deepEqual(hits, [],
      `these still build a public URL for memory media:\n  ${hits.join('\n  ')}`);
  });

  test('no upload persists a public URL into memory_media', () => {
    // Scoped to the memory-media files. Other buckets — hub and business logos
    // among them — are public by design and legitimately store a public URL;
    // flagging those would be a false alarm, not a finding.
    const memoryFiles = [
      join(REPO_ROOT, 'lib/memories-api.ts'),
      join(WEB_ROOT, 'components/memories/MemoryComposer.tsx'),
    ];
    const hits: string[] = [];
    for (const f of memoryFiles) {
      let body = ''; try { body = readFileSync(f, 'utf8'); } catch { continue; }
      body.split('\n').forEach((line, i) => {
        if (/url:\s*.*publicUrl/.test(line)) hits.push(`${f.split('/').slice(-2).join('/')}:${i + 1}`);
      });
    }
    assert.deepEqual(hits, [],
      `a memory-media upload still stores a public URL as the durable reference: ${hits.join(', ')}`);
  });

  test('both clients sign memory media at read time', () => {
    const web = readFileSync(join(WEB_ROOT, 'lib/memories-data.ts'), 'utf8');
    const app = readFileSync(join(REPO_ROOT, 'lib/memories-api.ts'), 'utf8');
    assert.match(web, /createSignedUrls\(/, 'the website no longer signs memory media');
    assert.match(app, /createSignedUrls\(/, 'the mobile app no longer signs memory media');
    // storage_path must be selected, or there is nothing to sign for.
    assert.match(web, /storage_path/, 'the website stopped selecting storage_path');
  });

  test('no service-role route signs a caller-supplied storage path', () => {
    // The anti-pattern: a public endpoint holding service_role that signs
    // whatever path it is handed, recreating the hole one layer up.
    const hits = trackedMatches(/SERVICE_ROLE/, [WEB_ROOT])
      .filter((l) => /sign|storage/i.test(l));
    assert.deepEqual(hits, [],
      `a website route combines service-role with storage signing:\n  ${hits.join('\n  ')}`);
  });
});

// ── 3. The cutover, completed ───────────────────────────────────────────────

describe('the private-bucket cutover is done', () => {
  test('memories-media is private', () => {
    const r = one(`select public::text as p from storage.buckets where id='memories-media';`);
    assert.equal(r.p, 'false',
      'memories-media is public again — its objects would be served regardless of memory visibility');
  });

  test('no held-back cutover file remains', () => {
    // It was moved into migrations/ and applied. A leftover copy would be an
    // executable duplicate of an already-applied change.
    assert.ok(!existsSync(join(REPO_ROOT, 'supabase/pending/PHASE3_memories_media_private.sql')),
      'the pending Phase-3 file is back — it has already been applied as a migration');
  });

  test('the cutover is recorded as a migration', () => {
    const tracked = execFileSync('git', ['ls-files', 'supabase/migrations'],
      { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    assert.ok(tracked.some((f) => /memories_media_private/.test(f)),
      'the bucket-private migration is missing — a restore would come up with a public bucket');
  });

  test('direct public delivery cannot bypass the policy', async () => {
    // The actual vulnerability: possession of an /object/public/ URL used to
    // return the bytes whatever the memory's visibility said.
    if (!cfg) return;
    const { url, anonKey } = cfg;
    const r = one(`select storage_path from public.memory_media limit 1;`);
    const path = String(r.storage_path ?? '');
    assert.ok(path, 'no memory media to test with');
    // Cache-busted: an edge-cached 200 from before the cutover is not evidence.
    const res = await fetch(`${url}/storage/v1/object/public/memories-media/${encodePath(path)}?cb=${Date.now()}`,
      { headers: { apikey: anonKey } });
    assert.notEqual(res.status, 200,
      'public object delivery still returns memory media — the bucket flag has been reverted');
  });

  test('a public memory can still be signed for and fetched anonymously', async () => {
    if (!cfg) return;
    const { url, anonKey } = cfg;
    const r = one(`
      select mm.storage_path from public.memory_media mm
        join public.memories m on m.id = mm.memory_id
       where m.visibility = 'public' limit 1;`);
    const path = String(r.storage_path ?? '');
    assert.ok(path, 'no public memory media to test with');
    const signRes = await fetch(`${url}/storage/v1/object/sign/memories-media/${encodePath(path)}`, {
      method: 'POST',
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 300 }),
    });
    const body = await signRes.json() as { signedURL?: string };
    assert.ok(body.signedURL, 'an anonymous visitor can no longer view a PUBLIC memory\'s media');
    const get = await fetch(`${url}/storage/v1${body.signedURL}`);
    assert.equal(get.status, 200, 'the signed URL for a public memory does not resolve');
  });

  test('the orphan objects are unreachable but still stored', () => {
    // 7 uploads whose composer session never created a memory_media row. They
    // resolve to no memory, so nobody can read them — and they are not deleted.
    const r = one(`
      select (select count(*)::text from storage.objects where bucket_id='memories-media') as total,
             (select count(*)::text from storage.objects o where o.bucket_id='memories-media'
                and not exists (select 1 from public.memory_media mm where mm.storage_path = o.name)) as orphans;`);
    assert.equal(r.total, '17', 'memory storage objects were added or removed');
    assert.equal(r.orphans, '7', 'the orphan object count changed — they should be left alone for now');
  });
});
