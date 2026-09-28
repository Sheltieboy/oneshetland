/**
 * memory-map-picker-refinement.node.test.ts
 *
 * Aald Memories launch repair 1b — create-map usability refinement.
 *
 * Real-device acceptance already CLOSED the underlying gesture-arbitration
 * defect (pan/pinch/tap all confirmed working on build 143 — see
 * memory-create-journey.node.test.ts, untouched by this file). This proves
 * the follow-up usability pass on top of that proven interaction:
 *
 *   - the dark full-width "Tap a place to drop the first story" banner is
 *     gone from the picker (create-map) usage, replaced by a quiet in-map
 *     hint that is never styled as a banner/card/alert
 *   - the browse map's own empty-state banner is completely untouched —
 *     the new picker prop is opt-in and defaults off
 *   - the create map's viewport is materially taller and responsive to
 *     screen height, not a fixed small preview
 *   - a first tap while the view is still wide gets an assisted zoom to
 *     the same close-in level a search result already lands at; a tap
 *     once a point already exists never re-triggers that zoom — it only
 *     moves the pin
 *   - search-result selection and map-tap selection share one interaction
 *     model (the same CLOSE_DELTA constant), not two different ones
 *
 * WHAT THIS IS NOT
 * This does not touch save logic, transcription, photo annotation, or the
 * proven touch-lock/ScrollView gesture-arbitration fix from repair 1 — all
 * explicitly out of scope here and asserted UNCHANGED below. It also
 * cannot, and does not, prove the animation or gesture feel on a physical
 * device — that's already been proven separately by Darren's own hands on
 * build 143; what follows is confirmation the refinement is present and
 * wired correctly, not a simulation of the animation itself.
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

const mapPath    = 'components/MemoryMapNative.tsx';
const createPath = 'app/memory-new.tsx';
const browsePath = 'app/(tabs)/memories.tsx';

const mapRaw    = read(mapPath);
const mapSrc    = code(mapRaw);
const createSrc = code(read(createPath));
const browseSrc = code(read(browsePath));

/* ── 1. The dark banner is gone from the picker; browse is untouched ─────── */

describe('the dark empty-state banner no longer appears on the create-map picker', () => {
  test('the picker prop exists and defaults to false, so nothing changes unless explicitly opted in', () => {
    assert.match(mapSrc, /picker\??:\s*boolean;/);
    assert.match(mapSrc, /picker = false,/);
  });

  test('the old dark banner is now explicitly gated to non-picker usage only', () => {
    const idx = mapSrc.indexOf('styles.emptyHint');
    assert.notEqual(idx, -1);
    const condition = mapSrc.slice(mapSrc.lastIndexOf('{!picker', idx), idx);
    assert.match(condition, /!picker && pins\.length === 0 && onDropPin/);
  });

  test('the create screen opts into picker mode', () => {
    const mapUsage = createSrc.slice(createSrc.indexOf('<MemoryMapNative'), createSrc.indexOf('/>', createSrc.indexOf('<MemoryMapNative')));
    assert.match(mapUsage, /\bpicker\b/);
  });

  test('the browse tab does not pass picker at all — its map keeps its original banner behaviour', () => {
    const mapUsage = browseSrc.slice(browseSrc.indexOf('<MemoryMapNative'), browseSrc.indexOf('/>', browseSrc.indexOf('<MemoryMapNative')));
    assert.doesNotMatch(mapUsage, /\bpicker\b/);
  });
});

/* ── 2. The new quiet hint replaces it, and is genuinely quiet ───────────── */

