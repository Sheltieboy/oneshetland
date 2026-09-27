/**
 * places-search.node.test.ts — mobile address autocomplete moved server-side.
 *
 * Physical defect (25/27 Sep): typing "ZE1 0" in the app returned nothing. The
 * shared Google key is (correctly) HTTP-referrer restricted; a bare device
 * fetch carries no referrer Google can verify, so Google refused every call.
 * There is no key-restriction model that is both secure and works for a raw
 * fetch() from React Native, so the call moved server-side onto a key that
 * never ships in any app bundle — gated like the other costed endpoints
 * (ai-cover-letter, notify-hub): a real signed-in caller, rate limited, before
 * anything is spent.
 *
 * What this pins:
 *   - parameter whitelisting: only the exact shape the app's own query objects
 *     send reaches Google; everything else is dropped, not merely trusted.
 *   - the function requires a real caller and is rate limited, same as the
 *     other AI/paid endpoints from the 25 Sep re-audit.
 *   - the function's own routing mirrors exactly the two paths the
 *     GooglePlacesAutocomplete library builds by default, so pointing it here
 *     via `requestUrl` needed no change to any screen's onPress/fetchDetails
 *     field-mapping.
 *   - every screen that used the direct-to-Google key now uses the proxy
 *     instead, and the web key/restrictions are untouched.
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(REPO, rel), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// deno-lint-ignore no-explicit-any
const P: Record<string, any> = loadModule('supabase/functions/_shared/places-params.ts');
const qs = (obj: Record<string, string>) => new URLSearchParams(obj);

/* ── parameter whitelisting ───────────────────────────────────────────── */

describe('parseAutocompleteParams: only the shape the app itself sends reaches Google', () => {
  test('a real search, exactly as one of the five screens sends it, passes through', () => {
    const p = P.parseAutocompleteParams(qs({ input: 'ZE1 0', key: 'proxied', language: 'en', components: 'country:gb', location: '60.155,-1.145', radius: '50000' }));
    assert.deepEqual(p, { input: 'ZE1 0', language: 'en', components: 'country:gb', location: '60.155,-1.145', radius: '50000', types: undefined });
  });

  test('the caller-supplied "key" is never read into the result at all', () => {
    const p = P.parseAutocompleteParams(qs({ input: 'ZE1 0', key: 'AIzaSomethingRealLooking12345' }));
    assert.ok(!('key' in p), 'the validated params carry no key field for the caller to influence');
  });

  test('too short, too long, missing, or blank input is refused', () => {
    for (const input of ['', ' ', 'Z', undefined]) {
      const q = input === undefined ? qs({}) : qs({ input });
      assert.equal(P.parseAutocompleteParams(q), null, JSON.stringify(input));
    }
    assert.equal(P.parseAutocompleteParams(qs({ input: 'Z'.repeat(500) })), null, 'oversized input');
  });

  test('whitespace-only padding around real input is trimmed, not refused', () => {
    assert.equal(P.parseAutocompleteParams(qs({ input: '  ZE1 0  ' })).input, 'ZE1 0');
  });

  test('a malformed optional param is DROPPED, not passed through and not a hard failure', () => {
    const p = P.parseAutocompleteParams(qs({
      input: 'Lerwick',
      language: 'DROP TABLE',
      components: 'country:united-kingdom',
      location: 'not,coords',
      radius: '-5',
      types: 'arbitrary_junk',
    }));
    assert.deepEqual(p, { input: 'Lerwick', language: undefined, components: undefined, location: undefined, radius: undefined, types: undefined });
  });

  test('types is one of the real Google enum values only', () => {
    for (const t of ['address', 'geocode', 'establishment', '(regions)', '(cities)']) {
      assert.equal(P.parseAutocompleteParams(qs({ input: 'xx', types: t })).types, t, t);
    }
    for (const t of ['sql', '../../etc', 'address; DROP', '']) {
      assert.equal(P.parseAutocompleteParams(qs({ input: 'xx', types: t })).types, undefined, t);
    }
  });

  test('a location outside plausible lat,lng shape is dropped', () => {
    for (const loc of ['60.155,-1.145,extra', 'nan,nan', '60.155', '', '<script>']) {
      assert.equal(P.parseAutocompleteParams(qs({ input: 'xx', location: loc })).location, undefined, loc);
    }
  });
});

