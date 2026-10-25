// scripts/test-safety/inventory.mjs — static inventory of supabase/tests: which suites EXECUTE access to a hosted service, how, and whether
// they can write (Fetch v2, Step 13). Reads source only; runs nothing. Usage: node scripts/test-safety/inventory.mjs . > inventory.json
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root = process.argv[2];
const dir = join(root, 'supabase/tests');
const files = readdirSync(dir).filter((f) => /\.(ts|mjs|js)$/.test(f)).sort();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const iso = existsSync(join(root, 'scripts/isolated-pg.mjs')) ? readFileSync(join(root, 'scripts/isolated-pg.mjs'), 'utf8') : '';
const WRITE_SQL = /\b(insert\s+into|update\s+[a-z_."]+\s+set|delete\s+from|truncate\b|alter\s+table|drop\s+(table|function|policy|trigger)|create\s+(or\s+replace\s+)?(function|table|policy|trigger)|grant\s+|revoke\s+)/i;
const out = [];
for (const f of files) {
  const s = readFileSync(join(dir, f), 'utf8');
  const p = `supabase/tests/${f}`;
  const how = [];
  if (/['"]--linked['"]/.test(s)) how.push('linked-cli');
  if (/readFileSync\([^)]*service_key|['"]service_key\.txt['"]|process\.env\.SUPABASE_SERVICE_ROLE_KEY/.test(s)) how.push('service-key');
  if (/fetch\(\s*`\$\{[^}]*(url|URL|Url|SUPABASE|base|BASE)/.test(s) || (/fetch\(\s*(url|URL|endpoint)\b/.test(s) && /(rest|functions|storage|auth)\/v1/.test(s))) how.push('http-api');
  if (/fetch\([^)]*(LAUNCH_READINESS_BASE_URL|https:\/\/(www\.)?oneshetland\.com)/.test(s)) how.push('live-site');
  if (/nkrtmakxygkvxuxriiil/.test(s)) how.push('prod-ref-literal');
  if (/PASS_PROOF_DSN|BOOKING_PROOF_DSN/.test(s)) how.push('isolated-dsn');
  // The guard suites name these signatures in order to look for them; they reach nothing.
  const selfRef = /(test-safety|test-registration)\.node\.test\.ts$/.test(f);
  const reaches = !selfRef && how.some((h) => ['linked-cli', 'service-key', 'http-api', 'live-site'].includes(h));
  const tpl = [...s.matchAll(/`([\s\S]*?)`/g)].map((m) => m[1]).join('\n');
  const sqlWrite = WRITE_SQL.test(tpl);
  const httpWrite = /method:\s*['"](POST|PATCH|PUT|DELETE)['"]/.test(s);
  const authUsers = /auth\/v1\/admin\/users|admin\.createUser|createUser\(|signUp\(/.test(s);
  const fetchRelated = /^fetch-/.test(f) || /delivery_requests|fetch_authoris|fetch_capture|fetch-quote|fetch-authorise|fetch_base_fee/.test(s);
  const lanes = Object.entries(pkg.scripts).filter(([, v]) => v.includes(p)).map(([k]) => k);
  if (iso.includes(p)) lanes.push('isolated-pg');
  out.push({ file: p, reaches, how, sqlWrite, httpWrite, authUsers, fetchRelated, lanes });
}
console.log(JSON.stringify(out, null, 1));
