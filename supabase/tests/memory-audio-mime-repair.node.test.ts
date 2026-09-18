/**
 * memory-audio-mime-repair.node.test.ts
 *
 * Auld Stories — real-device audio MIME repair.
 *
 * A real iPhone save (build 143), AFTER the HEIC-photo repair, progressed
 * past the photo (it genuinely uploaded — confirmed directly against
 * production: memory_media row + Storage object, mimetype "image/jpeg") and
 * failed specifically on the voice note, with the improved partial-save UI
 * correctly staying on screen and showing the real backend error VERBATIM:
 *
 *   Storage upload failed (400)
 *   statusCode: 415, error: Invalid_mime_type,
 *   message: mime type audio/x-m4a is not supported, code: InvalidMimeType
 *
 * even though this app's own JS explicitly sets the recording's
 * Content-Type to 'audio/m4a' (components/VoiceRecorder.tsx) — already in
 * the bucket's allowlist. A live, production-safe probe (PART A) proves
 * Storage genuinely honours an explicitly-declared 'audio/m4a' (reaches
 * RLS, not the MIME gate) — so the substitution to 'audio/x-m4a' happens
 * somewhere between this app's JS and the wire on a real device, most
 * likely iOS's own native multipart bridge deriving a MIME type from the
 * file rather than trusting the declared string. That layer isn't
 * traceable further from here, so the fix is belt-and-braces:
 *
 *   1. lib/memories-api.ts now canonicalises known-equivalent MIME
 *      aliases (audio/x-m4a -> audio/m4a) at the one place all uploads
 *      pass through, in case the substitution can be prevented client-side.
 *   2. supabase/migrations/20261015000000_memories_media_m4a_alias.sql
 *      widens the memories-media bucket to ALSO accept audio/x-m4a
 *      directly — already applied to production — so the fix holds even
 *      if the substitution happens at a layer this app's JS cannot reach.
 *
 * Also fixed: the partial-save message was interpolating the raw backend
 * error (exactly the JSON dump above) straight into user-facing copy.
 * User copy is now plain English only, and only ever calls a file "safe"
 * because it is genuinely marked uploaded.
 *
 * WHAT THIS FILE PROVES, AND HOW
 *   PART A executes real HTTP requests against the live, deployed Storage
 *   API — genuine integration testing, not a simulation. Every request
 *   here is rejected (RLS, since this uses the anon key), so nothing is
 *   ever written and nothing needs cleaning up.
 *   PART B is source-level assertions against the canonicalisation table
 *   and the client screen's control flow/copy — this repo's only tool for
 *   that layer. These prove the mapping and the message-construction logic
 *   are correct and wired in; they do not and cannot prove what a real
 *   iOS device's native networking layer actually does with a Content-Type
 *   string, which is exactly why the fix is belt-and-braces rather than
 *   client-only.
 *
 * SAFETY
 * No Supabase Auth call, no signup, no real memory created or modified, no
 * database write from this file. Darren's real stories are never read,
 * modified, or referenced by id here.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const apiSrc      = code(read('lib/memories-api.ts'));
const createSrc   = code(read('app/memory-new.tsx'));
const migrationSql = read('supabase/migrations/20261015000000_memories_media_m4a_alias.sql');

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? readEnvFallback('EXPO_PUBLIC_SUPABASE_URL');
const ANON_KEY      = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? readEnvFallback('EXPO_PUBLIC_SUPABASE_ANON_KEY');
function readEnvFallback(key: string): string | undefined {
  try {
    const m = read('.env').match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m?.[1]?.trim();
  } catch { return undefined; }
}
const haveConfig = !!SUPABASE_URL && !!ANON_KEY;

async function probeUpload(path: string, contentType: string): Promise<{ status: number; body: any }> {
  const form = new FormData();
  const bytes = new Blob([new Uint8Array([0, 1, 2, 3])], { type: contentType });
  form.append('file', bytes, path.split('/').pop());
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/memories-media/${path}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY!, Authorization: `Bearer ${ANON_KEY}` },
    body: form,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/* ── PART A — live proof the bucket now accepts the real-device value ────── */

