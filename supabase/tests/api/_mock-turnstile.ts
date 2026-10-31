/**
 * _mock-turnstile.ts — a MOCK of Cloudflare's siteverify for LOCAL tests. No real Turnstile traffic is ever made: the injected fetch answers
 * https://challenges.cloudflare.com/... itself and REFUSES every other non-loopback host (fail closed), so a test can never reach the live service or production.
 *
 * Token grammar (made by the mock browser widget, or by a test):  mock.<mode>.<action>.<cdata>.<nonce>[.host=<hostname>]
 *   mode valid     → success, once. A second redemption of the same token is answered `timeout-or-duplicate`, exactly like Cloudflare.
 *   mode expired   → `timeout-or-duplicate`;  mode invalid → `invalid-input-response`;  mode stale → success but with an old challenge_ts
 * The hostname returned is `localhost` unless `.host=` says otherwise. `outage` makes every verification fail like an unreachable service.
 */
export const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const state = { redeemed: new Set<string>(), calls: [] as { secret: string; response: string; remoteip?: string }[], outage: null as null | 'throw' | 'http500' | 'badjson' };
export const resetMock = () => { state.redeemed.clear(); state.calls.length = 0; state.outage = null; };
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function makeFetch(real: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : (input as Request).url);
    if (url.toString() === SITEVERIFY) {
      if (state.outage === 'throw') throw new TypeError('mock: network unreachable');
      if (state.outage === 'http500') return new Response('upstream error', { status: 500 });
      if (state.outage === 'badjson') return new Response('<html>not json</html>', { status: 200 });
      const b = JSON.parse(String(init?.body ?? '{}')) as { secret: string; response: string; remoteip?: string };
      state.calls.push(b);
      const j = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
      if (b.secret !== 'mock-secret-key') return j({ success: false, 'error-codes': ['invalid-input-secret'] });
      if (!b.response) return j({ success: false, 'error-codes': ['missing-input-response'] });
      const m = /^mock\.(valid|expired|invalid|stale)\.([^.]+)\.([^.]+)\.([^.]+)(?:\.host=(.+))?$/.exec(b.response);
      if (!m) return j({ success: false, 'error-codes': ['invalid-input-response'] });
      const [, mode, action, cdata, , host] = m;
      if (mode === 'invalid') return j({ success: false, 'error-codes': ['invalid-input-response'] });
      if (mode === 'expired' || state.redeemed.has(b.response)) return j({ success: false, 'error-codes': ['timeout-or-duplicate'] });
      state.redeemed.add(b.response);
      return j({ success: true, challenge_ts: new Date(Date.now() - (mode === 'stale' ? 3_600_000 : 1000)).toISOString(), hostname: host ?? 'localhost', action, cdata });
    }
    if (!LOOPBACK.has(url.hostname)) throw new Error(`ISOLATION: the local function refused to fetch ${url.hostname}`);
    return real(input as RequestInfo, init);
  }) as typeof fetch;
}

/** a token as the mock widget would produce it */
export const token = (mode: 'valid' | 'expired' | 'invalid' | 'stale', action: string, cdata: string, extra = '') => `mock.${mode}.${action}.${cdata}.${Math.random().toString(36).slice(2, 10)}${extra}`;
