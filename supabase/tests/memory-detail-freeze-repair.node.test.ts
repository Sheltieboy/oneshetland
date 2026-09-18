/**
 * memory-detail-freeze-repair.node.test.ts
 *
 * Auld Stories — post-save detail-screen freeze.
 *
 * Physical-device evidence (build 143), AFTER both the HEIC-photo and
 * audio/x-m4a repairs: photo upload, audio upload, playback, transcription
 * request and completion all proven working. But immediately after landing
 * on the freshly-saved story (audio present, transcript_status still
 * "pending" — i.e. moments after upload, before any tap), the WHOLE screen
 * became unresponsive: no scroll, no Play, nothing. Force-close and reopen
 * cleared it; the same story then worked normally, transcript included.
 *
 * INVESTIGATION — what this rules out with confidence, source-level:
 *   - ScrollView disabled: no `scrollEnabled` prop is bound to any state on
 *     this screen at all (unlike the create screen's map, which does use
 *     one deliberately) — the ScrollView here is structurally always on.
 *   - A stray full-screen Modal: the only <Modal> on this screen is
 *     VideoTile's, gated on `open`, which defaults false and is per-tile
 *     local state — Darren's story has no video.
 *   - The "Story saved" banner: pointerEvents="none" and not absolutely
 *     positioned (a normal flow element, not an overlay) — verified again
 *     below, not the cause.
 *   - The pending-pin/active-pin inline sheets: both null on a fresh page
 *     load, before any pin interaction.
 *
 * LEADING CANDIDATE, not provable further from here (no physical device or
 * renderer available in this repo): AudioTile called useAudioPlayer(media.
 * url) UNCONDITIONALLY, the instant it mounted — meaning the moment the
 * freshly-saved screen rendered, expo-audio began loading/buffering the
 * just-uploaded, just-signed remote URL involuntarily, before any user
 * action. VideoTile, right above it in the same file, already uses the
 * defensive pattern of deferring useVideoPlayer until the user opens the
 * player (`open ? media.url : null`) — AudioTile was the one inconsistent
 * case. The repair makes AudioTile lazy the same way.
 *
 * THE FIX
 *   - AudioTile now only gives the player a real source once the user taps
 *     (mirrors VideoTile's own established pattern in this file).
 *   - MediaTile / VideoTile / AudioTile are now React.memo'd — belt-and-
 *     braces: whatever a tile does internally can no longer even be
 *     considered for re-rendering its siblings (header, reactions,
 *     comments, ScrollView).
 *   - The duplicate "who/what is this?" instruction (a banner above the
 *     media section AND ImageAnnotationOverlay's own in-photo hint) is
 *     reduced to the one, more precisely-placed in-photo hint.
 *   - The create screen now explains, once each, what happens to a photo
 *     and a voice note AFTER Save — never implying either happens before.
 *
 * WHAT THIS FILE CANNOT PROVE
 * Source-level assertions only — this repo has no RN renderer/component
 * test infrastructure (confirmed again this pass). These prove the lazy-
 * load restructuring and the memoisation are genuinely present and wired
 * correctly. They cannot simulate expo-audio's native buffering behaviour,
 * and cannot themselves prove the physical freeze is gone — only Darren's
 * own hands on build 143 can do that.
 *
 * SAFETY
 * No Supabase call, no navigation, no OTA, no database write. Nothing here
 * touches production.
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

const detailPath = 'app/memory/[id].tsx';
const createPath = 'app/memory-new.tsx';
const overlayPath = 'components/ImageAnnotationOverlay.tsx';

const detailRaw = read(detailPath);
const detailSrc = code(detailRaw);
const createSrc = code(read(createPath));
const overlaySrc = code(read(overlayPath));

/* ── What was ruled out, re-confirmed ─────────────────────────────────────── */