describe('LIVE: the memories-media bucket now accepts audio/x-m4a directly, and audio/m4a still works', {
  skip: !haveConfig && 'EXPO_PUBLIC_SUPABASE_URL/ANON_KEY not available in this environment',
}, () => {
  test('audio/x-m4a — the exact value the real device sent — now clears the MIME gate (reaches RLS, not InvalidMimeType)', async () => {
    const { status, body } = await probeUpload('_test-probe-never-written/audio/probe-xm4a.m4a', 'audio/x-m4a');
    assert.equal(status, 400); // still refused — anon has no write grant — but for a DIFFERENT reason now
    assert.notEqual(body?.code, 'InvalidMimeType');
    assert.equal(body?.code, 'AccessDenied');
  });

  test('audio/m4a — what this app\'s JS explicitly declares — still clears the same gate', async () => {
    const { status, body } = await probeUpload('_test-probe-never-written/audio/probe-m4a.m4a', 'audio/m4a');
    assert.equal(status, 400);
    assert.notEqual(body?.code, 'InvalidMimeType');
    assert.equal(body?.code, 'AccessDenied');
  });

  test('an unrelated, genuinely unsupported type is still correctly refused (the gate itself is not disabled)', async () => {
    const { status, body } = await probeUpload('_test-probe-never-written/audio/probe-bogus.bin', 'application/x-bogus-format');
    assert.equal(status, 400);
    assert.equal(body?.code, 'InvalidMimeType');
  });
});

/* ── PART B — the fix, source-level ───────────────────────────────────────── */

