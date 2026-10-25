/**
 * fetch-v2-mobile-guards.node.test.ts — static safety guards for Fetch v2 in the app (Step 12). Screens are .tsx (not loadable under
 * plain node), so these read the source of everything that ships (app/, components/, lib/, hooks/ — not legacy/).
 *
 * Proves: no direct writes to protected Fetch tables, no client pricing or 95p copy, no v1 notify-drivers path, no client-chosen
 * amounts, no storage paths or raw document URLs, nothing about the requester or the address on the board, the server flag on every
 * Fetch screen, v1 screens unreachable, notifications routed to v2, HEIC handled on the device, Android directions, accessibility basics.
 *
 * Run: node --test supabase/tests/fetch-v2-mobile-guards.node.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const walk = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((f) => {
  const p = join(dir, f);
  return statSync(join(ROOT, p)).isDirectory() ? (f === 'node_modules' ? [] : walk(p)) : /\.(tsx?|js)$/.test(f) ? [p] : [];
});
const SHIPPED = ['app', 'components', 'lib', 'hooks', 'context', 'constants'].flatMap(walk);
const V2 = [...walk('app/fetch'), ...walk('components/fetch/v2'), ...walk('lib/fetch'), 'lib/fetch-api.ts', 'hooks/useFetchV2.ts', 'app/(tabs)/fetch.tsx'];
const PROTECTED = 'delivery_requests|runs|driver_profiles|waiting_events|fetch_[a-z_]+|driver_verification_[a-z_]+';

describe('nothing that ships writes Fetch data or prices Fetch on the phone', () => {
  test('no direct insert/update/upsert/delete on a protected Fetch table anywhere in the shipped app', () => {
    const re = new RegExp(`from\\(['"](${PROTECTED})['"]\\)[\\s\\S]{0,200}?\\.(insert|update|upsert|delete)\\(`);
    for (const f of SHIPPED) assert.ok(!re.test(code(read(f))), `${f} writes a Fetch table`);
  });
  test('Fetch v2 code reads no Fetch table directly and never touches storage', () => {
    for (const f of V2) {
      const s = code(read(f));
      assert.ok(!new RegExp(`from\\(['"](${PROTECTED})['"]\\)`).test(s), `${f} reads a Fetch table`);
      assert.ok(!/storage\.from|storage_path|object_path|bucket_id|\/storage\/v1\//.test(s), `${f} storage`);
      if (f !== 'lib/fetch/transport.ts' && f !== 'hooks/useFetchV2.ts') assert.ok(!/supabase\.(from|rpc|functions)/.test(s), `${f} bypasses lib/fetch-api.ts`);
    }
    // The only direct RPC outside the client is the flag check.
    assert.match(read('hooks/useFetchV2.ts'), /supabase\.rpc\('fetch_v2_enabled'\)/);
  });
  test('no old Fetch pricing: no 95p/mile, mileage maths, local minimum, ferry or service fee, and no calculate-fee / hard-coded project URL', () => {
    for (const f of SHIPPED) {
      const s = code(read(f));
      assert.ok(!/95p\/mile|PRICE_PER_MILE|haversine|MIN_FEE_PENCE|calculate-fee|nkrtmakxygkvxuxriiil\.supabase\.co\/functions/i.test(s), f);
      if (V2.includes(f)) assert.ok(!/SERVICE_FEE_PENCE|FERRY_[A-Z_]*PENCE|\* *0?\.95|\* *95\b/.test(s), `${f} prices on the phone`);
    }
  });
  test('no v1 notify path and no client-chosen amount anywhere in Fetch v2', () => {
    for (const f of SHIPPED) assert.ok(!/notify-drivers|notify-collected|fetch-authorise|fetch-capture/.test(code(read(f))), f);
    const api = read('lib/fetch-api.ts');
    for (const m of api.matchAll(/\b(\w+)\(([^)]*)\) \{ return this\.edge/g)) assert.ok(!/pence|amount|price|fee|total/i.test(m[2]), `${m[1]}(${m[2]})`);
  });
});

describe('the server flag and the old screens', () => {
  test('every Fetch v2 screen sits under the gated layout; the Fetch tab asks the server flag too', () => {
    const layout = read('app/fetch/_layout.tsx');
    assert.match(layout, /useFetchAccess\(!!session\)/);
    assert.match(layout, /access === 'on' \? <Stack/);
    assert.match(layout, /if \(!session\) return <Redirect href=\{`\/\(auth\)\/sign-in\?next=/);
    const tab = read('app/(tabs)/fetch.tsx');
    assert.match(tab, /useFetchAccess\(true\)/);
    assert.match(tab, /access === 'off' \?/);
    assert.ok(!/CustomerDashboard|DriverDashboard|\(customer\)\/dashboard|\(driver\)\/dashboard/.test(code(tab)), 'the tab no longer embeds v1');
    assert.match(read('lib/fetch/mobile.ts'), /result\.data === true \? 'on' : 'off'/);
  });
  test('losing access mid-Fetch leaves for the Fetch home', () => {
    assert.match(read('hooks/useFetchV2.ts'), /if \(lostAccess\(r\.code\)\) router\.replace\(FETCH_HOME/);
  });
  test('v1 screens are one-line stubs that their layout forwards to v2; their old source is not routed', () => {
    for (const f of ['app/(customer)/dashboard.tsx', 'app/(customer)/request-detail.tsx', 'app/(customer)/previous-requests.tsx', 'app/(customer)/apply-driver.tsx',
      'app/(customer)/request/step-1.tsx', 'app/(customer)/request/step-4.tsx', 'app/(driver)/dashboard.tsx', 'app/(driver)/create-run.tsx', 'app/(driver)/request-detail.tsx']) {
      assert.match(read(f), /export default function RetiredFetchV1Screen\(\) \{\n  return null;\n\}/, f);
      assert.ok(existsSync(join(ROOT, 'legacy/fetch-v1', f)), `${f} kept for reference`);
    }
    for (const g of ['customer', 'driver']) {
      const l = read(`app/(${g})/_layout.tsx`);
      assert.match(l, new RegExp(`v1Forward\\('\\(${g}\\)'`));
      assert.match(l, /if \(forward\) return <Redirect href=\{forward as never\} \/>;/);
    }
    assert.match(read('app/fetch-about.tsx'), /<Redirect href="\/\(tabs\)\/fetch" \/>/);
    assert.match(read('app/fetch-about-driver.tsx'), /<Redirect href="\/fetch\/drive" \/>/);
    assert.ok(JSON.parse(read('tsconfig.json')).exclude.includes('legacy'));
    for (const f of SHIPPED) assert.ok(!/legacy\/fetch-v1/.test(code(read(f)).replace(/^\/\/.*$/gm, '')) || /RetiredFetchV1/.test(read(f)), `${f} imports legacy code`);
  });
  test('admins decide drivers in the web console, not by writing driver_status', () => {
    const s = read('app/(admin)/driver-approvals.tsx');
    assert.ok(!/driver_status: decision|\.update\(/.test(code(s)));
    assert.match(s, /\$\{WEB_BASE_URL\}\/admin\/fetch\/drivers\/\$\{id\}/);
  });
});

describe('privacy in the screens', () => {
  test('board and accept never touch the requester, exact addresses, phone or notes; board photos use the board-safe view', () => {
    const d = read('components/fetch/v2/Driving.tsx');
    const board = d.slice(d.indexOf('// ── board'), d.indexOf('// ── applying'));
    assert.ok(!/pickup_location|destination_address|contact_phone|requester_first_name|pickup_name|pickup_notes|delivery_notes|safe_place_note/.test(board));
    assert.match(board, /fetchApi\.photoView\(photo, true\)/);
    for (const f of ['app/fetch/board/index.tsx', 'app/fetch/board/[id].tsx']) assert.ok(!/pickup_location|destination_address|contact_phone|requester_first_name/.test(read(f)), f);
  });
  test('phone only while shared and allowed; addresses only while the server shows them; requester screen never shows a phone', () => {
    const j = read('components/fetch/v2/Jobs.tsx');
    assert.match(j, /detail\.phone_shared && r\.contact_phone &&/);
    assert.match(j, /detail\.addresses_visible === false/);
    const requester = j.slice(j.indexOf('export function RequesterJob'), j.indexOf('export function payLines'));
    assert.ok(!/contact_phone/.test(requester));
    assert.ok(!/driver\.(id|phone|full_name|last_name)/.test(requester));
    assert.match(requester, /r\.operational_details_visible !== false && r\.pickup_location/);
  });
  test('history is the safe summary; documents open only through the owner\'s short-lived link', () => {
    const h = read('components/fetch/v2/Home.tsx');
    assert.ok(!/pickup_location|destination_address|contact_phone|notes/.test(h));
    assert.match(read('components/fetch/v2/Driving.tsx'), /fetchApi\.evidenceView\(id\)/);
    for (const f of V2) assert.ok(!/https?:\/\/[^'"`\s]*supabase/.test(read(f)), f);
  });
});

describe('device behaviour', () => {
  test('photos: HEIC/PNG/camera JPEG all re-encoded to JPEG on the device, metadata not requested, one-use upload address', () => {
    const d = read('lib/fetch/device.ts');
    assert.match(d, /manipulateAsync\(asset\.uri, plan\.resize \? \[\{ resize: plan\.resize \}\] : \[\], \{ format: SaveFormat\.JPEG, compress: PHOTO_QUALITY \}\)/);
    assert.match(d, /exif: false/);
    assert.match(d, /UIImagePickerPreferredAssetRepresentationMode\.Compatible/);
    assert.match(d, /uploadAsync\(b\.data\.upload_url, photo\.uri, \{ httpMethod: 'PUT'/);
    assert.match(d, /We couldn't convert that photo/);
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.dependencies['expo-image-manipulator'], 'the converter is a declared dependency');
    // The server's accepted types are unchanged (shared flow.ts).
    assert.match(read('lib/fetch/flow.ts'), /export const PHOTO_TYPES = \["image\/jpeg", "image\/png", "image\/webp"\];/);
  });
  test('directions: platform URL from one pure function, a web fallback, and no Apple Maps link on Android in Fetch v2', () => {
    const d = read('lib/fetch/device.ts');
    assert.match(d, /directionsUrl\(address, Platform\.OS\)/);
    assert.match(d, /Linking\.openURL\(directionsFallback\(address\)\)/);
    for (const f of V2) if (f !== 'lib/fetch/mobile.ts') assert.ok(!/maps:\/\/|maps\.apple\.com/.test(code(read(f))), f);
  });
  test('3DS uses the server client secret, then the server state decides the message', () => {
    const d = read('lib/fetch/device.ts');
    assert.match(d, /settleSavedCardPayment\(\{ status: 'requires_action', clientSecret: r\.data\.client_secret \}\)/);
    assert.match(d, /bankCheckResult\(after\.ok \? after\.data\.payment : null, out\.outcome\)/);
  });
  test('notifications: Fetch v2 routes resolve before the generic Fetch alias and the request_id fallback', () => {
    const n = read('lib/notifications.ts');
    const at = n.indexOf('const fetchRoute = fetchRouteFor(data);');
    assert.ok(at > 0 && at < n.indexOf('SCREEN_ALIASES[screen]') && at < n.indexOf("typeof data.request_id === 'string'"));
  });
  test('refresh without subscriptions: poll while in view, reload on focus and foreground', () => {
    const h = read('hooks/useFetchV2.ts');
    assert.match(h, /AppState\.currentState === 'active'/);
    assert.ok(!/\.channel\(|postgres_changes/.test(V2.map((f) => read(f)).join('\n')));
    for (const f of ['app/fetch/requests/[id]/index.tsx', 'app/fetch/jobs/[id].tsx', 'app/fetch/board/index.tsx']) assert.match(read(f), /pollMs: 20_000/, f);
  });
});

describe('accessibility and copy', () => {
  test('buttons have a role, label and disabled/busy state and a 48pt target; status is words + icon; nothing animates', () => {
    const ui = read('components/fetch/v2/ui.tsx');
    assert.match(ui, /accessibilityRole="button" accessibilityLabel=\{label\}/);
    assert.match(ui, /accessibilityState=\{\{ disabled: !!off, busy: !!busy \}\}/);
    assert.match(ui, /btn: \{ minHeight: 48/);
    assert.match(ui, /accessibilityLabel=\{`\$\{status\.label\}\. \$\{status\.detail\}`\}/);
    for (const f of V2) assert.ok(!/Animated\.|LayoutAnimation|useNativeDriver/.test(read(f)), `${f} animates`);
    assert.match(ui, /accessibilityRole="radio" accessibilityState=\{\{ checked: on \}\}/);
    assert.match(ui, /accessibilityRole="checkbox" accessibilityState=\{\{ checked: value \}\}/);
  });
  test('the same words as the website', () => {
    const all = V2.map((f) => read(f)).join('\n');
    for (const phrase of ["I need something fetched", "I'm travelling / I can fetch", 'Someone may already be travelling that way',
      "This isn't a booking yet — a driver still needs to accept your Fetch.", 'Your bank needs you to confirm this payment authorisation.',
      "I've checked the item details and it will fit in my vehicle.", 'Return reported — OneShetland will review this.',
      'so the driver can make sure it will fit', 'Waiting started', 'Any waiting charge is calculated automatically.', 'Suits you', 'Show all'])
      assert.ok(all.includes(phrase), phrase);
    assert.ok(!/\bStripe\b|PaymentIntent|webhook|idempotenc/i.test(V2.filter((f) => f.startsWith('app/') || f.startsWith('components/')).map((f) => code(read(f))).join('\n')
      .match(/>[^<>{}]+<|'[^']{12,}'/g)?.join(' ') ?? ''));
  });
});

describe('Step 13 static guards', () => {
  test('no production project URL or ref anywhere in Fetch v2 code', () => {
    for (const f of V2) assert.ok(!/nkrtmakxygkvxuxriiil|supabase\.co\b/.test(code(read(f))), `${f} names a hosted project`);
  });
  test('no Fetch v2 code links back into the retired v1 Fetch routes (payouts excepted)', () => {
    for (const f of V2) {
      const s = code(read(f));
      const v1 = s.match(/['"`]\/\((customer|driver)\)\/(?!connect-bank)[a-z-/]+/g) ?? [];
      assert.deepEqual(v1, [], `${f} links to ${v1.join(', ')}`);
      assert.ok(!/fetch-about/.test(s), `${f} links to the v1 explainer`);
    }
  });
  test('no raw document or photo URL is built on the device: only links the server hands out', () => {
    for (const f of V2) assert.ok(!/storage\/v1|object\/(public|sign|authenticated)|fetch-driver-verification|fetch-photos\//.test(code(read(f))), f);
  });
});

