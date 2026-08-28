/**
 * fetch-price-authority.node.test.ts — the customer no longer names their price.
 *
 * What a Fetch delivery cost was decided in the customer's browser:
 *
 *     const { feePence } = estimateFee(pickup, dest);        // lib/fetch-data.ts
 *     sb.from("delivery_requests").insert({ base_fee_pence: feePence, … })
 *
 * and authorise-payment pre-authorised exactly that column. So a twelve-mile
 * delivery could be posted for a penny, and the driver who accepted it made
 * the trip for a penny. The loss lands on the driver, who has already burnt
 * the fuel — which is why this is the first thing fixed.
 *
 * The same for waiting time: the DRIVER's browser computed waiting_fee_pence,
 * wrote it to the row, and capture-payment added it to amount_to_capture.
 *
 * Neither was an RLS failure. The row belonged to the person writing it. RLS
 * decides which ROWS you may touch and never which COLUMNS, and `authenticated`
 * held UPDATE on every one of these money fields.
 *
 * The live probes below run against production with a throwaway account and
 * clean up after themselves. They are the load-bearing ones: the trigger either
 * discards a client's price or it does not, and only the database can say.
 *
 * Run: npm test
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_ROOT = join(REPO_ROOT, '..', 'oneshetland-web');

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*|\{\/\*).*$/gm, '');

const authorise = code(readFileSync(join(REPO_ROOT, 'supabase/functions/authorise-payment/index.ts'), 'utf8'));
const capture   = code(readFileSync(join(REPO_ROOT, 'supabase/functions/capture-payment/index.ts'), 'utf8'));
const quote     = code(readFileSync(join(REPO_ROOT, 'supabase/functions/fetch-quote/index.ts'), 'utf8'));
const migration = readFileSync(join(REPO_ROOT, 'supabase/migrations/20260905120000_fetch_price_authority.sql'), 'utf8');
const composer  = code(readFileSync(join(WEB_ROOT, 'components/fetch/RequestComposer.tsx'), 'utf8'));
const driverUi  = code(readFileSync(join(WEB_ROOT, 'components/fetch/DriverActions.tsx'), 'utf8'));
const fetchLib  = readFileSync(join(WEB_ROOT, 'lib/fetch-data.ts'), 'utf8');
const config    = readFileSync(join(REPO_ROOT, 'supabase/config.toml'), 'utf8');

/* ── live probe plumbing ──────────────────────────────────────────────────── */
function env(): { url: string; anon: string; srk: string } | null {
  let url = '', anon = '';
  try {
    for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*(EXPO_PUBLIC_SUPABASE_URL|EXPO_PUBLIC_SUPABASE_ANON_KEY)\s*=\s*(.+)\s*$/);
      if (!m) continue;
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      if (m[1].endsWith('URL')) url = v; else anon = v;
    }
  } catch { return null; }
  let srk = '';
  try { srk = readFileSync(join(REPO_ROOT, 'service_key.txt'), 'utf8').trim(); } catch { return null; }
  return url && anon && srk ? { url, anon, srk } : null;
}
const cfg = env();

