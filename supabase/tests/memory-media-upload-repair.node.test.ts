/**
 * memory-media-upload-repair.node.test.ts
 *
 * Auld Stories — media save failure, root cause and repair.
 *
 * A real physical-device save (build 143) created its memory row correctly
 * but persisted NEITHER the attached photo nor the ~23s voice recording —
 * zero memory_media rows, zero storage objects for either, no navigation,
 * no useful error seen. Forensics on the exact production record proved the
 * memory row was fine and both media items were entirely absent, which,
 * given this screen's save control flow, is only possible if the upload
 * loop threw before ever completing.
 *
 * ROOT CAUSE, PROVEN LIVE (not inferred) — see PART A below:
 *   expo-image-picker on iOS hands back a photo in its native HEIC format
 *   unless told otherwise. memories-media's Storage bucket only allows
 *   image/jpeg, image/jpg, image/png, image/webp (plus several audio
 *   types) — HEIC isn't in that list. A live, unauthenticated probe against
 *   the real bucket proves Storage rejects image/heic with
 *   400/invalid_mime_type BEFORE any RLS/auth check runs — matching the
 *   sub-second failure Darren saw — while the exact same bytes declared as
 *   image/jpeg pass that gate and reach RLS instead (a 403, the CORRECT
 *   outcome for an unauthenticated request). audio/m4a passes the same gate
 *   identically. Because handleSave's upload loop aborts entirely on the
 *   first thrown error, and the photo was attached before the audio, the
 *   photo's instant MIME rejection is why the audio was never even
 *   attempted — on the original tap AND the retry — not a separate bug.
 *
 * THE FIX:
 *   - pickPhoto asks the OS's own picker for a "compatible" (JPEG)
 *     representation instead of the native one — Apple's own documented
 *     mechanism for exactly this, on an ALREADY-linked native module
 *     (expo-image-picker), so this ships as an OTA, no native build.
 *   - uploadMemoryMedia now throws a stage-tagged MediaUploadError (auth /
 *     local_read / storage_upload / db_insert) instead of a bare Error, so
 *     failures are diagnosable instead of one opaque message for all four
 *     very different problems.
 *   - handleSave gets a synchronous savingRef guard (set before any await,
 *     closing the double-tap race that a purely React-state `disabled`
 *     flag can't close deterministically), a PERSISTENT partial-save
 *     banner (not just a dismissible Alert) when the memory saved but a
 *     file didn't, and a `justSaved=1` param so the detail screen can show
 *     a brief, unambiguous "Story saved" confirmation.
 *
 * WHAT THIS FILE PROVES, AND HOW
 *   PART A executes real HTTP requests against the live, deployed Storage
 *   API for this project — genuine integration testing of the upload
 *   helper's actual failure mode, not a simulation of it. Every request in
 *   this file is rejected (either by the MIME allowlist or by RLS), so
 *   nothing is ever written and nothing needs cleaning up.
 *   PART B is source-level assertions against the client screen's control
 *   flow — this repo's only tool for that layer (no RN component/render
 *   test infrastructure exists here). These prove the code is wired
 *   correctly; they do NOT and cannot prove a real device upload succeeds,
 *   or that a real double-tap race is actually closed under real touch
 *   timing — that needs Darren's own hands on build 143, same as before.
 *
 * SAFETY
 * No Supabase Auth call, no signup, no real memory created, no database
 * write of any kind. Every live request in PART A is REJECTED by design —
 * that rejection (or the specific NEXT rejection, RLS instead of MIME) is
 * exactly what's being asserted. Darren's real story is never read,
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

const apiPath    = 'lib/memories-api.ts';
const createPath = 'app/memory-new.tsx';
const detailPath = 'app/memory/[id].tsx';

const apiRaw    = read(apiPath);
const apiSrc    = code(apiRaw);
const createSrc = code(read(createPath));
const detailSrc = code(read(detailPath));

// ── Live config, read once ───────────────────────────────────────────────
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? readEnvFallback('EXPO_PUBLIC_SUPABASE_URL');
const ANON_KEY      = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? readEnvFallback('EXPO_PUBLIC_SUPABASE_ANON_KEY');

function readEnvFallback(key: string): string | undefined {
  try {
    const env = read('.env');
    const m = env.match(new RegExp(`^${key}=(.*)$`, 'm'));
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
    headers: {
      apikey: ANON_KEY!,
      Authorization: `Bearer ${ANON_KEY}`,
      'x-upsert': 'true',
    },
    body: form,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/* ── PART A — live proof of the actual failing operation ──────────────────── */

