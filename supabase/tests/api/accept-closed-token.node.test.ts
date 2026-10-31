/**
 * accept-closed-token.node.test.ts - (after deleting an account, the SAME token must have no authority) runs the ACTUAL delete-account edge function (supabase/functions/delete-account/index.ts, byte for byte apart from its two
 * import lines, which are pointed at local modules so nothing is downloaded) against the writable acceptance backend, as the signed-in user, and checks what
 * the member's notices look like afterwards. Only the Deno runtime is replaced (a `serve` that hands back the handler, and Deno.env).
 *   ACCEPT_RUN=1 node --test supabase/tests/api/accept-delete-account.node.test.ts        (after accept-env.sh start + accept-seed.mjs)
 * Fictional throwaway accounts only; the seeded accounts are never deleted.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { URL_, ANON, owner, serviceToken, iso } from './_accept-client.ts';

const RUN = process.env.ACCEPT_RUN === '1';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const R = Date.now().toString(36);
const PW = 'Accept-Test-1';

/** Load the real handler: same source, imports redirected to local modules, Deno.env provided. */
async function loadHandler(): Promise<(req: Request) => Promise<Response>> {
  let src = readFileSync(join(ROOT, 'supabase/functions/delete-account/index.ts'), 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'delete-account-'));
  const sb = pathToFileURL(join(ROOT, 'node_modules/@supabase/supabase-js/dist/index.mjs')).href;
  writeFileSync(join(dir, 'serve.mjs'), `export const serve = (h) => { globalThis.__handler = h; };`);
  src = src.replace("'https://deno.land/std@0.168.0/http/server.ts'", `'./serve.mjs'`).replace("'https://esm.sh/@supabase/supabase-js@2'", `'${sb}'`);
  assert.ok(!/https:\/\//.test(src.replace(/Access-Control[^\n]*/g, '').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'no remote import is left');
  writeFileSync(join(dir, 'index.ts'), src);   // .ts: the source has type annotations, which Node strips
  (globalThis as any).Deno = { env: { get: (k: string) => ({ SUPABASE_URL: URL_, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: serviceToken() } as Record<string, string>)[k] } };
  await import(pathToFileURL(join(dir, 'index.ts')).href);
  return (globalThis as any).__handler;
}

async function signUp(email: string, name: string): Promise<{ id: string; token: string }> {
  const r = await (await fetch(`${URL_}/auth/v1/signup`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) })).json() as any;
  const id = (r.user ?? r).id as string;
  owner(`insert into profiles (id, role, display_name, full_name, phone, bio, onboarding_completed_at) values ('${id}', 'customer', '${name}', '${name}', '07700 900999', 'About me', now())`);
  return { id, token: await token(email) };
}
async function token(email: string) {
  const r = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PW }) })).json() as any;
  return r.access_token as string;
}
const call = async (tok: string, path: string, method: string, body?: unknown, prefer = 'return=representation') => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { method, headers: { apikey: ANON, authorization: `Bearer ${tok}`, 'content-type': 'application/json', prefer }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); return { status: r.status, data: t ? JSON.parse(t) : null };
};
const rpcAs = (tok: string | null, fn: string, args: Record<string, unknown> = {}) => call(tok ?? ANON, `rpc/${fn}`, 'POST', args);
const staffToken = () => token('moderator@accept.test');

const d = RUN ? describe : describe.skip;
const del = async (tok: string) => { const handler = await loadHandler(); const res = await handler(new Request('http://local/delete-account', { method: 'POST', headers: { Authorization: `Bearer ${tok}` } })); return { res, body: await res.json() as any }; };
const refused = (r: { status: number; data: any }) => r.status >= 400;

