// ui-proxy.mjs — LOCAL-ONLY. Presents the throwaway PostgREST as a hosted-style Supabase URL for a browser / simulator run:
//   /rest/v1/<table>   forwarded to PostgREST for the notice-related tables, answered with [] for every other table (the fixture database has
//                       nothing else), /rest/v1/rpc/* forwarded, /auth/v1/* answered "no session". Optional DELAY_RPC_MS slows rpc calls.
import http from 'node:http';
import { execFile } from 'node:child_process';
const PORT = Number(process.env.PROXY_PORT ?? 54790), REST = Number(process.env.REST_PORT ?? 54782), DELAY = Number(process.env.DELAY_RPC_MS ?? 0);
const FORWARD = new Set(['notices', 'hubs', 'local_businesses', 'hub_campaigns', 'events', 'notice_areas', 'notice_categories', 'hub_members', 'profiles']);
let rpcCount = 0;
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (url.pathname === '/__stats') { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end(JSON.stringify({ rpcCount })); }
  // fixture-only helper: /__pin/<notice id> makes that notice the pinned (so first) one, to look at each publisher kind in turn
  const pin = url.pathname.match(/^\/__pin\/([0-9a-f-]{36})$/);
  if (pin) {
    return execFile('docker', ['exec', 'notices-proof-pg', 'psql', '-U', 'postgres', '-h', 'localhost', '-d', 'postgres', '-c', `update notices set is_pinned = (id = '${pin[1]}')`],
      (err) => { res.writeHead(err ? 500 : 200, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: !err })); });
  }
  if (url.pathname.startsWith('/auth/v1')) { res.writeHead(401, { ...cors, 'content-type': 'application/json' }); return res.end('{"msg":"no session"}'); }
  const m = url.pathname.match(/^\/rest\/v1\/([^/]+)(?:\/(.*))?$/);
  if (!m) { res.writeHead(404, cors); return res.end(); }
  const table = m[1];
  if (table !== 'rpc' && !FORWARD.has(table)) { res.writeHead(200, { ...cors, 'content-type': 'application/json', 'content-range': '*/0' }); return res.end(req.method === 'HEAD' ? undefined : '[]'); }
  if (table === 'rpc') { rpcCount++; if (DELAY) await new Promise((r) => setTimeout(r, DELAY)); }
  const up = http.request({ host: '127.0.0.1', port: REST, path: url.pathname.replace(/^\/rest\/v1/, '') + url.search, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${REST}` } },
    (r) => { res.writeHead(r.statusCode ?? 500, { ...r.headers, ...cors }); r.pipe(res); });
  up.on('error', () => { res.writeHead(502, cors); res.end(); }); req.pipe(up);
}).listen(PORT, '127.0.0.1', () => console.log(`ui-proxy on ${PORT} -> PostgREST ${REST}`));