const api = async (path: string, key: string, init: RequestInit & { bearer?: string; prefer?: string } = {}) => {
  const res = await fetch(`${cfg!.url}${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${init.bearer ?? key}`,
      'Content-Type': 'application/json',
      ...(init.prefer ? { Prefer: init.prefer } : {}),
    },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

let probeUser = '', probeTok = '', probeReq = '';

before(async () => {
  if (!cfg) return;
  const email = `fetchprice-${Math.random().toString(16).slice(2, 10)}@probe.invalid`;
  const password = `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
  const made = await api('/auth/v1/admin/users', cfg.srk, {
    method: 'POST', body: JSON.stringify({ email, password, email_confirm: true }),
  });
  probeUser = made.body.id;
  const tok = await api('/auth/v1/token?grant_type=password', cfg.anon, {
    method: 'POST', body: JSON.stringify({ email, password }),
  });
  probeTok = tok.body.access_token;
});

after(async () => {
  if (!cfg) return;
  if (probeReq) await api(`/rest/v1/delivery_requests?id=eq.${probeReq}`, cfg.srk, { method: 'DELETE' });
  if (probeUser) await api(`/auth/v1/admin/users/${probeUser}`, cfg.srk, { method: 'DELETE' });
});

/* ── 1. the defect, against the real database ─────────────────────────────── */
describe('a customer cannot name their own delivery price', () => {
  test('a price sent with the request is discarded', { skip: !cfg }, async () => {
    const made = await api('/rest/v1/delivery_requests', cfg!.anon, {
      method: 'POST', bearer: probeTok, prefer: 'return=representation',
      body: JSON.stringify({
        customer_id: probeUser, category_slug: 'shopping',
        pickup_name: 'PROBE', pickup_location: 'PROBE — delete me, Lerwick',
        destination_address: 'PROBE — delete me, Unst', destination_area: 'Unst',
        liability_acknowledged: true, status: 'pending',
        // The exploit, verbatim: a penny for a delivery across Shetland.
        base_fee_pence: 1, total_fee_pence: 1, waiting_fee_pence: 99_999,
      }),
    });
    assert.equal(made.status, 201, `insert refused: ${JSON.stringify(made.body)}`);
    probeReq = made.body[0].id;
    assert.equal(made.body[0].base_fee_pence, null, 'the customer priced their own delivery');
    assert.equal(made.body[0].total_fee_pence, null, 'the customer set the total');
    assert.equal(made.body[0].waiting_fee_pence, 0, 'the customer set a waiting fee');
  });

  test('and cannot raise it afterwards', { skip: !cfg }, async () => {
    const patched = await api(`/rest/v1/delivery_requests?id=eq.${probeReq}`, cfg!.anon, {
      method: 'PATCH', bearer: probeTok,
      body: JSON.stringify({ base_fee_pence: 1, waiting_fee_pence: 99_999 }),
    });
    assert.ok(patched.status >= 400, `a customer updated their own fee (HTTP ${patched.status})`);
    const now = await api(`/rest/v1/delivery_requests?id=eq.${probeReq}&select=base_fee_pence,waiting_fee_pence`, cfg!.srk);
    assert.equal(now.body[0].base_fee_pence, null);
    assert.equal(now.body[0].waiting_fee_pence, 0);
  });

  test('the trusted path can still write the authoritative price', { skip: !cfg }, async () => {
    const set = await api(`/rest/v1/delivery_requests?id=eq.${probeReq}`, cfg!.srk, {
      method: 'PATCH', prefer: 'return=representation',
      body: JSON.stringify({ base_fee_pence: 656 }),
    });
    assert.equal(set.status, 200);
    assert.equal(set.body[0].base_fee_pence, 656, 'the server cannot price a delivery');
  });

  test('creating an ordinary request still works', { skip: !cfg }, async () => {
    // The guard discards money, it does not refuse rows. Fetch must keep working.
    const read = await api(`/rest/v1/delivery_requests?id=eq.${probeReq}&select=id,status,pickup_name`, cfg!.anon, { bearer: probeTok });
    assert.equal(read.status, 200);
    assert.equal(read.body.length, 1, 'the customer can no longer see their own request');
    assert.equal(read.body[0].status, 'pending');
  });

  test('another signed-in user cannot see it at all', { skip: !cfg }, async () => {
    const asAnon = await api(`/rest/v1/delivery_requests?id=eq.${probeReq}&select=id`, cfg!.anon);
    assert.equal(asAnon.body.length, 0, 'row ownership was weakened');
  });
});

/* ── 2. the server prices it ──────────────────────────────────────────────── */
describe('the price is computed from server configuration', () => {
  test('fetch_base_fee_pence applies the road factor, the rate and the floor', { skip: !cfg }, async () => {
    const cfgRow = await api('/rest/v1/delivery_pricing_config?select=min_fee_pence,price_per_mile_pence,road_correction_factor', cfg!.srk);
    const { min_fee_pence: min, price_per_mile_pence: rate, road_correction_factor: road } = cfgRow.body[0];
    for (const miles of [0, 1, 7, 20]) {
      const got = await api('/rest/v1/rpc/fetch_base_fee_pence', cfg!.srk, {
        method: 'POST', body: JSON.stringify({ p_straight_miles: miles }),
      });
      const expected = Math.max(min, Math.round(miles * Number(road) * rate));
      assert.equal(got.body, expected, `${miles} miles priced wrong`);
    }
  });

  test('the browser preview quotes the same rate the server charges', { skip: !cfg }, async () => {
    // The drift this exists to catch: the browser charged 95p a mile while the
    // config said 65p, and the browser's number was the one that got written.
    const cfgRow = await api('/rest/v1/delivery_pricing_config?select=min_fee_pence,price_per_mile_pence,road_correction_factor', cfg!.srk);
    const row = cfgRow.body[0];
    const constant = (name: string) => Number(fetchLib.match(new RegExp(`export const ${name} = ([\\d.]+)`))![1]);
    assert.equal(constant('PRICE_PER_MILE_PENCE'), row.price_per_mile_pence, 'the preview rate no longer matches the config');
    assert.equal(constant('MIN_FEE_PENCE'), row.min_fee_pence, 'the preview minimum no longer matches the config');
    assert.equal(constant('ROAD_FACTOR'), Number(row.road_correction_factor), 'the preview road factor no longer matches the config');
  });

  test('the service fee mirrors the commission config', { skip: !cfg }, async () => {
    const fixed = await api("/rest/v1/admin_config?key=eq.fees.fetch.fixed_pence&select=value", cfg!.srk);
    const constant = Number(fetchLib.match(/export const SERVICE_FEE_PENCE = (\d+)/)![1]);
    assert.equal(constant, Number(fixed.body[0].value), 'the quoted service fee is not the one charged');
  });

  test('the distance is measured with a SERVER key, never the browser one', () => {
    assert.match(quote, /GOOGLE_GEOCODING_API_KEY/);
    assert.ok(!/NEXT_PUBLIC/.test(quote), 'the quote uses a key the client also holds');
    assert.match(quote, /components.*country:GB/);
  });

  test('the rate-limit result is tested for a refusal, not for truthiness', () => {
    // enforceRateLimit answers { ok: true } on success — an object, and so
    // truthy. `if (limited) return limited` therefore returned a plain object
    // where a Response was expected, and every single quote 502'd. Caught by
    // calling the deployed function, not by reading it.
    assert.match(quote, /if \('denied' in limited\) return limited\.denied;/);
    assert.ok(!/if \(limited\) return limited;/.test(quote), 'the success shape is being returned as a Response');
  });

  test('an unmeasurable distance falls to the minimum, loudly, rather than to a guess', () => {
    assert.match(quote, /return null;/);
    assert.match(quote, /console\.error\('\[fetch-quote\] GOOGLE_GEOCODING_API_KEY is not set/);
    assert.match(quote, /p_straight_miles: miles \?\? 0/);
  });
});

/* ── 3. price lock ────────────────────────────────────────────────────────── */
describe('the price is fixed once a driver accepts', () => {
  test('re-pricing a matched delivery is refused', () => {
    assert.match(quote, /if \(r\.status !== 'pending'\)/);
    assert.match(quote, /PRICE_LOCKED/);
  });

  test('and the write itself is conditional on still being pending', () => {
    assert.match(quote, /\.update\(\{ base_fee_pence: basePence \}\)[\s\S]{0,80}\.eq\('status', 'pending'\)/);
  });

  test('only the request’s owner may price it', () => {
    assert.match(quote, /if \(r\.customer_id !== user\.id\) return json\(\{ error: 'Forbidden' \}, 403\)/);
  });
});

/* ── 4. what the payment endpoints are allowed to read ────────────────────── */
describe('authorise and capture use authoritative amounts only', () => {
  test('authorise refuses a delivery that was never priced', () => {
    assert.match(authorise, /const baseFeePence = request\.base_fee_pence;/);
    assert.match(authorise, /NOT_PRICED/);
    assert.ok(!/min_fee_pence \?\? 400/.test(authorise), 'an unpriced delivery still gets a fallback price');
  });

  test('the Stripe amount is the authoritative base plus the configured service fee', () => {
    // The hold gained the waiting-fee headroom in Fix 4: the waiting fee is
    // measured after the driver arrives, so holding only base + service meant
    // capture could be asked for more than was ever authorised. What this test
    // guards is unchanged — every term is server-derived.
    assert.match(authorise, /amount: String\(baseFeePence \+ serviceFeePence \+ waitingHeadroom\)/);
    assert.match(authorise, /wait_max_pence/);
    assert.match(authorise, /calculateCommission\(baseFeePence, fetchCfg, 'fetch'\)/);
    assert.ok(!/body\.amount|body\.base_fee|amount: String\(body/.test(authorise), 'the request body can name an amount');
  });

  test('capture measures the waiting fee instead of reading the row', () => {
    assert.match(capture, /rpc\('fetch_waiting_fee_pence', \{ p_request: request_id \}\)/);
    const total = capture.slice(capture.indexOf('const totalPence'), capture.indexOf('const totalPence') + 200);
    assert.ok(!/request\.waiting_fee_pence/.test(total), 'capture still totals the driver-written column');
  });

  test('the captured amount is server-derived, never client-supplied', () => {
    // Fix 4 clamps this to what Stripe actually holds, so a capture can never
    // exceed the authorisation. Still server-derived; still not the caller's.
    assert.match(capture, /amount_to_capture: String\(captureAmount\)/);
    assert.match(capture, /const captureAmount = Math\.min\(totalPence, capturable\)/);
    assert.ok(!/amount_to_capture: String\(body|body\.amount/.test(capture), 'the caller can name the capture amount');
  });

  test('manual capture is untouched by this fix', () => {
    assert.match(authorise, /capture_method: 'manual'/);
  });
});

/* ── 5. waiting time is measured, not claimed ─────────────────────────────── */
describe('nobody submits a waiting fee', () => {
  test('the amount is derived from the stamped timestamps', () => {
    assert.match(migration, /create or replace function public\.fetch_waiting_fee_pence/);
    assert.match(migration, /extract\(epoch from \(v_to - v_from\)\) - c\.wait_grace_secs/);
    assert.match(migration, /least\(v_periods \* c\.wait_period_pence, c\.wait_max_pence\)/);
  });

  test('only the assigned driver can stop the clock', () => {
    assert.match(migration, /if v_driver is null or v_driver <> auth\.uid\(\) then/);
    assert.match(migration, /raise exception 'Not the assigned driver/);
  });

  test('the clock is the database’s, not the phone’s', () => {
    assert.match(migration, /update public\.waiting_events set collected_at = now\(\)/);
  });

  test('the driver’s screen calls that transition instead of writing money', () => {
    assert.match(driverUi, /rpc\("fetch_mark_collected", \{ p_request: req\.id \}\)/);
    assert.ok(!/waiting_fee_pence: feePence/.test(driverUi), 'the driver still writes the fee');
  });

  test('a second arrival cannot re-start the billing clock', () => {
    assert.match(migration, /order by arrived_at\s*\n\s*limit 1;/);
  });

  test('waiting is only charged when the customer said it was ready', () => {
    assert.match(migration, /if not coalesce\(v_ready, false\) then return 0; end if;/);
  });
});

/* ── 6. the composer stopped sending money ────────────────────────────────── */
describe('the request form quotes but does not price', () => {
  test('no fee is sent with the insert', () => {
    const insert = composer.slice(composer.indexOf('.insert({'), composer.indexOf('.select("id")'));
    assert.ok(!/base_fee_pence:/.test(insert), 'the composer still submits a price');
  });

  test('the server is asked for the real price straight after', () => {
    assert.match(composer, /functions\.invoke\("fetch-quote", \{ body: \{ request_id: id \} \}\)/);
  });

  test('an unpriced request is not left lying around', () => {
    assert.match(composer, /if \(quoteProblem\) \{[\s\S]{0,200}\.delete\(\)\.eq\("id", id\)/);
  });

  test('the quote endpoint is pinned behind a JWT', () => {
    assert.match(config, /\[functions\.fetch-quote\]\s*\nverify_jwt = true/);
  });
});