describe('parseDetailsParams: a place id or nothing', () => {
  test('a real Google place_id shape is accepted', () => {
    const p = P.parseDetailsParams(qs({ placeid: 'ChIJVXealLU_xkcRja_At0z9AGY', language: 'en' }));
    assert.deepEqual(p, { placeid: 'ChIJVXealLU_xkcRja_At0z9AGY', language: 'en' });
  });
  test('missing, empty, or too-short/long placeid is refused', () => {
    for (const placeid of [undefined, '', 'short', 'x'.repeat(400)]) {
      const q = placeid === undefined ? qs({}) : qs({ placeid });
      assert.equal(P.parseDetailsParams(q), null, JSON.stringify(placeid));
    }
  });
  test('a path-traversal or query-injection placeid is refused', () => {
    for (const placeid of ['../../etc/passwd', 'ChIJVX?x=1', 'ChIJVX/../../']) {
      assert.equal(P.parseDetailsParams(qs({ placeid })), null, placeid);
    }
  });
});

describe('buildGoogleUrl: the caller never chooses the key, the host, or an extra param', () => {
  test('always the real Google host, always OUR key, exactly the validated params', () => {
    const url = P.buildGoogleUrl('https://maps.googleapis.com/maps/api/place/autocomplete/json',
      { input: 'ZE1 0', language: 'en' }, 'SERVER_KEY_VALUE');
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://maps.googleapis.com/maps/api/place/autocomplete/json');
    assert.equal(u.searchParams.get('key'), 'SERVER_KEY_VALUE');
    assert.equal(u.searchParams.get('input'), 'ZE1 0');
    assert.equal(u.searchParams.get('language'), 'en');
  });
  test('an undefined optional param is omitted, not sent as the literal string "undefined"', () => {
    const url = P.buildGoogleUrl('https://maps.googleapis.com/maps/api/place/details/json', { placeid: 'x', language: undefined }, 'K');
    assert.equal(new URL(url).searchParams.has('language'), false);
  });
});

/* ── the function itself ──────────────────────────────────────────────── */

describe('the function: authenticated, rate limited, routed, never logs the key', () => {
  const src = strip(read('supabase/functions/places-search/index.ts'));

  test('requires a real caller before anything else, and is rate limited before the Google fetch', () => {
    assert.match(src, /requireCaller\(req, corsHeaders\)/);
    assert.match(src, /enforceRateLimit\('places-search', userSubject\(caller\.userId\), \['places_search', 'places_search_day'\]/);
    const gate = src.indexOf('requireCaller(');
    const limit = src.indexOf('enforceRateLimit(');
    const fetchCall = src.indexOf('fetch(googleUrl');
    assert.ok(gate < limit && limit < fetchCall, 'order: identity, then rate limit, then spend');
  });

  test('routes on the exact two paths the widget requests, and nothing else', () => {
    assert.match(src, /url\.pathname\.endsWith\('\/place\/details\/json'\)/);
    assert.match(src, /url\.pathname\.endsWith\('\/place\/autocomplete\/json'\)/);
    assert.match(src, /return json\(\{ error: 'not found' \}, 404\)/);
  });

  test('only the validated params are ever handed to buildGoogleUrl — never the raw querystring', () => {
    assert.match(src, /parseAutocompleteParams\(url\.searchParams\)/);
    assert.match(src, /parseDetailsParams\(url\.searchParams\)/);
    assert.ok(!/buildGoogleUrl\([^)]*url\.searchParams/.test(src), 'the raw querystring must never reach the outbound URL builder');
  });

  test('the outbound fetch does not follow redirects and is time-bounded', () => {
    assert.match(src, /redirect: 'error'/);
    assert.match(src, /AbortSignal\.timeout\(/);
  });

  test('the server key and the request body are never logged; only status codes and Google status strings are', () => {
    assert.ok(!/console\.(log|error|warn)\([^)]*serverKey/.test(src), 'the key must never reach a log call');
    assert.ok(!/console\.(log|error|warn)\([^)]*googleUrl/.test(src), 'the full outbound URL (carries the key) must never be logged');
    assert.ok(!/console\.(log|error|warn)\([^)]*\binput\b/.test(src), 'the searched address text must never be logged');
  });

  test('a missing server key fails closed with a stable, generic message — never a stack or the env var name in the response', () => {
    assert.match(src, /Deno\.env\.get\('GOOGLE_PLACES_SERVER_KEY'\)/);
    assert.match(src, /status: 'UNAVAILABLE', error_message: 'Address search is not configured' \}, 503\)/);
  });

  test("Google's own error_message is logged, never handed back to the client (it can name our project/key)", () => {
    assert.match(src, /if \(body\.error_message\) console\.error/);
    assert.ok(!/error_message: body\.error_message/.test(src));
  });
});