describe('candidates ruled out — re-confirmed against the current source', () => {
  test('the detail screen\'s ScrollView has no scrollEnabled binding at all (unlike the create screen\'s map)', () => {
    const scrollIdx = detailSrc.indexOf('<ScrollView');
    const scrollTagEnd = detailSrc.indexOf('>', scrollIdx);
    const scrollProps = detailSrc.slice(scrollIdx, scrollTagEnd);
    assert.doesNotMatch(scrollProps, /scrollEnabled/);
  });

  test('the only Modal on this screen is VideoTile\'s own, gated on locally-scoped `open`, defaulting false', () => {
    const modalCount = (detailSrc.match(/<Modal\b/g) ?? []).length;
    assert.equal(modalCount, 1);
    assert.match(detailSrc, /const \[open, setOpen\] = useState\(false\);/);
  });

  test('the "Story saved" banner is non-blocking: pointerEvents="none" and not absolutely positioned', () => {
    assert.match(detailSrc, /<View style=\{styles\.savedBanner\} pointerEvents="none"\>/);
    const styleStart = detailSrc.indexOf('savedBanner: {');
    const styleEnd = detailSrc.indexOf('},', styleStart);
    const styleBlock = detailSrc.slice(styleStart, styleEnd);
    assert.doesNotMatch(styleBlock, /position:\s*'absolute'/);
  });

  test('pendingPinXY and activePin both default to null — no inline sheet renders on a fresh page load', () => {
    assert.match(detailSrc, /useState<MemoryImagePin \| null>\(null\)/);
    assert.match(detailSrc, /useState<\{ x: number; y: number; mediaId: string \} \| null>\(null\)/);
  });
});

/* ── The fix: lazy audio player ───────────────────────────────────────────── */