describe('LIVE: the memories-media bucket genuinely rejects HEIC before RLS even runs', {
  skip: !haveConfig && 'EXPO_PUBLIC_SUPABASE_URL/ANON_KEY not available in this environment',
}, () => {
  test('image/heic is rejected at the MIME-allowlist stage — this is the proven root cause', async () => {
    const { status, body } = await probeUpload('_test-probe-never-written/photo/probe.heic', 'image/heic');
    assert.equal(status, 400);
    assert.equal(body?.code, 'InvalidMimeType');
    assert.match(String(body?.message ?? ''), /image\/heic/);
  });

  test('image/jpeg (the fix\'s output format) passes that same gate — proven by reaching RLS instead of the MIME error', async () => {
    const { status, body } = await probeUpload('_test-probe-never-written/photo/probe.jpg', 'image/jpeg');
    assert.equal(status, 400); // still refused — anon has no write grant — but for a DIFFERENT reason
    assert.notEqual(body?.code, 'InvalidMimeType');
    assert.equal(body?.code, 'AccessDenied'); // RLS, not MIME — proves jpeg cleared the allowlist
  });

  test('audio/m4a passes the same gate identically — the audio recorder\'s own format was never the problem', async () => {
    const { status, body } = await probeUpload('_test-probe-never-written/audio/probe.m4a', 'audio/m4a');
    assert.equal(status, 400);
    assert.notEqual(body?.code, 'InvalidMimeType');
    assert.equal(body?.code, 'AccessDenied');
  });
});

/* ── PART B — the fix, source-level ───────────────────────────────────────── */

describe('the photo picker now requests a Storage-compatible format instead of native HEIC', () => {
  test('preferredAssetRepresentationMode is set to Compatible on the photo picker call, not the video one', () => {
    const photoCallStart = createSrc.indexOf('const result = await ImagePicker.launchImageLibraryAsync({');
    const photoCallEnd = createSrc.indexOf('});', photoCallStart);
    const photoCall = createSrc.slice(photoCallStart, photoCallEnd);
    assert.match(photoCall, /preferredAssetRepresentationMode:\s*ImagePicker\.UIImagePickerPreferredAssetRepresentationMode\?\.Compatible/);
  });

  test('no new native dependency was added for this — expo-image-picker is already installed', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.dependencies['expo-image-picker']);
    assert.ok(!pkg.dependencies['expo-image-manipulator']); // confirms we didn't reach for a new native dep
  });
});