describe('a central MIME-canonicalisation boundary, not a scattered UI-component fix', () => {
  test('canonicalMimeType exists and is applied to contentType in uploadMemoryMedia — the one place all uploads pass through', () => {
    assert.match(apiSrc, /function canonicalMimeType\(mime: string\): string \{/);
    assert.match(apiSrc, /const contentType = canonicalMimeType\(/);
  });

  test('the alias table maps exactly audio/x-m4a -> audio/m4a — nothing broader', () => {
    const tableStart = apiSrc.indexOf('const MIME_ALIASES');
    const tableEnd = apiSrc.indexOf('};', tableStart);
    const table = apiSrc.slice(tableStart, tableEnd);
    assert.match(table, /'audio\/x-m4a':\s*'audio\/m4a'/);
    // Exactly one mapping — this is a proven, specific alias, not a
    // scattergun of guesses.
    const entries = table.match(/'[a-z0-9./-]+':\s*'[a-z0-9./-]+'/gi) ?? [];
    assert.equal(entries.length, 1);
  });

  test('canonicalMimeType is case-insensitive but does not rewrite anything not in the table', () => {
    assert.match(apiSrc, /MIME_ALIASES\[mime\.toLowerCase\(\)\] \?\? mime/);
  });

  test('no UI component (VoiceRecorder, memory-new) does its own MIME rewriting — the boundary is centralised in the API layer', () => {
    const recorderSrc = code(read('components/VoiceRecorder.tsx'));
    assert.doesNotMatch(recorderSrc, /x-m4a|canonicalMimeType|MIME_ALIAS/i);
    assert.doesNotMatch(createSrc, /x-m4a|canonicalMimeType|MIME_ALIAS/i);
  });
});

describe('the bucket allowlist was ALSO widened, deliberately and narrowly, as belt-and-braces', () => {
  test('the migration adds exactly audio/x-m4a, not a broader audio/* or format change', () => {
    assert.match(migrationSql, /allowed_mime_types \|\| array\['audio\/x-m4a'\]/);
    assert.doesNotMatch(migrationSql, /audio\/\*/);
  });

  test('it targets only the memories-media bucket, and is idempotent (guarded, not an unconditional re-run)', () => {
    assert.match(migrationSql, /where id = 'memories-media'/);
    assert.match(migrationSql, /and not \('audio\/x-m4a' = any\(allowed_mime_types\)\)/);
  });

  test('it uses UPDATE, not the DELETE+INSERT pattern this codebase\'s own bucket-migration convention explicitly warns against', () => {
    assert.match(migrationSql, /^update storage\.buckets/m);
    assert.doesNotMatch(migrationSql, /delete from storage\.buckets/i);
  });
});

describe('user-facing failure copy is plain English — no raw backend detail', () => {
  test('the message no longer interpolates err.message (the raw Storage JSON) into user-facing text', () => {
    const messageStart = createSrc.indexOf('const message = alreadySaved');
    const messageEnd = createSrc.indexOf(';', messageStart);
    const messageBlock = createSrc.slice(messageStart, messageEnd);
    assert.doesNotMatch(messageBlock, /err\?\.message|err\.message/);
    assert.doesNotMatch(messageBlock, /statusCode|InvalidMimeType|invalid_mime_type/i);
  });

  test('the raw backend detail is confined to the privacy-safe diagnostics call, not the alert/banner', () => {
    const idx = createSrc.indexOf("track('memory_media_upload_failed'");
    const block = createSrc.slice(idx, idx + 300);
    assert.match(block, /detail: String\(err\?\.message \?\? err\)\.slice\(0, 200\)/);
  });

  test('mediaKindLabel produces plain English, not the raw MediaKind value', () => {
    assert.match(createSrc, /function mediaKindLabel\(kind: MediaKind \| null\): string \{/);
    assert.match(createSrc, /'voice note'/);
  });
});

describe('the partial-save message only calls a file "safe" if it genuinely uploaded, and handles more than one file', () => {
  test('the "safe" list is built from drafts actually marked uploaded, not assumed from what was attached', () => {
    assert.match(createSrc, /const safeKinds = \[\.\.\.new Set\(\s*\n\s*drafts\.filter\(d => d\.uploaded\)\.map\(d => mediaKindLabel\(d\.kind\)\),/);
  });

  test('the sentence names both the safe item(s) and the failing one when there is at least one of each — matching the required example', () => {
    // "Your story and photo are safe, but we couldn't upload the voice note."
    assert.match(createSrc, /Your story\$\{storyAnd\} \$\{verb\} safe, but we couldn't upload the \$\{kindLabel\}\. Tap Retry upload to try again\./);
  });

  test('with nothing else yet uploaded, the sentence still reads correctly ("story is safe", not "story are safe")', () => {
    assert.match(createSrc, /const verb = safeKinds\.length \? 'are' : 'is';/);
  });
});

describe('retry still reuses the story, skips what already uploaded, and only re-attempts the failed file', () => {
  test('the duplicate-prevention and uploaded-skip logic (proven in the previous repair pass) is untouched', () => {
    assert.match(createSrc, /\} else if \(createdMemoryIdRef\.current\) \{\s*\n\s*memoryId = createdMemoryIdRef\.current;/);
    assert.match(createSrc, /\.filter\(\(\{\s*d\s*\}\) => !d\.uploaded\)/);
  });

  test('transcription is still requested only after uploadMemoryMedia (and therefore the canonicalised upload) succeeds', () => {
    const uploadIdx = createSrc.indexOf('const media = await uploadMemoryMedia(');
    const transcribeIdx = createSrc.indexOf("if (d.kind === 'audio')", uploadIdx);
    assert.ok(uploadIdx !== -1 && transcribeIdx !== -1 && uploadIdx < transcribeIdx);
  });

  test('a retry\'s Save button still relabels to "Retry upload"', () => {
    assert.match(createSrc, /partialSaveNotice\s*\n\s*\? 'Retry upload'/);
  });
});
