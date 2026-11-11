// The ONLY place that runs the `stripe` CLI. Test mode, project "default" only. Never --live, never --api-key, never reads the CLI config file.
// Exports: stripe(method, path, opts) -> { status, body, ok, raw }, assertTestMode(obj), STRIPE_PROD_HOST.
import { spawnSync } from 'node:child_process';

export const PRODUCTION_HOST = 'nkrtmakxygkvxuxriiil.supabase.co';

/** Walk any response and refuse livemode:true anywhere. */
export function assertTestMode(x, where = 'response') {
  const seen = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return; seen.add(v);
    if (v.livemode === true) { const e = new Error(`REFUSING: ${where} contains livemode:true. This tooling is test-mode only.`); e.code = 'LIVEMODE'; throw e; }
    for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(x);
}

const FORBIDDEN = /^(--live|--api-key|--config|-k)(=|$)/;

/**
 * Run one CLI request. method: GET|POST|DELETE. path: '/v1/...'. opts: { data: [['k','v'],...] , idempotencyKey, account, version, query: [['k','v']] }.
 * GET parameters go through `-d` too (the CLI turns them into a query string for get/delete).
 * Error mapping: a failed CLI call is turned into { ok:false, status, body:{error:{...}} } in Stripe's error shape. The CLI's exact failure text is not
 * guaranteed by any contract, so we look for a JSON object in the combined output and a `status=NNN` marker, and fall back to 502.
 */
export function stripe(method, path, opts = {}) {
  const m = String(method).toLowerCase();
  if (!['get', 'post', 'delete'].includes(m)) throw new Error(`method not allowed: ${method}`);
  if (!/^\/v[12]\/[A-Za-z0-9_\/.\-]+$/.test(path)) throw new Error(`bad path: ${path}`);
  const args = [m, path];
  for (const [k, v] of [...(opts.data ?? []), ...(opts.query ?? [])]) args.push('-d', `${k}=${v}`);
  if (opts.idempotencyKey && m === 'post') args.push('-i', opts.idempotencyKey);
  if (opts.account) args.push('--stripe-account', opts.account);
  if (opts.version) args.push('--stripe-version', opts.version);
  if (m !== 'get') args.push('--confirm');
  args.push('--project-name', 'default');
  for (const a of args) if (FORBIDDEN.test(a)) throw new Error(`forbidden argument: ${a}`);
  if (opts.dryRun) return { dryRun: true, argv: ['stripe', ...args], ok: true, status: 0, body: {} };
  const env = { ...process.env }; delete env.STRIPE_API_KEY; delete env.STRIPE_CONFIG; delete env.STRIPE_DEVICE_NAME;
  const r = spawnSync('stripe', args, { encoding: 'utf8', env, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 1 << 26 });
  const out = `${r.stdout ?? ''}`, err = `${r.stderr ?? ''}`;
  // parse the JSON body even when the CLI prints warning lines first (e.g. an outdated-API-version notice): try every line that starts a JSON value, first that parses to the end wins
  const parse = (s) => { const idx = []; let pos = 0; for (const line of s.split('\n')) { if (/^\s*[{[]/.test(line)) idx.push(pos + line.search(/\S/)); pos += line.length + 1; } for (const i of idx) { try { return JSON.parse(s.slice(i)); } catch { /* next */ } } return null; };
  if (r.error) return { ok: false, status: 502, body: { error: { type: 'api_connection_error', message: `stripe CLI could not run: ${r.error.code ?? r.error.message}` } }, raw: '' };
  const body = parse(out);
  // the CLI can exit 0 while printing Stripe's ERROR object: that is a failure, never a success (it used to make `cus.id` undefined and poison later steps)
  if (r.status === 0 && body !== null && !(body && typeof body === 'object' && !Array.isArray(body) && body.error && typeof body.error === 'object' && !body.object)) { assertTestMode(body, `${m.toUpperCase()} ${path}`); return { ok: true, status: 200, body, raw: out }; }
  if (r.status === 0 && body?.error) { assertTestMode(body, `error ${path}`); const t = body.error.type; return { ok: false, status: t === 'invalid_request_error' ? (body.error.code === 'resource_missing' ? 404 : 400) : t === 'api_error' ? 500 : t === 'rate_limit_error' ? 429 : 402, body, raw: out }; }
  const combined = `${out}\n${err}`; const sm = /status=(\d{3})/.exec(combined);
  const errBody = parse(combined);
  const status = sm ? Number(sm[1]) : errBody?.error ? (errBody.error.type === 'invalid_request_error' ? 400 : 402) : 502;
  if (errBody) assertTestMode(errBody, `error ${m.toUpperCase()} ${path}`);
  const e = errBody?.error ? errBody : { error: { type: 'api_error', message: combined.replace(/sk_(test|live)_\w+/g, 'sk_***').trim().slice(0, 400) || 'stripe CLI failed' } };
  return { ok: false, status, body: e, raw: combined.replace(/sk_(test|live)_\w+/g, 'sk_***') };
}
export const must = (r, what) => { if (!r.ok) throw new Error(`${what} failed (${r.status}): ${r.body?.error?.message ?? ''}`); return r.body; };
