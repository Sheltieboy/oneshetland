// accept-gateway.mjs — LOCAL-ONLY. The same routing the hosted API gives supabase-js: /auth/v1/* -> GoTrue, /rest/v1/* -> PostgREST. Loopback only.
// It adds no authority of its own: every request is forwarded with the caller's own headers, so Row Level Security and the JWT decide everything.
import http from 'node:http';
import { readFileSync } from 'node:fs';
const PORT = Number(process.env.GW_PORT ?? 54800), AUTH = Number(process.env.GW_AUTH ?? 54803), REST = Number(process.env.GW_REST ?? 54802);
http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': req.headers.origin ?? '*', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': 'content-range,content-profile' };
  if (req.method === 'OPTIONS' && !(req.url ?? '').startsWith('/functions/v1/')) { res.writeHead(204, cors); return res.end(); }   // functions answer their own preflight
  // TEST-ONLY convenience: GET /__login/<fictional user>?next=<path on the website> signs that user in (real GoTrue password sign-in) and sets the same session cookie the
  // sign-in form does. Cookies ignore the port, so the website on 127.0.0.1:3111 receives it. Loopback only; refuses anyone but the seeded @accept.test accounts.
  const lg = /^\/__login\/([a-z0-9]+)(?:\?next=(.*))?$/.exec(req.url ?? '');
  if (lg) {
    (async () => {
      const anon = readFileSync('/tmp/accept-anon.txt', 'utf8').trim(), pw = JSON.parse(readFileSync('/tmp/accept-users.json', 'utf8')).password;
      const r = await fetch(`http://127.0.0.1:${AUTH}/token?grant_type=password`, { method: 'POST', headers: { apikey: anon, 'content-type': 'application/json' }, body: JSON.stringify({ email: `${lg[1]}@accept.test`, password: pw }) });
      const j = await r.text(); if (!r.ok) { res.writeHead(401, cors); return res.end(j); }
      const value = 'base64-' + Buffer.from(j).toString('base64url'), chunks = []; for (let i = 0; i < value.length; i += 3180) chunks.push(value.slice(i, i + 3180));
      const name = 'sb-127-auth-token', set = chunks.length === 1 ? [`${name}=${value}`] : chunks.map((c, i) => `${name}.${i}=${c}`);
      const clear = [name, `${name}.0`, `${name}.1`].map((n) => `${n}=; Path=/; Max-Age=0`);
      res.writeHead(302, { ...cors, 'set-cookie': [...clear, ...set.map((c) => `${c}; Path=/; Max-Age=86400; SameSite=Lax`)], location: `http://127.0.0.1:3111${decodeURIComponent(lg[2] ?? '/account')}` }); res.end();
    })().catch((e) => { res.writeHead(500, cors); res.end(String(e)); });
    return;
  }
  // LOCAL-ONLY mock of the browser's Turnstile widget (the live widget script must never be loaded by test traffic), and the local host for the
  // submit-funeral-enquiry function: the real handler, Cloudflare mocked. cf-connecting-ip is set HERE from the socket (or x-test-client-ip, to simulate other
  // visitors); in production Cloudflare sets it and a caller cannot override it.
  if ((req.url ?? '').startsWith('/__mock/turnstile.js')) { res.writeHead(200, { ...cors, 'content-type': 'text/javascript' }); return res.end(readFileSync(new URL('./_mock-turnstile-widget.js', import.meta.url))); }
  if ((req.url ?? '').startsWith('/__mock/turnstile-control')) {
    (async () => { const { state } = await import('./_mock-turnstile.ts'); const u = new URL(req.url, 'http://x'); const o = u.searchParams.get('outage'); state.outage = o === 'throw' || o === 'http500' || o === 'badjson' ? o : null; if (u.searchParams.get('reset')) { state.redeemed.clear(); state.calls.length = 0; } res.writeHead(200, cors); res.end(JSON.stringify({ outage: state.outage, calls: state.calls.length })); })().catch((e) => { res.writeHead(500, cors); res.end(String(e)); });
    return;
  }
  if ((req.url ?? '').startsWith('/__mock/push-log')) {
    (async () => { const { push } = await import('./accept-functions.ts'); if ((req.url ?? '').includes('reset=1')) push.reset(); res.writeHead(200, cors); res.end(JSON.stringify(push.log)); })().catch((e) => { res.writeHead(500, cors); res.end(String(e)); });
    return;
  }
  if ((req.url ?? '').startsWith('/functions/v1/notify-notice-audience')) {
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', async () => {
      try {
        const { handleAudienceLocal } = await import('./accept-functions.ts');
        const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
        const r = await handleAudienceLocal(new Request(`http://127.0.0.1:${PORT}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
        res.writeHead(r.status, Object.fromEntries(r.headers.entries())); res.end(Buffer.from(await r.arrayBuffer()));
      } catch (e) { res.writeHead(500, cors); res.end(JSON.stringify({ error: 'local function error', detail: String(e) })); }
    });
    return;
  }
  if ((req.url ?? '').startsWith('/functions/v1/submit-funeral-enquiry')) {
    const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', async () => {
      try {
        const { handleLocal } = await import('./accept-functions.ts');
        const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'cf-connecting-ip' && k !== 'x-forwarded-for') headers.set(k, v);
        headers.set('cf-connecting-ip', String(req.headers['x-test-client-ip'] ?? req.socket.remoteAddress ?? ''));
        const r = await handleLocal(new Request(`http://127.0.0.1:${PORT}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
        res.writeHead(r.status, Object.fromEntries(r.headers.entries())); res.end(Buffer.from(await r.arrayBuffer()));
      } catch (e) { res.writeHead(500, cors); res.end(JSON.stringify({ ok: false, error: 'local function error', detail: String(e) })); }
    });
    return;
  }
  const m = /^\/(auth|rest)\/v1(\/.*)?$/.exec(req.url ?? '');
  if (!m) { res.writeHead(404, cors); return res.end('{"message":"not routed"}'); }
  const port = m[1] === 'auth' ? AUTH : REST;
  const up = http.request({ host: '127.0.0.1', port, path: m[2] ?? '/', method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (r) => { res.writeHead(r.statusCode ?? 502, { ...r.headers, ...cors }); r.pipe(res); });
  up.on('error', (e) => { res.writeHead(502, cors); res.end(JSON.stringify({ message: String(e.message) })); });
  req.pipe(up);
}).listen(PORT, '127.0.0.1', () => console.log(`accept-gateway on ${PORT} -> auth ${AUTH}, rest ${REST}`));
