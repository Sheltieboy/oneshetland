// accept-gateway.mjs — LOCAL-ONLY. The same routing the hosted API gives supabase-js: /auth/v1/* -> GoTrue, /rest/v1/* -> PostgREST. Loopback only.
// It adds no authority of its own: every request is forwarded with the caller's own headers, so Row Level Security and the JWT decide everything.
import http from 'node:http';
import { readFileSync } from 'node:fs';
const PORT = Number(process.env.GW_PORT ?? 54800), AUTH = Number(process.env.GW_AUTH ?? 54803), REST = Number(process.env.GW_REST ?? 54802);
http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': req.headers.origin ?? '*', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': 'content-range,content-profile' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
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
  const m = /^\/(auth|rest)\/v1(\/.*)?$/.exec(req.url ?? '');
  if (!m) { res.writeHead(404, cors); return res.end('{"message":"not routed"}'); }
  const port = m[1] === 'auth' ? AUTH : REST;
  const up = http.request({ host: '127.0.0.1', port, path: m[2] ?? '/', method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (r) => { res.writeHead(r.statusCode ?? 502, { ...r.headers, ...cors }); r.pipe(res); });
  up.on('error', (e) => { res.writeHead(502, cors); res.end(JSON.stringify({ message: String(e.message) })); });
  req.pipe(up);
}).listen(PORT, '127.0.0.1', () => console.log(`accept-gateway on ${PORT} -> auth ${AUTH}, rest ${REST}`));