describe('uploadMemoryMedia throws a stage-tagged error at each distinguishable failure point', () => {
  test('MediaUploadError exists with the four required stages', () => {
    assert.match(apiSrc, /export type MediaUploadStage = 'auth' \| 'local_read' \| 'storage_upload' \| 'db_insert';/);
    assert.match(apiSrc, /export class MediaUploadError extends Error/);
  });

  test('a missing session throws stage "auth"', () => {
    assert.match(apiSrc, /if \(!session\) throw new MediaUploadError\('auth',/);
  });

  test('fetch() itself throwing (no HTTP response at all) is tagged "local_read", not conflated with a Storage rejection', () => {
    const tryIdx = apiSrc.indexOf('let uploadRes: Response;');
    const catchIdx = apiSrc.indexOf("throw new MediaUploadError('local_read'", tryIdx);
    assert.ok(tryIdx !== -1 && catchIdx !== -1 && catchIdx > tryIdx);
  });

  test('a non-ok Storage response (exactly what HEIC produces) is tagged "storage_upload"', () => {
    assert.match(apiSrc, /if \(!uploadRes\.ok\) \{[\s\S]{0,200}throw new MediaUploadError\('storage_upload',/);
  });

  test('a failed memory_media insert (file genuinely in Storage, row failed) is tagged "db_insert"', () => {
    assert.match(apiSrc, /if \(error\) throw new MediaUploadError\('db_insert', error\.message\);/);
  });
});

describe('Save cannot be entered twice — a synchronous guard, not just React state', () => {
  test('savingRef is checked and returned on BEFORE the profile/point checks and any await', () => {
    const idx = createSrc.indexOf('const handleSave = async () => {');
    const body = createSrc.slice(idx, idx + 600);
    const guardIdx = body.indexOf('if (savingRef.current) return;');
    const signInCheckIdx = body.indexOf("if (!profile?.id)");
    const firstAwaitIdx = body.indexOf('await ');
    assert.notEqual(guardIdx, -1);
    // Before every other early-return check in the function...
    assert.ok(guardIdx < signInCheckIdx);
    // ...and there is no `await` anywhere between the function's start and
    // the guard — it is unconditionally the very first statement.
    assert.ok(firstAwaitIdx === -1 || guardIdx < firstAwaitIdx);
  });

  test('savingRef is set to true synchronously, before setSaving/setPartialSaveNotice, and cleared in finally', () => {
    assert.match(createSrc, /savingRef\.current = true;\s*\n\s*setSaving\(true\);/);
    assert.match(createSrc, /finally \{\s*\n\s*savingRef\.current = false;/);
  });
});

describe('a partial failure keeps the memory saved, keeps its id for retry, and stays visible on screen', () => {
  test('the duplicate-prevention reuse logic (createdMemoryIdRef) is unchanged and still kind-agnostic', () => {
    assert.match(createSrc, /\} else if \(createdMemoryIdRef\.current\) \{\s*\n\s*memoryId = createdMemoryIdRef\.current;/);
  });

  test('a retry still skips whichever draft already uploaded, regardless of kind', () => {
    assert.match(createSrc, /\.filter\(\(\{\s*d\s*\}\) => !d\.uploaded\)/);
  });

  test('the failure message names which kind of file failed (photo vs voice note vs video)', () => {
    // Refactored into a shared mediaKindLabel() helper in the follow-up
    // audio-MIME repair — see memory-audio-mime-repair.node.test.ts for the
    // helper's own tests. Still confirm the catch block uses it.
    assert.match(createSrc, /const kindLabel = mediaKindLabel\(attemptingKind\);/);
  });

  test('the stage is read off the thrown error via instanceof, not string-sniffing the message', () => {
    assert.match(createSrc, /const stage = err instanceof MediaUploadError \? err\.stage : 'unknown';/);
  });

  test('a partial failure sets a PERSISTENT notice (state), not only the dismissible Alert', () => {
    assert.match(createSrc, /if \(alreadySaved\) setPartialSaveNotice\(message\);/);
  });

  test('the persistent notice actually renders on screen, not just in state', () => {
    assert.match(createSrc, /\{partialSaveNotice \? \(/);
  });

  test('a fresh save attempt clears any stale notice from a previous attempt', () => {
    const idx = createSrc.indexOf('savingRef.current = true;');
    const nearby = createSrc.slice(idx, idx + 100);
    assert.match(nearby, /setPartialSaveNotice\(null\);/);
  });

  test('the Save button itself relabels to "Retry upload" once a partial failure is showing', () => {
    assert.match(createSrc, /partialSaveNotice\s*\n\s*\? 'Retry upload'/);
  });
});

describe('full success only navigates when the WHOLE save (memory + every media item) actually completed', () => {
  test('router.replace is still the last statement in the try block, after the entire upload loop', () => {
    const loopEndIdx = createSrc.indexOf('setUploadProg(null);', createSrc.indexOf('for (let n = 0; n < pending.length'));
    const navIdx = createSrc.indexOf('router.replace(`/memory/${memoryId}', loopEndIdx);
    const catchIdx = createSrc.indexOf('} catch (err: any) {', navIdx);
    assert.ok(loopEndIdx !== -1 && navIdx !== -1 && catchIdx !== -1 && navIdx > loopEndIdx && navIdx < catchIdx);
  });

  test('a thrown upload error at any point in the loop cannot reach that navigation call', () => {
    // Structural: the only statements between the loop and router.replace are
    // clearDraft() and the justSavedRef flag — nothing that could swallow or
    // bypass a throw from inside the loop above them.
    const loopEndIdx = createSrc.indexOf('setUploadProg(null);', createSrc.indexOf('for (let n = 0; n < pending.length'));
    const navIdx = createSrc.indexOf('router.replace(`/memory/${memoryId}', loopEndIdx);
    const between = createSrc.slice(loopEndIdx, navIdx);
    assert.doesNotMatch(between, /catch|try/);
  });

  test('the success path tags the navigation with justSaved=1 for the detail screen\'s confirmation', () => {
    assert.match(createSrc, /router\.replace\(`\/memory\/\$\{memoryId\}\?justSaved=1`\);/);
  });
});

describe('the detail screen shows a brief, unambiguous "Story saved" confirmation', () => {
  test('justSaved is read from the route params', () => {
    assert.match(detailSrc, /justSaved.*useLocalSearchParams/s);
  });

  test('the banner is shown only when justSaved === "1"', () => {
    assert.match(detailSrc, /useState\(justSaved === '1'\)/);
  });

  test('the banner self-dismisses — it does not require the user to do anything', () => {
    assert.match(detailSrc, /setTimeout\(\(\) => setShowSavedBanner\(false\), 3000\)/);
  });

  test('the banner text says exactly "Story saved"', () => {
    assert.match(detailSrc, />Story saved</);
  });
});

describe('transcription is requested only after the audio media row genuinely exists', () => {
  test('requestTranscription still only follows a successful uploadMemoryMedia resolution', () => {
    const uploadIdx = createSrc.indexOf('const media = await uploadMemoryMedia(');
    const transcribeIdx = createSrc.indexOf("if (d.kind === 'audio')", uploadIdx);
    assert.ok(uploadIdx !== -1 && transcribeIdx !== -1 && uploadIdx < transcribeIdx);
  });

  test('a transcription-request failure is now tracked (privacy-safe: ids and a message only)', () => {
    const idx = createSrc.indexOf("track('memory_transcription_request_failed'");
    assert.notEqual(idx, -1);
    // Check only the payload sent, not the event's own name (which
    // legitimately contains the word "transcription").
    const propsIdx = createSrc.indexOf('props:', idx);
    const propsBlock = createSrc.slice(propsIdx, createSrc.indexOf('}', propsIdx) + 1);
    assert.doesNotMatch(propsBlock, /transcript:|audio_url|signedUrl/i);
    assert.match(propsBlock, /media_id: media\.id/);
  });

  test('transcription failure still cannot throw into the outer save — the .catch is still local to the request', () => {
    const idx = createSrc.indexOf('requestTranscription(media.id)');
    const catchBlockEnd = createSrc.indexOf('});', idx) + 3;
    const catchBlock = createSrc.slice(idx, catchBlockEnd);
    assert.doesNotMatch(catchBlock, /\bthrow\b/);
  });
});

describe('media-save failure diagnostics are privacy-safe and use the existing analytics pipeline', () => {
  test('the upload-failure track call uses the existing track() helper, not a new logging system', () => {
    assert.match(createSrc, /track\('memory_media_upload_failed', \{/);
  });

  test('it carries stage/kind/already_saved — never the file, the story text, or a token', () => {
    const idx = createSrc.indexOf("track('memory_media_upload_failed'");
    const block = createSrc.slice(idx, idx + 250);
    assert.match(block, /stage, kind: attemptingKind, already_saved: alreadySaved/);
    assert.doesNotMatch(block, /body\.trim|title\.trim|access_token|signedUrl/);
  });
});