d('EXISTING TOKENS after account deletion: the same JWT, used after the account is deleted, has no authority and reads/writes nothing of the member', () => {
  const S: Record<string, any> = {};
  test('1 set-up: a member with areas, preferences, a funeral submission, a Council publisher seat; and a platform administrator; each holding a token', async () => {
    const admin = await token('admin@accept.test');
    S.admin = admin;
    S.org = (await rpcAs(admin, 'admin_upsert_official_publisher', { p_slug: `tok-org-${R}`, p_name: `Token Test Org ${R}`, p_kind: 'council' })).data;
    await rpcAs(admin, 'admin_verify_official_publisher', { p_publisher: S.org, p_note: 'Verified by call-back to a published number' });
    S.m = await signUp(`tok-${R}@accept.test`, 'Tess Tokenholder');
    assert.ok(!refused(await rpcAs(admin, 'admin_set_official_publisher_member', { p_publisher: S.org, p_user: S.m.id, p_role: 'publisher' })));
    assert.ok(!refused(await rpcAs(S.m.token, 'set_my_notice_areas', { p_areas: ['voe'] })));
    assert.ok(!refused(await rpcAs(S.m.token, 'set_my_notice_prefs', { p_community: true })));
    const fid = await rpcAs(S.m.token, 'submit_funeral_notice', { p: { full_name: `Token Person ${R}`, submitter_name: 'Tess Tokenholder', submitter_phone: '07700 900555', family_authorised: true } });
    assert.ok(!refused(fid), JSON.stringify(fid.data)); S.fid = fid.data;
    const n = await rpcAs(S.m.token, 'submit_person_notice', { p_title: `Token notice ${R}`, p_body: 'A fictional personal notice before deletion.', p_category: 'other', p_area_ids: ['voe'] });
    assert.ok(!refused(n), JSON.stringify(n.data)); S.nid = n.data;
    assert.equal((await rpcAs(S.m.token, 'official_publisher_authority', { p_publisher: S.org })).data, 'official');
    // a second member: platform administrator
    S.a = await signUp(`tokadm-${R}@accept.test`, 'Ada Tokenadmin'); owner(`update profiles set role='admin' where id='${S.a.id}'`);
    assert.ok(!refused(await rpcAs(S.a.token, 'admin_upsert_official_publisher', { p_slug: `tok-a-${R}`, p_name: `Tok A ${R}`, p_kind: 'other' })));
  });
  test('2 the REAL deletion runs for both accounts', async () => {
    for (const u of [S.m, S.a]) { const { res, body } = await del(u.token); assert.equal(res.status, 200, JSON.stringify(body)); assert.equal(body.ok, true); }
  });
  test('3 personal notices: the same token cannot publish, edit or withdraw one', async () => {
    const pub = await rpcAs(S.m.token, 'submit_person_notice', { p_title: `After deletion ${R}`, p_body: 'Should never be created by a closed account.', p_category: 'other', p_area_ids: ['voe'] });
    assert.ok(refused(pub), `publication by a deleted account must fail: ${JSON.stringify(pub.data)}`);
    assert.equal(owner(`select count(*) from notices where publisher_user_id='${S.m.id}'`), '0', 'no notice exists for the closed account');
    assert.ok(refused(await rpcAs(S.m.token, 'edit_my_person_notice', { p_notice: S.nid, p_title: 'Edited after deletion', p_body: 'x'.repeat(30), p_category: 'other', p_area_ids: ['voe'] })));
    assert.ok(refused(await rpcAs(S.m.token, 'withdraw_my_person_notice', { p_notice: S.nid })));
  });
  test('4 private funeral records: no submission can be read, created, changed or requested', async () => {
    const list = await rpcAs(S.m.token, 'my_funeral_submissions', {}); assert.ok(refused(list) || (list.data as any[]).length === 0, JSON.stringify(list.data));
    const one = await rpcAs(S.m.token, 'my_funeral_submission', { p_id: S.fid }); assert.ok(refused(one) || one.data == null || Object.keys(one.data ?? {}).length === 0, JSON.stringify(one.data));
    assert.ok(refused(await rpcAs(S.m.token, 'submit_funeral_notice', { p: { full_name: `Closed ${R}`, submitter_name: 'Tess', submitter_phone: '07700 900556', family_authorised: true } })));
    assert.ok(refused(await rpcAs(S.m.token, 'withdraw_my_funeral_notice', { p_id: S.fid })));
    assert.ok(refused(await rpcAs(S.m.token, 'update_my_funeral_submission', { p_id: S.fid, p: { announcement: 'edited' } })));
    const anyApproved = owner(`select id from funeral_notices where status='approved' limit 1`);
    assert.ok(refused(await rpcAs(S.m.token, 'request_funeral_notice_change', { p_id: anyApproved, p_kind: 'takedown', p_message: 'A closed account asking' })), 'a closed account cannot file a change request');
    assert.equal((await call(S.m.token, 'funeral_notices?select=id', 'GET')).status >= 400, true, 'and the table itself is unreadable');
  });
  test('5 organisation publishing and official publisher administration', async () => {
    assert.equal((await rpcAs(S.m.token, 'official_publisher_authority', { p_publisher: S.org })).data, 'none');
    assert.ok(refused(await rpcAs(S.m.token, 'official_publish_notice', { p_publisher: S.org, p_title: 'Closed account publishing', p_body: 'Should be refused entirely.', p_category: 'other', p_area_ids: [] })));
    const mine = await rpcAs(S.m.token, 'my_official_publishers', {}); assert.ok(refused(mine) || (mine.data as any[]).length === 0, JSON.stringify(mine.data));
    assert.ok(refused(await rpcAs(S.a.token, 'admin_upsert_official_publisher', { p_slug: `tok-b-${R}`, p_name: `Tok B ${R}`, p_kind: 'other' })), 'a deleted administrator');
    assert.ok(refused(await rpcAs(S.a.token, 'admin_set_official_publisher_member', { p_publisher: S.org, p_user: S.a.id, p_role: 'publisher' })));
    assert.ok(refused(await rpcAs(S.a.token, 'admin_funeral_queue', {})), 'and funeral staff functions');
    assert.ok(refused(await rpcAs(S.a.token, 'admin_audit_redaction_candidates', {})));
    assert.equal(owner(`select count(*) from notices where publisher_user_id in ('${S.m.id}','${S.a.id}')`), '0');
  });
  test('6 private member preferences and areas: unreadable and unwritable', async () => {
    const prefs = await rpcAs(S.m.token, 'my_notice_prefs', {}); assert.ok(refused(prefs), `preferences must not be readable by a closed account: ${JSON.stringify(prefs.data)}`);
    const areas = await rpcAs(S.m.token, 'my_notice_areas', {}); assert.ok(refused(areas) || (areas.data as any[]).length === 0, JSON.stringify(areas.data));
    assert.ok(refused(await rpcAs(S.m.token, 'set_my_notice_areas', { p_areas: ['voe'] })), 'a closed account cannot create new area rows');
    assert.ok(refused(await rpcAs(S.m.token, 'set_my_notice_prefs', { p_community: true })), 'nor preference rows');
    assert.equal(owner(`select count(*) from member_areas where user_id='${S.m.id}'`) + owner(`select count(*) from notice_notification_prefs where user_id='${S.m.id}'`), '00', 'nothing was re-created for the deleted account');
  });
});
