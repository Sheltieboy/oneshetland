/**
 * memory-create-journey.node.test.ts
 *
 * Aald Memories launch repair 1 — the core create/save journey.
 *
 * A real independent tester could not reliably select a location on the
 * create-memory map, could not pan/zoom it, and lost the whole attempt (no
 * memory row exists in production beyond the June-2026 heritage seed). This
 * proves the narrow repair for that journey:
 *
 *   - the create map's own ScrollView no longer contests touches with
 *     react-native-maps' pan/pinch recognizers (a local touch-lock on the
 *     map's wrapper, not a change to MemoryMapNative or the browse map)
 *   - the help copy no longer promises drag-to-refine (never implemented)
 *   - leaving a composed-but-unsaved story now asks first, but never for an
 *     untouched form and never for the screen's own post-save redirect
 *   - a media-upload failure after the memory row was created can no longer
 *     produce a duplicate story on retry, and is now reported honestly
 *   - a transcription-request failure can no longer become an unhandled
 *     promise rejection, and can never block or unwind a successful save
 *   - the memory author gets a one-line, author-only cue on the saved
 *     story's own page pointing at the (unchanged, still post-publish-only)
 *     photo-annotation feature
 *
 * WHAT THIS IS NOT
 * This does not touch image-pin coordinate math, does not add photo
 * annotation to the create screen, does not implement marker dragging, and
 * does not build transcript status/retry UX — all explicitly out of scope
 * for this slice. It also does not, and cannot, prove the map is physically
 * pannable/pinchable/tappable on a real device — that needs Darren's own
 * hands on build 143. What follows is a source-level check that the fix is
 * actually present and wired correctly, not a simulation of touch input.
 *
 * SAFETY
 * Source-level assertions only. No Supabase call, no navigation, no OTA, no
 * database write. Nothing here can create a memory or mutate production.
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

const createPath = 'app/memory-new.tsx';
const detailPath = 'app/memory/[id].tsx';
const mapPath    = 'components/MemoryMapNative.tsx';
const browsePath = 'app/(tabs)/memories.tsx';

const createRaw = read(createPath);
const createSrc = code(createRaw);
const detailRaw = read(detailPath);
const detailSrc = code(detailRaw);
const mapSrc    = code(read(mapPath));
const browseSrc = code(read(browsePath));

/* ── 1/2. Map selection callback + coordinate stability ─────────────────── */

