#!/usr/bin/env node
// stripe-forwarder.mjs: a loopback-only HTTP server that stands in for https://api.stripe.com so the REAL Editions edge functions can run with no Stripe key.
//   node stripe-forwarder.mjs [--target cli|mock] [--mock-url http://127.0.0.1:12111] [--port-file FILE] [--port N] [--tag RUN_ID] [--print-plan]
// --print-plan (mock target only, for dry runs): also print the exact `stripe ...` command the CLI target WOULD have run for each request (the only place request values are printed).
// --tag adds metadata[oneshetland_test_run]=RUN_ID to every object-CREATING request (payment_intents, refunds, customers, subscriptions, products, prices, fee refunds, reversals), so the run's objects are findable and the functions' source stays untouched.
// It accepts the form-encoded requests the Editions functions send (method, /v1/path, query, Idempotency-Key, Stripe-Account, Stripe-Version) and executes them
//   --target cli   through `stripe get|post|delete <path> -d k=v ... -i <key> --stripe-account <acct> --project-name default --confirm`  (REAL Stripe TEST mode)
//   --target mock  by forwarding to the local stripe-mock container (dry runs; no Stripe contact at all)
// The Authorization header is IGNORED (never read, never logged, never forwarded). Only the whitelist below is served; everything else is 403. Live mode is refused.
// The log shows method, path and status only: no bodies, no query values, no headers.
//
// LIMITS (CLI target): (1) idempotent replays are performed by Stripe but the CLI hides the `Idempotent-Replayed` header, so a replay is indistinguishable from a first call;
//  (2) the CLI sends every `-d` as form data and splits at the FIRST '=', so keys with brackets (metadata[k], items[0][price_data][unit_amount], expand[]) pass through, but a value that
//  is itself empty becomes `key=` (an unset); (3) GET parameters go as `-d` and the CLI renders them into the query string; (4) the CLI's own error text is parsed best-effort (see lib/stripe-cli.mjs)
//  and an unparseable failure becomes a 502 api_error; (5) the CLI adds its own User-Agent and may add its own idempotency key when none is given; (6) rate limits (429) are returned as seen;
//  (7) every request is a separate process (~0.3-1 s): a webhook-like burst is slow but correct; requests are serialised.
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { stripe } from './lib/stripe-cli.mjs';

const ID = '[A-Za-z0-9_]+';
const RULES = [   // [methods, path regex]: nothing outside this list is ever forwarded
  [['GET', 'POST'], `^/v1/payment_intents(/${ID}(/(confirm|cancel))?)?$`],
  [['GET', 'POST'], `^/v1/refunds(/${ID})?$`],
  [['GET'], `^/v1/application_fees(/${ID})?$`], [['GET', 'POST'], `^/v1/application_fees/${ID}/refunds(/${ID})?$`],
  [['GET'], `^/v1/transfers(/${ID})?$`], [['GET', 'POST'], `^/v1/transfers/${ID}/reversals(/${ID})?$`],
  [['GET'], `^/v1/charges(/${ID})?$`],
  [['GET', 'POST', 'DELETE'], `^/v1/customers(/${ID})?$`],
  [['GET', 'POST', 'DELETE'], `^/v1/subscriptions(/${ID})?$`],
  [['GET'], `^/v1/invoices(/${ID})?$`], [['POST'], `^/v1/invoices/${ID}/pay$`],
  [['GET', 'POST'], `^/v1/products(/${ID})?$`], [['GET', 'POST'], `^/v1/prices(/${ID})?$`],
  [['GET'], `^/v1/accounts(/${ID})?$`],
  [['GET'], '^/v1/balance$'], [['GET'], `^/v1/balance_transactions(/${ID})?$`],
  [['GET'], `^/v1/disputes(/${ID})?$`],
  [['GET'], `^/v1/events(/${ID})?$`],
  [['GET', 'POST'], '^/v1/test_helpers/test_clocks$'], [['GET', 'DELETE'], `^/v1/test_helpers/test_clocks/${ID}$`], [['POST'], `^/v1/test_helpers/test_clocks/${ID}/advance$`],
].map(([m, r]) => [m, new RegExp(r)]);
const TAGGABLE = new RegExp(`^/v1/(payment_intents|refunds|customers|subscriptions|products|prices)$|^/v1/application_fees/${ID}/refunds$|^/v1/transfers/${ID}/reversals$`);
export const isAllowed = (method, path) => RULES.some(([m, r]) => m.includes(method) && r.test(path));