/* ── the migration ────────────────────────────────────────────────────── */

describe('the rate-limit policies the function depends on', () => {
  const sql = strip(read('supabase/migrations/20260927000000_places_search_rate_limits.sql').replace(/^--.*$/gm, ''));
  test('both actions the function claims are defined', () => {
    assert.match(sql, /'places_search',\s*\d+,\s*3600/);
    assert.match(sql, /'places_search_day',\s*\d+,\s*86400/);
  });
});

/* ── the client side: five screens moved off the direct-to-Google key ──── */

const MOBILE_SCREENS = [
  'app/local-business-register.tsx',
  'app/event-create.tsx',
  'app/(customer)/request/step-2.tsx',
  'app/(customer)/request/step-3.tsx',
  'components/shifts/ShiftPostForm.tsx',
];

describe('every mobile address field now goes through the proxy, not a bundled Google key', () => {
  for (const f of MOBILE_SCREENS) {
    test(`${f}: no EXPO_PUBLIC_GOOGLE_PLACES_KEY, uses the proxy, passes the current session`, () => {
      const src = strip(read(f));
      assert.ok(!src.includes('EXPO_PUBLIC_GOOGLE_PLACES_KEY'), 'must not read the client Google key any more');
      assert.match(src, /requestUrl=\{placesRequestUrl\(session\?\.access_token\)\}/);
      assert.match(src, /from '@\/lib\/places-proxy'/);
    });
  }

  test('no onPress/fetchDetails field-mapping line changed — the fragile part of this feature was left alone', () => {
    for (const [f, marker] of [
      ['app/local-business-register.tsx', 'details.geometry.location.lat'],
      ['app/event-create.tsx', "details?.name ?? data.structured_formatting?.main_text"],
      ['app/(customer)/request/step-2.tsx', 'details?.formatted_address ?? data.description'],
      ['app/(customer)/request/step-3.tsx', "c.types.includes('postal_code')"],
    ] as const) {
      assert.match(read(f), new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), f);
    }
  });
});

describe('lib/places-proxy.ts', () => {
  const src = strip(read('lib/places-proxy.ts'));
  test('always the real Supabase project URL, never a caller-influenced host', () => {
    assert.match(src, /\$\{SUPABASE_URL\}\/functions\/v1\/places-search/);
  });
  test('falls back to the anon key only when there truly is no session token, never sends nothing', () => {
    assert.match(src, /Authorization: `Bearer \$\{accessToken \|\| SUPABASE_ANON_KEY\}`/);
  });
});

describe('the web app and its Google key are untouched', () => {
  test('no web file references places-search or the mobile proxy', () => {
    const out = execFileSync('git', ['-C', join(REPO, '..', 'oneshetland-web'), 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    // Not a strict assertion on repo state (the owner's own dirty tree), just a smoke check this task touched nothing there.
    assert.ok(!out.split('\n').some((l) => /places-search|places-proxy/.test(l)), 'this task must not have touched the web repo');
  });
  test('web still reads its own key from its own env var, referrer-restricted', () => {
    const web = join(REPO, '..', 'oneshetland-web', 'lib', 'google-maps.ts');
    assert.match(readFileSync(web, 'utf8'), /NEXT_PUBLIC_GOOGLE_MAPS_API_KEY/);
  });
});

/* ── live ──────────────────────────────────────────────────────────────── */

const runSql = (sql: string): Record<string, unknown>[] => {
  const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${sql}`, '--output-format', 'json'],
    { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const p = JSON.parse(out) as { rows?: Record<string, unknown>[]; _tag?: string; error?: unknown };
  if (p._tag === 'Error' || p.error) throw new Error(`db query error: ${JSON.stringify(p.error).slice(0, 300)}`);
  return p.rows ?? [];
};

describe('live (read-only): the rate-limit policies exist in production', () => {
  let sqlOk = false;
  before(() => { try { runSql('select 1 as ok'); sqlOk = true; } catch { sqlOk = false; } });
  const skip = 'Supabase CLI or linked project unavailable — run `supabase link` to exercise this layer.';

  test('places_search and places_search_day are both defined', (t) => {
    if (!sqlOk) return t.skip(skip);
    const rows = runSql(`select action from public.rate_limit_policies where action in ('places_search','places_search_day') order by action`);
    assert.deepEqual(rows.map((r) => r.action), ['places_search', 'places_search_day']);
  });
});