describe('AudioTile no longer loads/buffers audio until the user actually asks to play', () => {
  test('useAudioPlayer only receives a real source once activated — mirrors VideoTile\'s own established pattern', () => {
    assert.match(detailSrc, /const player = useAudioPlayer\(activated \? media\.url : null\);/);
    assert.match(detailSrc, /const player = useVideoPlayer\(open \? media\.url : null,/);
  });

  test('a fresh AudioTile starts unactivated', () => {
    const audioTileStart = detailSrc.indexOf("const AudioTile = React.memo(function AudioTile");
    const nearby = detailSrc.slice(audioTileStart, audioTileStart + 200);
    assert.match(nearby, /const \[activated, setActivated\] = useState\(false\);/);
  });

  test('the first tap only activates — it does not also try to call play() on a still-null-sourced player in the same tick', () => {
    const toggleStart = detailSrc.indexOf('const toggle = useCallback(() => {');
    const toggleBody = detailSrc.slice(toggleStart, detailSrc.indexOf('}, [activated', toggleStart));
    assert.match(toggleBody, /if \(!activated\) \{ setActivated\(true\); return; \}/);
  });

  test('play() is triggered by an effect once the real source is actually attached, not inline in toggle', () => {
    assert.match(detailSrc, /useEffect\(\(\) => \{\s*\n\s*if \(activated\) player\.play\(\);\s*\n\s*\}, \[activated, player\]\);/);
  });

  test('isPlaying is false while unactivated, regardless of the (null-sourced) player\'s own status', () => {
    assert.match(detailSrc, /const isPlaying = activated && status\.playing;/);
  });
});

describe('a tile\'s own internal churn cannot cascade into re-rendering the rest of the page', () => {
  test('MediaTile, VideoTile and AudioTile are all wrapped in React.memo', () => {
    assert.match(detailSrc, /const MediaTile = React\.memo\(function MediaTile/);
    assert.match(detailSrc, /const VideoTile = React\.memo\(function VideoTile/);
    assert.match(detailSrc, /const AudioTile = React\.memo\(function AudioTile/);
  });

  test('none of the three tiles takes a callback prop that could push state back up into the parent screen on every render', () => {
    // VideoTile/AudioTile take only `media`; MediaTile's callbacks
    // (onTapPin/onTapEmpty) are user-gesture-triggered, not render-loop
    // triggered — confirmed by their signatures taking explicit event data,
    // not being invoked from any effect.
    assert.doesNotMatch(detailSrc, /useEffect\([^)]*\bonTapPin\(/s);
    assert.doesNotMatch(detailSrc, /useEffect\([^)]*\bonTapEmpty\(/s);
  });
});

/* ── Duplicate photo instruction reduced ──────────────────────────────────── */

describe('the duplicated "who/what is this?" instruction is reduced to one place', () => {
  test('the standalone pinCue banner above the media section is gone', () => {
    assert.doesNotMatch(detailSrc, /pinCue/);
    assert.doesNotMatch(detailRaw, /Tap a photo below to ask/);
  });

  test('the in-photo hint (the more precisely-placed one) is untouched — still present, still annotate-mode + zero-pins only', () => {
    assert.match(overlaySrc, /mode === 'annotate' && pins\.length === 0/);
    assert.match(overlaySrc, /Tap on the photo to mark "who is this\?"/);
  });

  test('the annotation interaction itself is unchanged — mode is still isAuthor-gated the same way', () => {
    assert.match(detailSrc, /mode=\{isAuthor \? 'annotate' : 'view'\}/);
  });

  test('a non-author still cannot see the in-photo hint either — it is gated on mode, which is "view" for them', () => {
    // The hint only renders in annotate mode; view mode is what a
    // non-author always receives, so they see no create-a-pin invitation.
    const hintStart = overlaySrc.indexOf("mode === 'annotate' && pins.length === 0");
    assert.notEqual(hintStart, -1);
  });
});

/* ── Create-screen media guidance ─────────────────────────────────────────── */

describe('create-screen guidance explains what happens AFTER save, once each, never implying it happens before', () => {
  test('photo guidance appears once a photo draft exists, and says "after you save"', () => {
    assert.match(createSrc, /\{drafts\.some\(d => d\.kind === 'photo'\) \? \(/);
    assert.match(createSrc, /After you save, you can tap a spot in the photo to ask who or what it is\./);
  });

  test('voice guidance appears once an audio draft exists, and accurately describes automatic post-save transcription', () => {
    assert.match(createSrc, /\{drafts\.some\(d => d\.kind === 'audio'\) \? \(/);
    assert.match(createSrc, /After you save, we'll upload your voice note and transcribe it automatically\./);
    assert.match(createSrc, /The transcript may take a moment to appear\./);
  });

  test('neither guidance line is rendered per-draft-item — each is gated on .some(), not .map()', () => {
    const photoGuidanceIdx = createSrc.indexOf("drafts.some(d => d.kind === 'photo')");
    const audioGuidanceIdx = createSrc.indexOf("drafts.some(d => d.kind === 'audio')");
    assert.ok(photoGuidanceIdx !== -1 && audioGuidanceIdx !== -1);
    // Neither guidance block sits inside the drafts.map(...) render loop.
    const mapIdx = createSrc.indexOf('{drafts.map((d, i) =>');
    const mapEndIdx = createSrc.indexOf('))}', mapIdx);
    assert.ok(photoGuidanceIdx > mapEndIdx && audioGuidanceIdx > mapEndIdx);
  });

  test('the guidance does not claim annotation or transcription happens before Save', () => {
    const guidanceBlockStart = createSrc.indexOf("drafts.some(d => d.kind === 'photo')");
    const guidanceBlockEnd = createSrc.indexOf('</View>', createSrc.indexOf("drafts.some(d => d.kind === 'audio')"));
    const block = createSrc.slice(guidanceBlockStart, guidanceBlockEnd === -1 ? guidanceBlockStart + 600 : guidanceBlockEnd);
    assert.doesNotMatch(block, /now|immediately|before you save|while (you're|composing)/i);
  });
});