describe('the replacement hint is a quiet, subordinate label — not a banner/card/alert', () => {
  test('the new hint block exists, gated on picker mode and hidden while search is open', () => {
    assert.match(mapSrc, /\{picker && !searchOpen \? \(/);
  });

  test('the hint carries the two required copy states', () => {
    assert.match(mapRaw, /Tap the map to choose a spot/);
    assert.match(mapRaw, /Tap again to refine the exact spot/);
  });

  test('the hint styling is a small light pill using theme tokens, not the old dark full-width banner styling', () => {
    const styleBlock = mapSrc.slice(mapSrc.indexOf('pickerHint: {'), mapSrc.indexOf('pickerHintText: {') + 200);
    assert.doesNotMatch(styleBlock, /rgba\(15,\s*28,\s*38/); // the old dark banner colour
    assert.doesNotMatch(styleBlock, /left: 0,\s*right: 0/); // not full-width
    assert.match(styleBlock, /fontSize\.xs/);
    assert.match(styleBlock, /colors\.textSecondary/);
  });

  test('the hint carries no shadow/border/icon treatment that would read as a card or alert', () => {
    const styleBlock = mapSrc.slice(mapSrc.indexOf('pickerHint: {'), mapSrc.indexOf('pickerHintText: {'));
    assert.doesNotMatch(styleBlock, /shadow|borderWidth|borderColor/);
  });

  test('the old dark banner\'s own style block is untouched (still used by browse)', () => {
    assert.match(mapSrc, /emptyHint: \{[\s\S]*?backgroundColor: 'rgba\(15, 28, 38, 0\.82\)'/);
  });
});

/* ── 3. Viewport height is materially larger and responsive ─────────────── */

describe('the create map viewport is a real working map, not a small preview', () => {
  test('the create screen now derives map height from screen height instead of a small fixed constant', () => {
    assert.match(createSrc, /const mapHeight = Math\.round\(Math\.max\(400, Math\.min\(560, screenHeight \* 0\.5\)\)\);/);
  });

  test('the old fixed 300 preview height is gone from the picker usage', () => {
    const mapUsage = createSrc.slice(createSrc.indexOf('<MemoryMapNative'), createSrc.indexOf('/>', createSrc.indexOf('<MemoryMapNative')));
    assert.doesNotMatch(mapUsage, /height=\{300\}/);
    assert.match(mapUsage, /height=\{mapHeight\}/);
  });

  test('screenHeight is drawn from the same responsive layout hook already used for screenWidth', () => {
    assert.match(createSrc, /const \{ screenWidth, screenHeight \} = useAppLayout\(\);/);
  });

  test('the browse map\'s own height (460) is untouched', () => {
    assert.match(browseSrc, /height=\{mapHeight\}|height=\{460\}|mapPane\(460\)/);
  });
});

/* ── 4. First-tap assisted zoom, and only the first tap ──────────────────── */

describe('first point selection updates coordinates and may request an assisted zoom', () => {
  test('onDropPin still fires with the tapped coordinate on every tap', () => {
    const bodyStart = mapSrc.indexOf('const handleMapPress = (e: any) => {');
    const body = mapSrc.slice(bodyStart, mapSrc.indexOf('\n  };', bodyStart));
    assert.match(body, /onDropPin\(\{ lat: latitude, lng: longitude \}\);/);
  });

  test('"first pick" is defined as picker mode with no existing pendingPoint at tap time', () => {
    assert.match(mapSrc, /const isFirstPick = picker && !pendingPoint;/);
  });

  test('the assisted zoom is requested only for a first pick, and only when the view is still wide (past ASSIST_ZOOM_THRESHOLD)', () => {
    assert.match(mapSrc, /if \(isFirstPick && latDelta > ASSIST_ZOOM_THRESHOLD\) \{/);
  });

  test('onDropPin is called before the zoom decision, not after — the pin always lands even if no zoom follows', () => {
    const dropIdx = mapSrc.indexOf('onDropPin({ lat: latitude, lng: longitude });');
    const zoomIdx = mapSrc.indexOf('if (isFirstPick && latDelta > ASSIST_ZOOM_THRESHOLD)');
    assert.ok(dropIdx !== -1 && zoomIdx !== -1 && dropIdx < zoomIdx);
  });

  test('the assisted zoom lands on the same CLOSE_DELTA search results already use', () => {
    const zoomBlock = mapSrc.slice(mapSrc.indexOf('if (isFirstPick'), mapSrc.indexOf('}, 600);', mapSrc.indexOf('if (isFirstPick')) + 10);
    assert.match(zoomBlock, /latitudeDelta:\s*CLOSE_DELTA,/);
    assert.match(zoomBlock, /longitudeDelta:\s*CLOSE_DELTA,/);
  });

  test('CLOSE_DELTA and ASSIST_ZOOM_THRESHOLD are the two named constants driving this — not magic numbers scattered around', () => {
    assert.match(mapSrc, /const CLOSE_DELTA = 0\.06;/);
    assert.match(mapSrc, /const ASSIST_ZOOM_THRESHOLD = 0\.15;/);
  });
});

/* ── 5. Subsequent taps never re-trigger the assisted zoom ───────────────── */

describe('subsequent point selection only moves the pin — no repeated forced zoom', () => {
  test('the zoom condition is gated on isFirstPick, which is false whenever pendingPoint already exists', () => {
    // pendingPoint is the CURRENT prop value at the moment of the tap — once
    // a point exists, isFirstPick can never be true again for this map
    // instance, so every later tap falls straight through to just onDropPin.
    assert.match(mapSrc, /const isFirstPick = picker && !pendingPoint;/);
  });

  test('there is exactly one animateToRegion call inside handleMapPress — no per-tap recentring loop', () => {
    const bodyStart = mapSrc.indexOf('const handleMapPress = (e: any) => {');
    const body = mapSrc.slice(bodyStart, mapSrc.indexOf('\n  };', bodyStart));
    const matches = body.match(/animateToRegion/g) ?? [];
    assert.equal(matches.length, 1);
  });

  test('nothing in handleMapPress resets pendingPoint or forces the map back to a wide region', () => {
    const bodyStart = mapSrc.indexOf('const handleMapPress = (e: any) => {');
    const body = mapSrc.slice(bodyStart, mapSrc.indexOf('\n  };', bodyStart));
    assert.doesNotMatch(body, /SHETLAND_REGION/);
  });
});

/* ── 6. Search-result selection shares the same refine-location flow ─────── */

describe('search-result selection and map-tap selection are one interaction model', () => {
  test('flyToPlace zooms to the exact same CLOSE_DELTA constant the assisted tap-zoom uses, not its own separate number', () => {
    const flyStart = mapSrc.indexOf('const flyToPlace = (place: ShetlandPlace) => {');
    const flyBody = mapSrc.slice(flyStart, mapSrc.indexOf('};', flyStart));
    assert.match(flyBody, /latitudeDelta:\s*CLOSE_DELTA,/);
    assert.match(flyBody, /longitudeDelta:\s*CLOSE_DELTA,/);
    assert.doesNotMatch(flyBody, /latitudeDelta:\s*0\.06/); // no separate hardcoded duplicate
  });

  test('picking a search result still sets the provisional point via onPlacePicked, same as before', () => {
    assert.match(createSrc, /onPlacePicked=\{p\s*=>\s*\{[\s\S]{0,200}setPoint\(\{\s*lat:\s*Number\(p\.lat\)/);
  });

  test('the map stays interactive after a search pick — no lock/disable step introduced', () => {
    const flyStart = mapSrc.indexOf('const flyToPlace = (place: ShetlandPlace) => {');
    const flyBody = mapSrc.slice(flyStart, mapSrc.indexOf('};', flyStart));
    assert.doesNotMatch(flyBody, /setMapInteracting|scrollEnabled/);
  });
});

/* ── 7. The persisted coordinate is always the final one chosen ──────────── */

describe('Save still persists whatever point was chosen last, not the first provisional one', () => {
  test('createMemory/updateMemory still read directly from the current point state, not a cached first-tap value', () => {
    assert.match(createSrc, /lat:\s*isChild \? null : point!\.lat,\s*\n\s*lng:\s*isChild \? null : point!\.lng,/);
  });

  test('there is no separate "provisional" vs "final" coordinate variable — point is the single source of truth throughout', () => {
    assert.doesNotMatch(createSrc, /provisionalPoint|firstPoint|initialTap/);
  });
});

/* ── 8. Everything proven in repair 1 remains intact ──────────────────────── */

describe('the proven gesture-arbitration fix from repair 1 is untouched by this refinement', () => {
  test('the create screen\'s ScrollView touch-lock is still exactly as it was', () => {
    assert.match(createSrc, /scrollEnabled=\{!mapInteracting\}/);
    assert.match(createSrc, /onTouchStart=\{\(\) => setMapInteracting\(true\)\}/);
  });

  test('no native gesture props were disabled on the map itself', () => {
    assert.doesNotMatch(mapSrc, /\b(scrollEnabled|zoomEnabled|pitchEnabled|rotateEnabled)=\{false\}/);
  });

  test('the drag-to-refine promise is still absent from the help copy', () => {
    assert.doesNotMatch(createSrc, /drag to refine/i);
  });

  test('canSave still requires a real point before saving', () => {
    assert.match(createSrc, /const canSave = !!profile\?\.id\s*&&\s*!!\(point \|\| isChild\)/);
  });

  test('the discard-on-leave guard is untouched', () => {
    assert.match(createSrc, /navigation\.addListener\('beforeRemove'/);
  });
});