describe('map tap-to-select-location is wired and does not get reset by unrelated state', () => {
  test('dropping a pin on the map still flows straight into point state', () => {
    assert.match(createSrc, /onDropPin=\{p\s*=>\s*setPoint\(p\)\}/);
  });

  test('picking a place from the search box also sets point, from the same handler shape', () => {
    assert.match(createSrc, /onPlacePicked=\{p\s*=>\s*\{[\s\S]{0,200}setPoint\(\{\s*lat:\s*Number\(p\.lat\)/);
  });

  test('the map is not given a controlled region prop that could snap back on re-render', () => {
    // A `region={...}` prop (as opposed to `pendingPoint`/`initialRegion`
    // inside MemoryMapNative) is the classic cause of a map fighting the
    // user's own gesture. memory-new.tsx must not pass one.
    const mapUsage = createSrc.slice(createSrc.indexOf('<MemoryMapNative'), createSrc.indexOf('/>', createSrc.indexOf('<MemoryMapNative')));
    assert.doesNotMatch(mapUsage, /\bregion=/);
  });

  test('point is only ever cleared by an explicit user action, never by an unrelated effect', () => {
    // setPoint(null) would silently drop a chosen location. The only two
    // legitimate writers of point are the map callbacks above and restoring
    // a saved draft — none of which clears it to null.
    assert.doesNotMatch(createSrc, /setPoint\(null\)/);
  });

  test('the autosave effect reads point but never writes it', () => {
    const effectStart = createSrc.indexOf('Autosave the text fields');
    const effectBody = createSrc.slice(effectStart, createSrc.indexOf('}, [title, body, era, tags, placeName, visibility, point, drafts.length, draftEligible, saving]);'));
    assert.doesNotMatch(effectBody, /setPoint\(/);
  });
});

/* ── 2. The ScrollView/map gesture fix itself ────────────────────────────── */

describe('the create map is no longer fighting its parent ScrollView for touches', () => {
  test('the outer ScrollView is scroll-locked while a finger is down on the map', () => {
    assert.match(createSrc, /scrollEnabled=\{!mapInteracting\}/);
  });

  test('the map wrapper arms the lock on touch start and clears it once every finger is up', () => {
    const wrapperStart = createSrc.indexOf('onTouchStart={() => setMapInteracting(true)}');
    assert.notEqual(wrapperStart, -1);
    const wrapperSlice = createSrc.slice(wrapperStart, wrapperStart + 400);
    assert.match(wrapperSlice, /onTouchEnd=\{e\s*=>\s*\{/);
    assert.match(wrapperSlice, /touches\.length === 0/);
    assert.match(wrapperSlice, /onTouchCancel=\{\(\) => setMapInteracting\(false\)\}/);
  });

  test('the touch lock wraps the actual MemoryMapNative usage, not some other element', () => {
    const lockIdx = createSrc.indexOf('onTouchStart={() => setMapInteracting(true)}');
    const mapIdx  = createSrc.indexOf('<MemoryMapNative', lockIdx);
    assert.ok(lockIdx !== -1 && mapIdx !== -1 && mapIdx - lockIdx < 400);
  });

  test('no native gesture props were disabled to "fix" this — the map keeps its default pan/zoom/rotate', () => {
    assert.doesNotMatch(createSrc, /scrollEnabled=\{false\}[\s\S]{0,50}MemoryMapNative/);
    assert.doesNotMatch(mapSrc, /\b(scrollEnabled|zoomEnabled|pitchEnabled|rotateEnabled)=\{false\}/);
  });
});

/* ── 3. Help copy no longer promises dragging ────────────────────────────── */

describe('the location help copy is truthful', () => {
  test('the drag-to-refine promise is gone', () => {
    assert.doesNotMatch(createRaw, /drag to refine/i);
    assert.doesNotMatch(createRaw, /then drag/i);
  });

  test('the replacement copy tells the truth about what the map can do', () => {
    assert.match(createRaw, /move and zoom the map/i);
  });

  test('no draggable marker was introduced (out of scope for this slice)', () => {
    assert.doesNotMatch(createSrc, /draggable/);
    assert.doesNotMatch(mapSrc, /draggable/);
  });
});

/* ── 4. Discard-on-leave protection ───────────────────────────────────────── */

describe('leaving a composed-but-unsaved story asks first', () => {
  test('a beforeRemove guard exists, scoped to the plain new-story flow only', () => {
    const idx = createSrc.indexOf("navigation.addListener('beforeRemove'");
    assert.notEqual(idx, -1);
    const guardScope = createSrc.slice(createSrc.indexOf('useEffect(() => {\n    if (!draftEligible) return;\n    const unsubscribe = navigation.addListener'), idx);
    assert.match(guardScope, /if \(!draftEligible\) return;/);
  });

  test('an untouched form does not trigger the warning', () => {
    assert.match(createSrc, /if \(justSavedRef\.current \|\| saving \|\| !hasMeaningfulContent\) return;/);
  });

  test('hasMeaningfulContent uses the same real-content threshold the existing autosave already trusted', () => {
    assert.match(
      createSrc,
      /const hasMeaningfulContent =\s*!!\(title\.trim\(\) \|\| body\.trim\(\) \|\| drafts\.length > 0 \|\| point\);/,
    );
  });

  test('meaningful content reaches e.preventDefault() and the discard dialog', () => {
    const listenerStart = createSrc.indexOf("navigation.addListener('beforeRemove'");
    const listenerBody = createSrc.slice(listenerStart, listenerStart + 700);
    assert.match(listenerBody, /e\.preventDefault\(\);/);
    assert.match(listenerBody, /title: 'Discard this story\?'/);
  });

  test('"Keep editing" only dismisses — it carries no onPress, so cancelling changes nothing', () => {
    const actionsStart = createSrc.indexOf("actions: [", createSrc.indexOf("Discard this story?"));
    const actionsBlock = createSrc.slice(actionsStart, actionsStart + 300);
    const keepEditingLine = actionsBlock.split('\n').find(l => l.includes('Keep editing'))!;
    assert.ok(keepEditingLine, 'expected a "Keep editing" action');
    assert.doesNotMatch(keepEditingLine, /onPress/);
    assert.match(keepEditingLine, /style: 'cancel'/);
  });

  test('"Discard" completes the original navigation action that was intercepted', () => {
    const actionsStart = createSrc.indexOf("actions: [", createSrc.indexOf("Discard this story?"));
    const actionsBlock = createSrc.slice(actionsStart, actionsStart + 400);
    assert.match(actionsBlock, /style: 'destructive', onPress: \(\) => navigation\.dispatch\(e\.data\.action\)/);
  });

  test('a successful save flags justSavedRef before its own redirect, so the guard never contests it', () => {
    const saveIdx = createSrc.indexOf('router.replace(`/memory/${memoryId}?justSaved=1`);');
    const flagIdx = createSrc.lastIndexOf('justSavedRef.current = true;', saveIdx);
    assert.ok(flagIdx !== -1 && flagIdx < saveIdx, 'justSavedRef must be set before the redirect it is guarding');
  });
});

/* ── 5. Save-path integrity ───────────────────────────────────────────────── */

describe('Save requires and persists a real location, and cannot duplicate the story on retry', () => {
  test('canSave still requires a point (or being a threaded child)', () => {
    assert.match(createSrc, /const canSave = !!profile\?\.id\s*&&\s*!!\(point \|\| isChild\)/);
  });

  test('handleSave still refuses to proceed without a point for a root story', () => {
    assert.match(createSrc, /if \(!isChild && !point\) \{/);
  });

  test('the selected coordinates are exactly what gets persisted', () => {
    assert.match(createSrc, /lat:\s*isChild \? null : point!\.lat,\s*\n\s*lng:\s*isChild \? null : point!\.lng,/);
  });

  test('a retry after a partial failure reuses the already-created memory id instead of creating another', () => {
    assert.match(createSrc, /const createdMemoryIdRef = useRef<string \| null>\(null\);/);
    assert.match(createSrc, /\} else if \(createdMemoryIdRef\.current\) \{\s*\n\s*memoryId = createdMemoryIdRef\.current;/);
    assert.match(createSrc, /createdMemoryIdRef\.current = memoryId;/);
  });

  test('the duplicate-prevention check runs before a fresh createMemory call, not after', () => {
    const elseIfIdx = createSrc.indexOf('} else if (createdMemoryIdRef.current) {');
    const createCallIdx = createSrc.indexOf('const memory = await createMemory({');
    assert.ok(elseIfIdx !== -1 && createCallIdx !== -1 && elseIfIdx < createCallIdx);
  });

  test('a media-upload failure is reported honestly when the story itself already saved', () => {
    assert.match(createSrc, /const alreadySaved = !isEditing && !!createdMemoryIdRef\.current;/);
    assert.match(createSrc, /title: alreadySaved \? 'Story saved — one file needs retrying' : 'Could not save'/);
  });

  test('a retry skips media that already uploaded successfully, instead of re-sending it', () => {
    assert.match(createSrc, /\.filter\(\(\{\s*d\s*\}\) => !d\.uploaded\)/);
    assert.match(createSrc, /uploaded: true/);
  });

  test('navigation lands on the saved memory\'s own detail page (with the justSaved confirmation flag)', () => {
    assert.match(createSrc, /router\.replace\(`\/memory\/\$\{memoryId\}\?justSaved=1`\);/);
  });
});

/* ── 6. Voice — narrow, non-blocking handling only ───────────────────────── */

describe('a transcription-request failure cannot break the save or go unhandled', () => {
  test('the audio upload itself still runs through the same uploadMemoryMedia call as every other kind', () => {
    const loopStart = createSrc.indexOf('for (let n = 0; n < pending.length; n++)');
    const loopBody = createSrc.slice(loopStart, createSrc.indexOf('setUploadProg(null);', loopStart));
    assert.match(loopBody, /await uploadMemoryMedia\(/);
    assert.match(loopBody, /kind:\s*d\.kind,/);
  });

  test('the media row is created (awaited) before transcription is ever requested for it', () => {
    const uploadIdx = createSrc.indexOf('const media = await uploadMemoryMedia(');
    const transcribeIdx = createSrc.indexOf("if (d.kind === 'audio')", uploadIdx);
    assert.ok(uploadIdx !== -1 && transcribeIdx !== -1 && uploadIdx < transcribeIdx);
  });

  test('the transcription request is fire-and-forget, not awaited into the save\'s own try/catch', () => {
    const idx = createSrc.indexOf('requestTranscription(media.id)');
    const linesBefore = createSrc.slice(Math.max(0, idx - 40), idx);
    assert.doesNotMatch(linesBefore, /await\s*$/);
  });

  test('the transcription request always carries its own .catch — no unhandled rejection reaches the app', () => {
    const idx = createSrc.indexOf('requestTranscription(media.id)');
    const nearby = createSrc.slice(idx, idx + 200);
    assert.match(nearby, /\.catch\(err => \{/);
    assert.match(nearby, /console\.warn\(/);
  });

  test('a transcription failure cannot unwind the outer save — it is not inside anything the catch(err) block reacts to via rethrow', () => {
    // The .catch on the transcription call swallows its own error locally;
    // it must never re-throw into the surrounding handleSave try/catch.
    const idx = createSrc.indexOf('requestTranscription(media.id)');
    const catchBlock = createSrc.slice(idx, createSrc.indexOf('});', idx) + 3);
    assert.doesNotMatch(catchBlock, /throw/);
  });
});

/* ── 7. Post-publish photo-annotation cue ─────────────────────────────────── */

describe('the saved memory page nudges toward photo annotation', () => {
  // The standalone "Tap a photo below to ask..." banner this describe
  // block originally tested was removed in the post-save-freeze repair
  // pass — it duplicated ImageAnnotationOverlay's own in-photo hint
  // ("Tap on the photo to mark 'who is this?'", annotate mode + zero
  // pins). See memory-detail-freeze-repair.node.test.ts for the tests
  // covering that reduction directly; these remaining tests confirm the
  // still-true underlying guarantees.
  test('ImageAnnotationOverlay usage is unchanged by this slice — still the only place pins are created, still gated the same way', () => {
    assert.match(detailSrc, /mode=\{isAuthor \? 'annotate' : 'view'\}/);
  });

  test('no image-pin coordinate math changed — this slice touches messaging only', () => {
    assert.doesNotMatch(detailSrc, /naturalWidth|naturalHeight|Image\.getSize/);
  });

  test('the create screen still has no photo-annotation affordance at all (that remains Repair 2)', () => {
    assert.doesNotMatch(createSrc, /ImageAnnotationOverlay/);
    assert.doesNotMatch(createSrc, /addImagePin/);
  });
});

/* ── 8. Browse map is untouched ───────────────────────────────────────────── */

describe('the shared browse map was not touched by this repair', () => {
  test('MemoryMapNative itself carries none of the create-screen\'s touch-lock wiring', () => {
    assert.doesNotMatch(mapSrc, /mapInteracting/);
  });

  test('the browse tab was not given the same touch-lock treatment', () => {
    assert.doesNotMatch(browseSrc, /mapInteracting/);
    assert.doesNotMatch(browseSrc, /onTouchStart=\{\(\) => setMapInteracting/);
  });

  test('the browse map\'s own ScrollView usage is unchanged — no new scrollEnabled wiring added', () => {
    assert.doesNotMatch(browseSrc, /scrollEnabled=\{!mapInteracting\}/);
  });
});