export function createForwarder({ target = 'cli', mockUrl = 'http://127.0.0.1:12111', call = stripe, log = (l) => console.log(l), tag = null, printPlan = false } = {}) {
  const journal = []; let queue = Promise.resolve();
  const reply = (res, status, body) => { const s = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) }); res.end(s); };
  const err = (res, status, message, type = 'invalid_request_error') => reply(res, status, { error: { type, message } });
  const handle = async (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0]; if (!['127.0.0.1', 'localhost'].includes(host)) return err(res, 403, 'forbidden host');
    const u = new URL(req.url, 'http://127.0.0.1'); const path = u.pathname; const method = (req.method ?? 'GET').toUpperCase();
    if (path === '/__forwarder/health') return reply(res, 200, { ok: true, target });
    if (path === '/__forwarder/journal') return reply(res, 200, { journal });
    const chunks = []; for await (const c of req) chunks.push(c); const body = Buffer.concat(chunks).toString('utf8');
    const done = (status) => { journal.push({ method, path, status }); log(`${method} ${path} -> ${status}`); };
    if (path.includes('..') || path.includes('%')) { done(400); return err(res, 400, 'bad path'); }
    if (!isAllowed(method, path)) { done(403); return err(res, 403, `path not allowed by the forwarder: ${method} ${path}`); }
    const pairs = [...new URLSearchParams(body).entries(), ...[...u.searchParams.entries()]];
    if (tag && method === 'POST' && TAGGABLE.test(path) && !pairs.some(([k]) => k === 'metadata[oneshetland_test_run]')) pairs.push(['metadata[oneshetland_test_run]', tag]);
    if (/^sk_live|^rk_live/.test(String(req.headers.authorization ?? '').replace(/^Bearer /, '')) || pairs.some(([k, v]) => k === 'livemode' && v === 'true')) { done(403); return err(res, 403, 'live mode is refused'); }
    const account = req.headers['stripe-account']; if (account && !/^acct_[A-Za-z0-9]+$/.test(String(account))) { done(400); return err(res, 400, 'bad Stripe-Account'); }
    const idem = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']) : undefined; const version = req.headers['stripe-version'] ? String(req.headers['stripe-version']) : undefined;
    if (target === 'mock') {
      if (printPlan) { const a = call(method, path, { data: pairs, idempotencyKey: idem, account, version, dryRun: true }); log(`PLAN  ${a.argv.join(' ')}`); }
      const q = new URLSearchParams(); for (const [k, v] of pairs) q.append(k, v);
      const url = `${mockUrl}${path}${method === 'GET' || method === 'DELETE' ? `?${q}` : ''}`;
      const headers = { Authorization: 'Bearer sk_test_mock', ...(idem ? { 'Idempotency-Key': idem } : {}), ...(account ? { 'Stripe-Account': String(account) } : {}), ...(version ? { 'Stripe-Version': version } : {}) };
      if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
      try { const r = await fetch(url, { method, headers, body: method === 'POST' ? q.toString() : undefined }); const t = await r.text(); done(r.status); res.writeHead(r.status, { 'Content-Type': 'application/json' }); return res.end(t); }
      catch (e) { done(502); return err(res, 502, `stripe-mock unreachable: ${e.message}`, 'api_connection_error'); }
    }
    const r = await new Promise((ok) => { queue = queue.then(() => ok(call(method, path, { data: pairs, idempotencyKey: idem, account, version }))); });   // serialised
    done(r.status); return reply(res, r.status, r.body);
  };
  return { server: http.createServer((q, s) => { handle(q, s).catch((e) => { try { err(s, 500, `forwarder error: ${e.message}`, 'api_error'); } catch { /* */ } }); }), journal };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2); const get = (f, d) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : d; };
  const target = get('--target', 'cli'); if (!['cli', 'mock'].includes(target)) { console.error('--target must be cli or mock'); process.exit(1); }
  const { server } = createForwarder({ target, mockUrl: get('--mock-url', 'http://127.0.0.1:12111'), tag: get('--tag', null), printPlan: a.includes('--print-plan') });
  server.listen(Number(get('--port', '0')) || 0, '127.0.0.1', () => {
    const port = server.address().port; console.log(`FORWARDER_URL=http://127.0.0.1:${port} (target ${target})`);
    if (get('--port-file')) writeFileSync(get('--port-file'), String(port));
  });
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));
}
