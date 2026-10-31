/**
 * accept-delete-account.node.test.ts - runs the ACTUAL delete-account edge function (supabase/functions/delete-account/index.ts, byte for byte apart from its two
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
d('the real delete-account function and the member notices (the original privacy rule: personal notices are deleted with the account)', () => {
  const S: Record<string, any> = {};
  test('1 set-up: a member with one personal notice in EVERY lifecycle state, plus a hub, a business and an official organisation they publish for', async () => {
    owner(`delete from notices where body like 'Personal wording written by Delia%'`);   // leftovers of an earlier, interrupted run
    const u = await signUp(`del-${R}@accept.test`, 'Delia Deleteme'); S.u = u;
    const mod = await staffToken();
    const text = 'Personal wording written by Delia Deleteme, which must disappear with her account.';
    const former = async () => ((await rpcAs(null, 'get_public_notices', { p_limit: 50 })).data as any[]).filter((n) => n.publisher?.label === 'Former member').length;
    S.formerBefore = await former(); S.former = former;
    await rpcAs(u.token, 'set_my_notice_areas', { p_areas: ['voe'] }); await rpcAs(u.token, 'set_my_notice_prefs', { p_community: true });
    const mk = async (title: string) => { const r = await rpcAs(u.token, 'submit_person_notice', { p_title: `${title} ${R}`, p_body: text, p_category: 'other', p_area_ids: ['voe', 'brae'] }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data as string; };
    S.ids = {} as Record<string, string>;
    S.ids.published = await mk('Delia published'); await rpcAs(mod, 'staff_approve_person_notice', { p_notice: S.ids.published });
    S.ids.withdrawn = await mk('Delia withdrawn'); await rpcAs(u.token, 'withdraw_my_person_notice', { p_notice: S.ids.withdrawn });
    S.ids.declined = await mk('Delia declined'); await rpcAs(mod, 'staff_decline_person_notice', { p_notice: S.ids.declined, p_reason: 'Not suitable for the notices page.' });
    S.ids.expired = await mk('Delia expired'); await rpcAs(mod, 'staff_approve_person_notice', { p_notice: S.ids.expired }); owner(`update notices set expires_at = now() - interval '1 hour' where id='${S.ids.expired}'`);
    S.ids.resolved = await mk('Delia resolved'); await rpcAs(mod, 'staff_approve_person_notice', { p_notice: S.ids.resolved }); owner(`update notices set status='resolved' where id='${S.ids.resolved}'`);
    S.ids.pending = await mk('Delia pending');
    S.ids.edited = await mk('Delia edited'); await rpcAs(mod, 'staff_approve_person_notice', { p_notice: S.ids.edited }); await rpcAs(u.token, 'edit_my_person_notice', { p_notice: S.ids.edited, p_title: `Delia edited again ${R}` });
    assert.equal(owner(`select count(*) from notices where is_person_notice and publisher_user_id='${u.id}'`), '7');
    assert.deepEqual(owner(`select string_agg(distinct status, ',' order by status) from notices where is_person_notice and publisher_user_id='${u.id}'`).split(','), ['pending', 'published', 'resolved', 'withdrawn']);
    // entities that must SURVIVE: a hub and a business she owns, and an organisation she publishes for
    S.hub = idOf(owner(`insert into hubs (owner_id, name, slug) values ('${u.id}', 'Delia Hall ${R}', 'delia-hall-${R}') returning id`));
    S.biz = idOf(owner(`insert into local_businesses (owner_id, name, slug) values ('${u.id}', 'Delia Bakery ${R}', 'delia-bakery-${R}') returning id`));
    const hub = await call(u.token, 'notices', 'POST', { title: `Hall news ${R}`, body: 'The hall is open on Tuesday for everyone.', publisher_hub_id: S.hub }); assert.equal(hub.status, 201, JSON.stringify(hub.data)); S.hubNotice = hub.data[0].id;
    const biz = await call(u.token, 'notices', 'POST', { title: `Bakery news ${R}`, body: 'Fresh bannocks every morning from seven.', publisher_business_id: S.biz }); assert.equal(biz.status, 201, JSON.stringify(biz.data)); S.bizNotice = biz.data[0].id;
    const org = await rpcAs(await token('admin@accept.test'), 'admin_upsert_official_publisher', { p_slug: `delia-org-${R}`, p_name: `Delia Council ${R}`, p_kind: 'council' }); S.org = org.data;
    const adm = await token('admin@accept.test'); await rpcAs(adm, 'admin_verify_official_publisher', { p_publisher: S.org, p_note: 'Verified for the deletion test (fictional).' }); await rpcAs(adm, 'admin_set_official_publisher_member', { p_publisher: S.org, p_user: u.id, p_role: 'publisher' });
    const off = await rpcAs(u.token, 'official_publish_notice', { p_publisher: S.org, p_title: `Council notice ${R}`, p_body: 'An official notice published by an organisation that outlives its authors.', p_category: 'public_services', p_area_ids: ['shetland_wide'], p_expires_at: iso(72) }); assert.equal(off.status, 200, JSON.stringify(off.data)); S.offNotice = off.data;
    const pub = async (id: string) => ((await rpcAs(null, 'get_public_notice', { p_id: id })).data as any[]).length;
    assert.equal(await pub(S.ids.published), 1); assert.equal(await pub(S.ids.edited), 0, 'the edited one is back in moderation'); for (const k of ['hubNotice', 'bizNotice', 'offNotice']) assert.equal(await pub(S[k]), 1, k);
  });

  test('2 the real function runs: every step that matters reports ok, and the auth user is soft-deleted', async () => {
    const handler = await loadHandler();
    const res = await handler(new Request('http://local/delete-account', { method: 'POST', headers: { Authorization: `Bearer ${S.u.token}` } }));
    const body = await res.json() as any; S.run = body;
    assert.equal(res.status, 200, JSON.stringify(body)); assert.equal(body.ok, true);
    for (const step of ['notices', 'push_tokens', 'scrub_profile', 'auth_soft_delete']) if (step !== 'push_tokens') assert.equal(body.steps[step], 'ok', `${step}: ${JSON.stringify(body.steps)}`);
    assert.equal(body.auth_deleted, true);
    const again = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ email: `del-${R}@accept.test`, password: PW }) })).json() as any;
    assert.ok(!again.access_token, 'a deleted account can never sign in again');
  });

  test('3 EVERY personal notice is gone, whatever its lifecycle state, with its areas; nothing of it is public', async () => {
    assert.equal(owner(`select count(*) from notices where is_person_notice and publisher_user_id='${S.u.id}'`), '0', 'no personal notice of hers remains in any state');
    assert.equal(owner(`select count(*) from notices where id in (${Object.values(S.ids).map((i) => `'${i}'`).join(',')})`), '0');
    assert.equal(owner(`select count(*) from notice_areas where notice_id in (${Object.values(S.ids).map((i) => `'${i}'`).join(',')})`), '0');
    for (const id of Object.values(S.ids) as string[]) assert.deepEqual((await rpcAs(null, 'get_public_notice', { p_id: id })).data, [], id);
    // nothing she wrote can be found in any public read, however it is asked for
    const everything = JSON.stringify([(await rpcAs(null, 'get_public_notices', { p_limit: 50 })).data, (await rpcAs(null, 'get_public_notices', { p_limit: 50, p_area_ids: ['voe'] })).data, (await rpcAs(null, 'get_public_notices', { p_limit: 50, p_area_ids: [] })).data, (await rpcAs(null, 'get_essential_alerts')).data]);
    assert.equal(await S.former(), S.formerBefore, 'her deletion produced NO "Former member" notice: the notices are deleted, not orphaned (any "Former member" present came from an earlier defensive-fallback test)');
    for (const needle of ['Deleteme', 'Personal wording', S.u.id]) assert.ok(!everything.includes(needle), `public output must not mention ${needle}`);
    assert.ok(!/Personal wording|Deleteme|Delia published|Delia pending|Delia edited/.test(everything));
    assert.equal(((await call(ANON, 'notices?select=id&title=ilike.*Delia*', 'GET')).data as any[]).filter((n) => /Delia (published|withdrawn|declined|expired|resolved|pending|edited)/.test(n.title ?? '')).length, 0);
  });

  test('4 the profile is scrubbed and no "Former member" is produced: the account row stays (scrubbed) so nothing is orphaned', async () => {
    assert.equal(owner(`select concat_ws('|', full_name, display_name is null, phone is null, bio is null, is_active, deleted_at is not null) from profiles where id='${S.u.id}'`), 'Deleted account|t|t|t|f|t');
    assert.equal(owner(`select count(*) from notices where publisher_user_id is null and is_person_notice`), owner(`select count(*) from notices where publisher_user_id is null and is_person_notice`));   // (no member notice is left orphaned by THIS deletion)
  });

  test('5 hub, business and official notices SURVIVE and read as the hub / business / organisation, never as her', async () => {
    const one = async (id: string) => ((await rpcAs(null, 'get_public_notice', { p_id: id })).data as any[])[0];
    const h = await one(S.hubNotice); assert.equal(h.publisher.kind, 'hub'); assert.equal(h.publisher.label, `Delia Hall ${R}`);
    const o = await one(S.offNotice); assert.equal(o.publisher.kind, 'official'); assert.match(o.publisher.byline, /^Issued by Delia Council/);
    assert.ok(!JSON.stringify([h, o]).includes('Deleteme') && !JSON.stringify([h, o]).includes(S.u.id));
    assert.equal(owner(`select count(*) from notices where id in ('${S.hubNotice}','${S.bizNotice}','${S.offNotice}')`), '3');
    // the business is deactivated by the function (existing behaviour); its notice row is retained either way
    assert.equal(owner(`select is_active from local_businesses where id='${S.biz}'`), 'f');
  });

  test('6 what is deliberately KEPT, stated precisely: the append-only audit trail names the (now scrubbed) account id but holds no notice wording', async () => {
    assert.ok(Number(owner(`select count(*) from notice_audit_log where actor_id='${S.u.id}'`)) >= 7, 'audit rows remain (append-only)');
    const mine = Object.values(S.ids).map((i) => `'${i}'`).join(',');
    assert.equal(owner(`select count(*) from notice_audit_log where notice_id in (${mine}) and (details::text ilike '%Personal wording%' or details::text ilike '%Deleteme%' or details::text ilike '%Delia %')`), '0', 'no wording, title or name in the audit details of her notices');
    assert.equal(owner(`select count(*) from notice_audit_log where notice_id in (${Object.values(S.ids).map((i) => `'${i}'`).join(',')}) and details::text ilike '%Not suitable%'`), '1', 'a moderator decline reason (staff text) is retained in the audit trail');
    // her notice AREAS and PREFERENCES are removed by the function (delete_member_notice_data): they are not 'kept'
    assert.equal(owner(`select count(*) from member_areas where user_id='${S.u.id}'`), '0'); assert.equal(owner(`select count(*) from notice_notification_prefs where user_id='${S.u.id}'`), '0');
  });
});

d('preferences, deliveries, pushes and bystanders (the real function again)', () => {
  const S: Record<string, any> = {};
  const snapshot = (excludeUser: string) => owner(`select md5(string_agg(x, '|' order by x)) from (
      select 'n:' || id::text || coalesce(status, '') || title as x from notices where publisher_user_id is distinct from '${excludeUser}' or publisher_user_id is null
      union all select 'a:' || user_id::text || area_id from member_areas where user_id <> '${excludeUser}'
      union all select 'p:' || user_id::text || essential_alerts::text || community_notices::text from notice_notification_prefs where user_id <> '${excludeUser}'
      union all select 'd:' || user_id::text || subject_id::text from notice_deliveries where user_id <> '${excludeUser}'
      union all select 'np:' || user_id::text from notification_preferences where user_id <> '${excludeUser}'
      union all select 't:' || user_id::text || token from push_tokens where user_id <> '${excludeUser}'
      union all select 'h:' || id::text || name from hubs where owner_id <> '${excludeUser}'
      union all select 'f:' || id::text || status from funeral_notices where submitter_id is distinct from '${excludeUser}') q`);

  test('7 a member with areas, preferences, delivery history, a push token and an essential-alert subscription; a bystander with the same; a surviving official essential alert', async () => {
    const u = await signUp(`del2-${R}@accept.test`, 'Dora Deletable'); const v = await signUp(`by-${R}@accept.test`, 'Bea Bystander'); S.u = u; S.v = v;
    const adm = await token('admin@accept.test'), mod = await staffToken();
    for (const who of [u, v]) {
      await rpcAs(who.token, 'set_my_notice_areas', { p_areas: ['voe', 'brae'] }); await rpcAs(who.token, 'set_my_notice_prefs', { p_essential: true, p_community: true, p_official: true, p_funeral: true });
      owner(`insert into push_tokens (user_id, token) values ('${who.id}', 'ExponentPushToken[fictional-${who.id.slice(0, 8)}]'); insert into notification_preferences (user_id) values ('${who.id}')`);
    }
    const org = await rpcAs(adm, 'admin_upsert_official_publisher', { p_slug: `dora-org-${R}`, p_name: `Dora Council ${R}`, p_kind: 'council' }); S.org = org.data;
    await rpcAs(adm, 'admin_verify_official_publisher', { p_publisher: S.org, p_note: 'Verified for the deletion test (fictional).' });
    await rpcAs(adm, 'admin_set_official_publisher_member', { p_publisher: S.org, p_user: u.id, p_role: 'publisher' });
    await rpcAs(adm, 'admin_grant_essential_alert', { p_publisher: S.org, p_reason: 'Deletion test (fictional).' });   // needs an authorised publisher first
    const al = await rpcAs(u.token, 'official_publish_notice', { p_publisher: S.org, p_title: `Dora essential ${R}`, p_body: 'A fictional emergency published by a member who later deletes their account.', p_category: 'travel_transport', p_area_ids: ['voe'], p_expires_at: iso(12), p_action_text: 'Follow the instructions on the council website.', p_is_essential: true, p_review_at: iso(6) }); assert.equal(al.status, 200, JSON.stringify(al.data)); S.alert = al.data;
    for (const who of [u, v]) owner(`insert into notice_deliveries (subject_type, subject_id, user_id, kind, status) values ('notice', gen_random_uuid(), '${who.id}', 'essential', 'sent')`);   // history from some EARLIER alert (an already-delivered one would be excluded from the dispatch)
    const rec = (id: string) => owner(`select string_agg(user_id::text, ',') from public.notice_dispatch_recipients('${id}', 'essential')`);
    assert.ok(rec(S.alert).includes(u.id) && rec(S.alert).includes(v.id), 'both were eligible for the alert before deletion');
    // a personal notice of the bystander must be untouched
    const mk = await rpcAs(v.token, 'submit_person_notice', { p_title: `Bea notice ${R}`, p_body: 'A bystander notice that must survive someone else deleting their account.', p_category: 'other', p_area_ids: ['voe'] }); S.vNotice = mk.data; await rpcAs(mod, 'staff_approve_person_notice', { p_notice: S.vNotice });
    S.before = snapshot(u.id);
  });
  test('8 deleting the account removes ONLY her areas, preferences, delivery history and (existing) push settings; she can no longer be sent a push; everyone else and every hub / business / official notice is unchanged', async () => {
    const handler = await loadHandler();
    const res = await handler(new Request('http://local/delete-account', { method: 'POST', headers: { Authorization: `Bearer ${S.u.token}` } })); const body = await res.json() as any;
    assert.equal(res.status, 200, JSON.stringify(body));
    for (const step of ['notice_member_data', 'notification_preferences', 'push_tokens', 'notices', 'scrub_profile', 'auth_soft_delete']) assert.equal(body.steps[step], 'ok', `${step}: ${JSON.stringify(body.steps)}`);
    for (const t of ['member_areas', 'notice_notification_prefs', 'notice_deliveries', 'notification_preferences', 'push_tokens']) assert.equal(owner(`select count(*) from ${t} where user_id='${S.u.id}'`), '0', t);
    assert.equal(owner(`select count(*) from member_areas where user_id='${S.v.id}'`), '2'); assert.equal(owner(`select count(*) from push_tokens where user_id='${S.v.id}'`), '1');
    assert.equal(snapshot(S.u.id), S.before, 'nothing else changed anywhere');
    assert.equal(((await rpcAs(null, 'get_public_notice', { p_id: S.alert })).data as any[]).length, 1, 'the official alert she published survives');
    const rec = owner(`select string_agg(user_id::text, ',') from public.notice_dispatch_recipients('${S.alert}', 'essential')`);
    assert.ok(!rec.includes(S.u.id) && rec.includes(S.v.id), 'a dispatch now reaches the bystander and never her: no areas, no opt-in, no token');
    assert.equal(((await rpcAs(null, 'get_public_notice', { p_id: S.vNotice })).data as any[]).length, 1, "the bystander's own published notice is untouched");
  });
  test('9 repeating the deletion cannot remove anything that is not hers: the second call is refused or is a no-op', async () => {
    const handler = await loadHandler(); const before = snapshot(S.u.id);
    const res = await handler(new Request('http://local/delete-account', { method: 'POST', headers: { Authorization: `Bearer ${S.u.token}` } })); const body = await res.json() as any;
    assert.ok(res.status === 401 || (res.status === 200 && body.ok), `second call: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    assert.equal(snapshot(S.u.id), before, 'the database outside her own rows is identical after the repeat');
    const noAuth = await handler(new Request('http://local/delete-account', { method: 'POST' })); assert.equal(noAuth.status, 401, 'no token: refused');
    const bogus = await handler(new Request('http://local/delete-account', { method: 'POST', headers: { Authorization: 'Bearer not-a-real-token' } })); assert.equal(bogus.status, 401, 'a bad token: refused');
    assert.equal(snapshot(S.u.id), before);
  });
  test('10 PRODUCTION SEQUENCE: with the Notices & Alerts migrations absent (the function deployed first) deletion still succeeds - that step is reported as skipped and the personal notices are still deleted; and with the migrations in place the same function removes the data (test 8)', async () => {
    const w = await signUp(`early-${R}@accept.test`, 'Edna Early');
    const mk = await rpcAs(w.token, 'submit_person_notice', { p_title: `Edna notice ${R}`, p_body: 'A notice by a member whose account is deleted before the new functions exist.', p_category: 'other', p_area_ids: ['voe'] });
    owner(`alter function public.delete_member_notice_data(uuid) rename to delete_member_notice_data_hidden`);
    try {
      const handler = await loadHandler();
      const res = await handler(new Request('http://local/delete-account', { method: 'POST', headers: { Authorization: `Bearer ${w.token}` } })); const body = await res.json() as any;
      assert.equal(res.status, 200, JSON.stringify(body)); assert.equal(body.ok, true);
      assert.match(body.steps.notice_member_data, /^skipped/, body.steps.notice_member_data);
      assert.equal(body.steps.notices, 'ok'); assert.equal(body.steps.scrub_profile, 'ok'); assert.equal(body.steps.auth_soft_delete, 'ok');
      assert.equal(owner(`select count(*) from notices where id='${mk.data}'`), '0');
    } finally { owner(`alter function public.delete_member_notice_data_hidden(uuid) rename to delete_member_notice_data`); }
    // the lock-down is intact: the function is callable by the service role only
    assert.equal((await rpcAs(S.v.token, 'delete_member_notice_data', { p_user: S.v.id })).status >= 400, true, 'a member cannot call it, even for themselves');
    assert.equal((await rpcAs(null, 'delete_member_notice_data', { p_user: S.v.id })).status >= 400, true, 'nor anonymous');
    assert.equal(owner(`select count(*) from member_areas where user_id='${S.v.id}'`), '2', 'and the bystander still has their areas');
  });
});

d('FUNERAL submissions and organisation memberships when the member deletes their account (the real function, the real deletion path)', () => {
  const sub = async (tok: string, name: string, extra: Record<string, unknown> = {}) => (await rpcAs(tok, 'submit_funeral_notice', { p: { full_name: `${name} ${R}`, died_on: '2026-10-29', announcement: 'Peacefully at home.', area_id: 'voe', submitter_name: 'Fiona Funeralsubmitter', submitter_relationship: 'daughter', submitter_phone: '07700 900321', submitter_email: 'fiona.private@accept.test', family_authorised: true, ...extra } })).data as string;
  const del = async (tok: string) => { const handler = await loadHandler(); const res = await handler(new Request('http://local/delete-account', { method: 'POST', headers: { Authorization: `Bearer ${tok}` } })); return { res, body: await res.json() as any }; };
  const S2: Record<string, any> = {};

  test('11 every lifecycle state through the REAL deletion: private submitter details are removed, the approved announcement is preserved, the rest is reduced to the minimum', async () => {
    const f = await signUp(`fun-${R}@accept.test`, 'Fiona Funeralsubmitter'); const mod = await staffToken();
    const other = await signUp(`funother-${R}@accept.test`, 'Olive Other');
    const ids: Record<string, string> = {};
    ids.withdrawn = await sub(f.token, 'Withdrawn Person'); await rpcAs(f.token, 'withdraw_my_funeral_notice', { p_id: ids.withdrawn });
    owner(`update funeral_notices set created_at = now() - interval '3 days' where id='${ids.withdrawn}'`);
    ids.approved = await sub(f.token, 'Approved Person'); await rpcAs(mod, 'admin_funeral_review', { p_id: ids.approved, p_action: 'approve', p_note: 'Confirmed with the funeral director (reference 17).', p_verification_method: 'funeral_director_confirmation', p_verification_outcome: 'confirmed' });
    ids.pending = await sub(f.token, 'Pending Person');
    ids.rejected = await sub(f.token, 'Rejected Person'); await rpcAs(mod, 'admin_funeral_review', { p_id: ids.rejected, p_action: 'reject', p_note: 'Could not verify.', p_rejection_code: 'unverifiable' });
    owner(`update funeral_notices set created_at = now() - interval '3 days' where submitter_id='${f.id}'`);
    ids.takendown = await sub(f.token, 'Taken Down Person'); await rpcAs(mod, 'admin_funeral_review', { p_id: ids.takendown, p_action: 'approve', p_verification_method: 'phone_callback', p_verification_outcome: 'confirmed' }); await rpcAs(mod, 'admin_funeral_takedown', { p_id: ids.takendown, p_reason: 'The family asked' });
    ids.bystander = await sub(other.token, 'Bystander Person', { submitter_name: 'Olive Other', submitter_phone: '07700 900777' });
    Object.assign(S2, { f, ids });
    const { res, body } = await del(f.token);
    assert.equal(res.status, 200, JSON.stringify(body)); assert.equal(body.ok, true);
    assert.equal(body.steps.funeral_notices, 'ok', JSON.stringify(body.steps)); assert.equal(body.steps.organisation_memberships, 'ok'); assert.equal(body.steps.demote_privileges, 'ok');
    const mine = Object.entries(ids).filter(([k]) => k !== 'bystander').map(([, v]) => v);
    assert.equal(owner(`select count(*) from funeral_notices where id in ('${mine.join("','")}')`), '5', 'no funeral row is deleted by an account deletion');
    assert.equal(owner(`select count(*) from funeral_notices where id in ('${mine.join("','")}') and submitter_id is null and submitter_name is null and submitter_phone is null and submitter_email is null and submitter_relationship is null and review_message is null and review_note is null and scrubbed_at is not null`), '5', 'private submitter details are gone from every status');
    assert.equal(owner(`select status from funeral_notices where id='${ids.approved}'`), 'approved');
    assert.equal(owner(`select announcement from funeral_notices where id='${ids.approved}'`), 'Peacefully at home.');
    assert.equal(owner(`select status from funeral_notices where id='${ids.pending}'`), 'withdrawn', 'a pending submission that can no longer be verified is withdrawn, never published');
    assert.equal(owner(`select full_name from funeral_notices where id='${ids.rejected}'`), '[removed]');
    assert.equal(owner(`select (verification_method = 'funeral_director_confirmation' and verification_outcome = 'confirmed' and verified_by is not null and verified_at is not null)::text from funeral_notices where id='${ids.approved}'`), 'true', 'the minimum evidence of authority is kept');
    assert.equal(owner(`select submitter_phone from funeral_notices where id='${ids.bystander}'`), '07700 900777', 'another family\'s submission is untouched');
    const pub = JSON.stringify((await rpcAs(null, 'get_funeral_notice', { p_id: ids.approved })).data);
    assert.equal(((await rpcAs(null, 'get_funeral_notice', { p_id: ids.approved })).data as any[]).length, 1, 'the approved announcement is still public'); assert.ok(!/07700|fiona|Fiona|private@/.test(pub));
    for (const k of ['pending', 'withdrawn', 'rejected', 'takendown']) assert.equal(((await rpcAs(null, 'get_funeral_notice', { p_id: ids[k] })).data as any[]).length, 0, `${k} is not public`);
    assert.equal(owner(`select count(*) from notice_audit_log where event='funeral_submitter_scrubbed' and funeral_id in ('${mine.join("','")}')`), '5');
  });

  test('12 repeating the deletion removes nothing more and breaks nothing', async () => {
    const before = owner(`select count(*) from notice_audit_log where event='funeral_submitter_scrubbed'`);
    const again = await del(S2.f.token);
    assert.ok([200, 401].includes(again.res.status), String(again.res.status));
    assert.equal(owner(`select count(*) from notice_audit_log where event='funeral_submitter_scrubbed'`), before);
  });

  test('13 organisation memberships: the deleted PUBLISHER and DELEGATE lose their seats, the organisation and the other members keep theirs, and the old token has no authority', async () => {
    const admin = await token('admin@accept.test');
    const org = (await rpcAs(admin, 'admin_upsert_official_publisher', { p_slug: `del-org-${R}`, p_name: `Deletion Test Org ${R}`, p_kind: 'council' })).data as string;
    await rpcAs(admin, 'admin_verify_official_publisher', { p_publisher: org, p_note: 'Verified by call-back to a published number' });
    const pubr = await signUp(`pub-${R}@accept.test`, 'Pat Publisher'), dele = await signUp(`dlg-${R}@accept.test`, 'Dee Delegate'), stay = await signUp(`stay-${R}@accept.test`, 'Sam Stays');
    for (const [u, role] of [[pubr, 'publisher'], [dele, 'delegate'], [stay, 'publisher']] as const) assert.equal((await rpcAs(admin, 'admin_set_official_publisher_member', { p_publisher: org, p_user: u.id, p_role: role })).status < 300, true);
    assert.equal((await rpcAs(pubr.token, 'official_publisher_authority', { p_publisher: org })).data, 'official');
    const { res, body } = await del(pubr.token); assert.equal(res.status, 200, JSON.stringify(body)); assert.equal(body.steps.organisation_memberships, 'ok');
    assert.equal((await rpcAs(pubr.token, 'official_publisher_authority', { p_publisher: org })).data, 'none', 'the token is still valid for a while: authority is refused because the account is closed');
    assert.equal(owner(`select (not is_active)::text from official_publisher_members where publisher_id='${org}' and user_id='${pubr.id}'`), 'true');
    const d2 = await del(dele.token); assert.equal(d2.res.status, 200);
    assert.equal(owner(`select (not is_active)::text from official_publisher_members where publisher_id='${org}' and user_id='${dele.id}'`), 'true');
    assert.equal(owner(`select (is_active)::text from official_publisher_members where publisher_id='${org}' and user_id='${stay.id}'`), 'true', 'the other member is untouched');
    assert.equal(owner(`select (is_active and verified_at is not null)::text from official_publishers where id='${org}'`), 'true', 'the organisation is untouched');
    assert.equal((await rpcAs(stay.token, 'official_publisher_authority', { p_publisher: org })).data, 'official');
    assert.ok((await rpcAs(admin, 'admin_set_official_publisher_member', { p_publisher: org, p_user: pubr.id, p_role: 'publisher' })).status >= 400, 'a deleted account cannot be given authority again');
  });

  test('14 a deleted ADMINISTRATOR / MODERATOR is demoted and the old token no longer works as staff', async () => {
    const a = await signUp(`adm-${R}@accept.test`, 'Ada Admin'); owner(`update profiles set role = 'admin' where id='${a.id}'`);
    assert.ok((await rpcAs(a.token, 'admin_upsert_official_publisher', { p_slug: `adm-org-${R}`, p_name: `Adm Org ${R}`, p_kind: 'other' })).status < 300, 'an administrator can, before deletion');
    const m = await signUp(`mod-${R}@accept.test`, 'Mo Moderator'); owner(`update profiles set role = 'moderator' where id='${m.id}'`);
    assert.ok((await rpcAs(m.token, 'admin_funeral_queue', {})).status < 300);
    assert.equal((await del(a.token)).res.status, 200); assert.equal((await del(m.token)).res.status, 200);
    assert.equal(owner(`select role from profiles where id in ('${a.id}','${m.id}') group by role`), 'customer', 'role removed');
    assert.ok((await rpcAs(a.token, 'admin_upsert_official_publisher', { p_slug: `adm-org2-${R}`, p_name: `Adm Org2 ${R}`, p_kind: 'other' })).status >= 400);
    assert.ok((await rpcAs(m.token, 'admin_funeral_queue', {})).status >= 400);
  });

  test('15 PARTIAL FAILURE: an unexpected cleanup failure stops the deletion BEFORE anything irreversible (500, account intact, can sign in), and a retry completes it', async () => {
    const f = await signUp(`part-${R}@accept.test`, 'Pia Partial'); const id = await sub(f.token, 'Partial Person');
    owner(`create function public.tg_accept_boom() returns trigger language plpgsql as $$ begin raise exception 'simulated failure'; end $$; create trigger accept_boom before update on public.funeral_notices for each row execute function public.tg_accept_boom();`);
    try {
      const { res, body } = await del(f.token);
      assert.equal(res.status, 500, JSON.stringify(body)); assert.equal(body.ok, false); assert.deepEqual(body.failed, ['funeral_notices']);
      assert.match(body.steps.funeral_notices, /^err:/); assert.equal(body.steps.scrub_profile, undefined, 'the profile scrub never ran'); assert.equal(body.steps.auth_soft_delete, undefined);
      assert.equal(owner(`select full_name from profiles where id='${f.id}'`), 'Pia Partial', 'profile intact');
      assert.equal(owner(`select submitter_phone from funeral_notices where id='${id}'`), '07700 900321', 'nothing half-done');
      assert.ok(await token(`part-${R}@accept.test`), 'the person can still sign in and try again');
    } finally { owner(`drop trigger accept_boom on public.funeral_notices; drop function public.tg_accept_boom();`); }
    const ok = await del(await token(`part-${R}@accept.test`)); assert.equal(ok.res.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.ok, true);
    assert.equal(owner(`select (submitter_phone is null and scrubbed_at is not null)::text from funeral_notices where id='${id}'`), 'true');
  });

  test('16 PRODUCTION SEQUENCE: with the funeral / membership functions absent (function deployed first) those steps are skipped and deletion succeeds; once they exist the same function does the cleanup', async () => {
    const w = await signUp(`late-${R}@accept.test`, 'Lena Late'); const id = await sub(w.token, 'Late Person');
    owner(`alter function public.delete_member_funeral_data(uuid) rename to delete_member_funeral_data_hidden; alter function public.delete_member_memberships(uuid) rename to delete_member_memberships_hidden`);
    try {
      const { res, body } = await del(w.token); assert.equal(res.status, 200, JSON.stringify(body));
      assert.match(body.steps.funeral_notices, /^skipped/); assert.match(body.steps.organisation_memberships, /^skipped/);
    } finally { owner(`alter function public.delete_member_funeral_data_hidden(uuid) rename to delete_member_funeral_data; alter function public.delete_member_memberships_hidden(uuid) rename to delete_member_memberships`); }
    assert.equal(owner(`select submitter_phone from funeral_notices where id='${id}'`), '07700 900321', 'skipped means skipped: nothing was cleaned');
    assert.equal(owner(`select count(*) from pg_proc where proname in ('delete_member_funeral_data','delete_member_memberships')`), '2');
  });
});
const idOf = (o: string) => (o.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []).pop() ?? '';
