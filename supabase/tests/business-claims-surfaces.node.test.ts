/**
 * business-claims-surfaces.node.test.ts — the claim flow as the apps and the admin screens use it.
 *
 * The rules themselves (who may submit, edit, approve, what approval changes) are proved against real SQL in
 * business-claims-flow.node.test.ts. This holds down what the CLIENTS do with them, so a screen can never start
 * depending on a power the database no longer gives, and the admin side keeps working:
 *
 *   · claimants only ever INSERT a pending claim and READ their own — nothing in either app edits or deletes one
 *   · only the admin screens update a claim, and approval goes through the approve_business_claim function
 *   · the web reject handler reports a refused write instead of claiming success
 *   · the claim entry and the admin queue exist on both platforms
 *
 * Source-level and read-only. Needs the sibling ../oneshetland-web checkout.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(MOBILE, '..', 'oneshetland-web');
const haveWeb = existsSync(join(WEB, 'components', 'admin', 'ClaimsManager.tsx'));
const opts = { skip: haveWeb ? false : 'sibling oneshetland-web checkout not found' };
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (p: string) => code(readFileSync(p, 'utf8'));

function files(dir: string, acc: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.next') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) files(p, acc); else if (/\.(tsx?)$/.test(n) && !n.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}
/** Every place a client touches business_claims, with the operation chained after it. */
function claimTouches(root: string, dirs: string[]): Array<{ file: string; op: string; text: string }> {
  const out: Array<{ file: string; op: string; text: string }> = [];
  for (const d of dirs) for (const f of files(join(root, d))) {
    const src = read(f);
    for (const m of src.matchAll(/\.from\(\s*['"]business_claims['"]\s*\)([\s\S]{0,900}?)(?=;|\n\s*\n)/g)) {
      const op = (m[1].match(/\.(insert|update|delete|upsert|select)\(/) ?? [])[1] ?? '?';
      out.push({ file: f.slice(root.length + 1), op, text: m[1] });
    }
  }
  return out;
}

describe('what clients do to claims', opts, () => {
  const web = () => claimTouches(WEB, ['app', 'components', 'lib']);
  const mobile = () => claimTouches(MOBILE, ['app', 'lib', 'components']);

  test('nothing in either app deletes or upserts a claim', () => {
    for (const t of [...web(), ...mobile()]) assert.ok(!['delete', 'upsert'].includes(t.op), `${t.file}: ${t.op}`);
  });

  test('claim INSERTS are the claimant\'s own submission and are never pre-decided', () => {
    const inserts = [...web(), ...mobile()].filter((t) => t.op === 'insert');
    assert.ok(inserts.length >= 2, 'web form and app both submit');
    for (const t of inserts) {
      assert.doesNotMatch(t.text, /status:\s*['"](approved|rejected)['"]/, t.file);
      assert.doesNotMatch(t.text, /reviewed_(at|by)/, t.file);
    }
    assert.match(readFileSync(join(WEB, 'components/directory/BusinessClaimForm.tsx'), 'utf8'), /status: "pending"/);
  });

  test('claim UPDATES come only from the admin screens', () => {
    const updates = [...web(), ...mobile()].filter((t) => t.op === 'update');
    const allowed = new Set(['components/admin/ClaimsManager.tsx', 'lib/local-api.ts']);
    assert.ok(updates.length >= 2);
    for (const t of updates) assert.ok(allowed.has(t.file), `${t.file} updates a claim but is not an admin screen`);
  });

  test('approval goes through the admin-only function on both platforms, never a direct status update', () => {
    assert.match(read(join(WEB, 'components/admin/ClaimsManager.tsx')), /rpc\("approve_business_claim"/);
    assert.match(read(join(MOBILE, 'lib/local-api.ts')), /rpc\('approve_business_claim'/);
    for (const t of [...web(), ...mobile()].filter((x) => x.op === 'update')) assert.doesNotMatch(t.text, /status:\s*['"]approved['"]/, t.file);
  });

  test('THE DEFECT: the web reject handler checks the write and tells the admin when it fails', () => {
    const src = read(join(WEB, 'components/admin/ClaimsManager.tsx'));
    const reject = src.slice(src.indexOf('async function reject'), src.indexOf('return', src.indexOf('async function reject')));
    assert.match(reject, /const \{ error \} = await sb\.from\("business_claims"\)\.update/);
    assert.match(reject, /if \(error\) throw error/);
    assert.match(reject, /Couldn't reject/);
    assert.ok(reject.indexOf('if (error) throw error') < reject.indexOf('notify-claim'), 'the claimant is only told after the write succeeded');
  });
});

describe('the claim flow exists end to end on both platforms', opts, () => {
  test('web: a signed-out visitor is sent to sign in and returned to the claim; the listing offers it only when unclaimed', () => {
    const page = read(join(WEB, 'app/directory/[id]/claim/page.tsx'));
    assert.match(page, /redirect\(`\/sign-in\?next=\/directory\/\$\{id\}\/claim`\)/);
    assert.match(read(join(WEB, 'app/directory/[id]/page.tsx')), /!b\.is_claimed &&/);
  });
  test('app: the claim screen is reachable from a listing', () => {
    assert.ok(existsSync(join(MOBILE, 'app/business-claim.tsx')));
    assert.match(read(join(MOBILE, 'app/local-business-detail.tsx')), /\/business-claim\?id=/);
  });
  test('admins have a queue with a pending badge on web and a screen in the app; both call the notifier', () => {
    assert.match(read(join(WEB, 'components/admin/AdminSidebar.tsx')), /\/admin\/claims[^}]*pendingClaims/);
    assert.ok(existsSync(join(MOBILE, 'app/(admin)/business-claims.tsx')));
    assert.match(read(join(WEB, 'components/admin/ClaimsManager.tsx')), /notify-claim/);
    assert.match(read(join(MOBILE, 'lib/local-api.ts')), /notify-claim/);
    assert.match(read(join(MOBILE, 'lib/local-api.ts')), /notify-business-claim/);
  });
  test('the outcome notice is admin-only (a claimant cannot trigger their own "You\'re verified")', () => {
    const gate = read(join(MOBILE, 'supabase/functions/_shared/claim-outcome-notify-auth.ts'));
    assert.match(gate, /role\?: string \} \| null\)\?\.role !== 'admin'\) return denyNotify\(403/);
  });
  test('an approved claim\'s notice opens the business in the shipped app (business_id fallback)', () => {
    const sender = read(join(MOBILE, 'supabase/functions/notify-claim/index.ts'));
    assert.match(sender, /business_id/);
  });
});

describe('the database side is in the migrations', () => {
  const sql = (n: string) => read(join(MOBILE, 'supabase/migrations', n)).replace(/^\s*--.*$/gm, '');
  test('claimants can submit and read; the catch-all policy is dropped', () => {
    const m = sql('20261031030000_business_claims_claimants_submit_only.sql');
    assert.match(m, /drop policy if exists "Users manage their own claims"/);
    assert.match(m, /create policy "Users submit their own pending claims" on public\.business_claims\s+for insert/);
    assert.match(m, /create policy "Users read their own claims" on public\.business_claims\s+for select/);
    assert.doesNotMatch(m, /for (all|update|delete)/i);
    assert.match(m, />= 5/);
  });
  test('every decision records its decider', () => {
    assert.match(sql('20261031040000_business_claims_record_the_decider.sql'), /create trigger business_claims_record_decider\s+before update/);
  });
});
