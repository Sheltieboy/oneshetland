/**
 * accept-funeral-enquiry-protection.node.test.ts — the anonymous funeral enquiry endpoint, attacked and used, end to end on the ISOLATED acceptance backend.
 *
 * What runs: the REAL handler (supabase/functions/_shared/funeral-enquiry.ts) in Node. Cloudflare is the local MOCK (_mock-turnstile.ts, which refuses every
 * non-loopback host), Supabase is the local acceptance stack, the clients are fictional. Nothing contacts Cloudflare, production or a real person.
 *   ACCEPT_RUN=1 node --test supabase/tests/api/accept-funeral-enquiry-protection.node.test.ts      (after accept-env.sh start + accept-seed.mjs)
 */
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { rpc, owner, URL_, ANON } from './_accept-client.ts';
import { handleLocal, localDeps } from './accept-functions.ts';
import { handleFuneralEnquiry, normaliseIp, clientIp, ENQUIRY_ACTION } from '../../functions/_shared/funeral-enquiry.ts';
import { resetMock, state, token, makeFetch } from './_mock-turnstile.ts';

const RUN = process.env.ACCEPT_RUN === '1';
const ORIGIN = 'http://localhost:3011';
const R = Date.now().toString(36);
let ipSeq = 0;
/** each caller gets a fresh documentation-range IPv6 /64 (2001:db8::/32 is reserved: it is not a real address) */
const newIp = () => `2001:db8:${(Math.floor(Math.random() * 0xffff)).toString(16)}:${(++ipSeq).toString(16)}::${(Math.floor(Math.random() * 0xfff) + 1).toString(16)}`;
const body = (id: string, over: Record<string, unknown> = {}) => ({ announcement_id: id, kind: 'correction', message: 'The service venue is wrong, please check with the funeral director.', contact: `family${Math.random().toString(36).slice(2, 8)}@accept.test`, contact_name: 'R Fictional', relationship: 'Cousin', turnstile_token: token('valid', ENQUIRY_ACTION, id), ...over });
const mk = (b: unknown, ip: string | null, o: { origin?: string | null; headers?: Record<string, string>; raw?: string } = {}) => {
  const h: Record<string, string> = { 'content-type': 'application/json', ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }), ...(ip ? { 'cf-connecting-ip': ip } : {}), ...o.headers };
  return new Request('http://local/functions/v1/submit-funeral-enquiry', { method: 'POST', headers: h, body: o.raw ?? JSON.stringify(b) });
};
const send = async (id: string, ip: string, over: Record<string, unknown> = {}, o: Parameters<typeof mk>[2] = {}, env: Record<string, string | undefined> = {}) => {
  const res = await handleLocal(mk(body(id, over), ip, o), env); return { status: res.status, json: await res.json().catch(() => null) as any, headers: res.headers };
};
const rows = (id: string) => Number(owner(`select count(*) from funeral_change_requests where funeral_id='${id}' and source='public'`));
const notice = (id: string) => owner(`select md5(to_jsonb(f)::text) from funeral_notices f where id='${id}'`);

const announcement = async (name: string): Promise<string> => {
  owner(`update funeral_notices set created_at = created_at - interval '3 days' where submitter_id = (select id from profiles where display_name ilike 'Morag Member' limit 1)`);
  const s = await rpc('member', 'submit_funeral_notice', { p: { full_name: `${name} ${R}`, died_on: '2026-10-28', announcement: 'Peacefully at home. A fictional announcement.', area_id: 'voe', service_public: true, service_kind: 'funeral', service_venue: 'Fictional Kirk', submitter_name: 'Kit Fictional', submitter_phone: '07700 900123', family_authorised: true } });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const a = await rpc('moderator', 'admin_funeral_review', { p_id: s.data as string, p_action: 'approve', p_verification_method: 'funeral_director_confirmation', p_verification_outcome: 'confirmed' });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  return s.data as string;
};

const d = RUN ? describe : describe.skip;
d('submit-funeral-enquiry: server-side verification, bypass closed, per-client limits (isolated backend, mocked Cloudflare)', () => {
  let A = '', B = '', C = '';
  before(async () => {
    assert.match(URL_, /^http:\/\/127\.0\.0\.1:/, 'the backend must be the local acceptance stack');
    resetMock(); owner(`delete from rate_limits`);
    A = await announcement('Alpha Person'); B = await announcement('Beta Person'); C = await announcement('Gamma Person');
  });

  describe('a genuine family', () => {
    test('1 a valid enquiry is verified by (mock) Cloudflare with our secret, bound to this announcement, and filed for staff; nothing public changes', async () => {
      const before = notice(A), ip = newIp(); resetMock();
      const r = await send(A, ip, { message: 'Please remove this announcement, we are the family.', kind: 'takedown' });
      assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: true });
      assert.equal(state.calls.length, 1); assert.equal(state.calls[0].secret, 'mock-secret-key'); assert.ok(state.calls[0].response.startsWith('mock.valid.funeral-enquiry'));
      assert.equal(owner(`select (source='public' and status='open' and kind='takedown' and requester_id is null)::text from funeral_change_requests where funeral_id='${A}' order by created_at desc limit 1`), 'true');
      assert.equal(notice(A), before, 'submitting never modifies the public announcement');
      assert.equal(owner(`select status from funeral_notices where id='${A}'`), 'approved');
      assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN); assert.equal(r.headers.get('cache-control'), 'no-store');
    });
    test('2 other optional fields may be empty; name and relationship are stored; the response never echoes what was sent', async () => {
      const r = await send(B, newIp(), { contact_name: '', relationship: undefined, message: 'A question about the service time.', kind: 'enquiry', contact: `quiet.person.${R}${Math.random().toString(36).slice(2, 6)}@accept.test` });
      assert.equal(r.status, 200); assert.ok(!JSON.stringify(r.json).includes('quiet.person'));
    });
  });

  describe('server-side token verification', () => {
    test('3 missing token → refused, nothing filed, Cloudflare not called', async () => {
      resetMock(); const n = rows(A);
      for (const t of [undefined, '', '   ', null]) { const r = await send(A, newIp(), { turnstile_token: t }); assert.equal(r.status, 400); assert.equal(r.json.error, 'verification_required'); }
      assert.equal(rows(A), n); assert.equal(state.calls.filter((c) => !c.response).length, 0);
    });
    test('4 invalid token → refused (verification_failed)', async () => {
      const n = rows(A); const r = await send(A, newIp(), { turnstile_token: 'mock.invalid.funeral-enquiry.x.1' }); assert.deepEqual([r.status, r.json.error], [400, 'verification_failed']);
      const g = await send(A, newIp(), { turnstile_token: 'garbage-not-from-cloudflare' }); assert.deepEqual([g.status, g.json.error], [400, 'verification_failed']);
      assert.equal((await send(A, newIp(), { turnstile_token: 'x'.repeat(3000) })).json.error, 'verification_failed'); assert.equal(rows(A), n);
    });
    test('5 expired token → refused (verification_expired); an old challenge replayed as "success" is also refused', async () => {
      const n = rows(A);
      assert.equal((await send(A, newIp(), { turnstile_token: token('expired', ENQUIRY_ACTION, A) })).json.error, 'verification_expired');
      assert.equal((await send(A, newIp(), { turnstile_token: token('stale', ENQUIRY_ACTION, A) })).json.error, 'verification_expired');
      assert.equal(rows(A), n);
    });
    test('6 a token can be used ONCE: the second use is refused even with a valid-looking form', async () => {
      const tk = token('valid', ENQUIRY_ACTION, C), ip = newIp();
      assert.equal((await send(C, ip, { turnstile_token: tk })).status, 200);
      const again = await send(C, newIp(), { turnstile_token: tk }); assert.deepEqual([again.status, again.json.error], [400, 'verification_expired']);
      assert.equal(rows(C), 1);
    });
    test('7 a token for another site, another form or another announcement is refused', async () => {
      const n = rows(A);
      assert.equal((await send(A, newIp(), { turnstile_token: token('valid', ENQUIRY_ACTION, A, '.host=evil.example') })).json.error, 'verification_failed');
      assert.equal((await send(A, newIp(), { turnstile_token: token('valid', 'sign-in', A) })).json.error, 'verification_failed');
      assert.equal((await send(A, newIp(), { turnstile_token: token('valid', ENQUIRY_ACTION, B) })).json.error, 'verification_failed');
      assert.equal(rows(A), n);
    });
    test('8 FAIL CLOSED: Cloudflare unreachable, erroring or answering nonsense → 503, nothing filed, a clear "try again" message', async () => {
      const n = rows(A);
      for (const mode of ['throw', 'http500', 'badjson'] as const) {
        state.outage = mode; const r = await send(A, newIp()); state.outage = null;
        assert.deepEqual([r.status, r.json.error], [503, 'verification_unavailable'], mode); assert.match(r.json.message, /not been sent/);
      }
      assert.equal(rows(A), n);
      const bad = await handleFuneralEnquiry(mk(body(A), newIp()), { ...localDeps(), env: (k) => (k === 'TURNSTILE_SECRET_KEY' ? 'the-wrong-secret' : localDeps().env(k)) });
      assert.equal(bad.status, 503, 'a wrong secret is our fault, never a pass'); assert.equal(rows(A), n);
    });
    test('9 FAIL CLOSED: any missing configuration (secret, hostnames, origins, salt) refuses everything', async () => {
      const n = rows(A);
      for (const k of ['TURNSTILE_SECRET_KEY', 'TURNSTILE_ALLOWED_HOSTNAMES', 'FUNERAL_ENQUIRY_ALLOWED_ORIGINS', 'FUNERAL_ENQUIRY_IP_SALT', 'SUPABASE_SERVICE_ROLE_KEY']) {
        const r = await send(A, newIp(), {}, {}, { [k]: undefined }); assert.equal(r.status, 503, k);
      }
      assert.equal(rows(A), n);
    });
    test('10 the limiter being unreachable also fails closed', async () => {
      const n = rows(A); const f = makeFetch();
      const res = await handleFuneralEnquiry(mk(body(A), newIp()), { env: localDeps().env, fetch: (async (u: any, i: any) => String(u).includes('claim_rate_limits') ? new Response('boom', { status: 500 }) : f(u, i)) as typeof fetch });
      assert.equal(res.status, 503); assert.equal(rows(A), n);
    });
  });

  describe('origin, input and bot checks happen before any expensive work', () => {
    test('11 a disallowed or missing Origin is refused; other methods are refused; preflight answers only for our origins', async () => {
      resetMock(); const n = rows(A);
      assert.equal((await send(A, newIp(), {}, { origin: 'https://evil.example' })).status, 403);
      assert.equal((await send(A, newIp(), {}, { origin: null })).status, 403);
      const get = await handleLocal(new Request('http://local/x', { method: 'GET', headers: { origin: ORIGIN } })); assert.equal(get.status, 405);
      const ok = await handleLocal(new Request('http://local/x', { method: 'OPTIONS', headers: { origin: ORIGIN } })); assert.equal(ok.status, 204);
      const no = await handleLocal(new Request('http://local/x', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })); assert.equal(no.status, 403);
      assert.equal(rows(A), n); assert.equal(state.calls.length, 0);
    });
    test('12 malformed or oversized input is refused before Cloudflare is contacted', async () => {
      resetMock(); const ip = newIp();
      for (const over of [{ announcement_id: 'not-a-uuid' }, { kind: 'delete' }, { message: 'no' }, { message: 'x'.repeat(1001) }, { contact: '' }, { contact: 'abc' }, { contact_name: 'n'.repeat(121) }]) {
        const r = await send(A, ip, over); assert.deepEqual([r.status, r.json.error], [400, 'invalid_input'], JSON.stringify(over).slice(0, 40));
      }
      assert.equal((await handleLocal(mk(null, ip, { raw: '{not json' }))).status, 400);
      assert.equal((await handleLocal(mk(null, ip, { raw: JSON.stringify({ message: 'x'.repeat(9000) }) }))).status, 413);
      assert.equal(state.calls.length, 0, 'no Cloudflare call for invalid input');
    });
    test('13 the hidden honeypot field gets a quiet "success" and nothing is verified, filed or counted', async () => {
      resetMock(); const n = rows(A); const r = await send(A, newIp(), { website: 'http://spam.example' });
      assert.deepEqual([r.status, r.json], [200, { ok: true }]); assert.equal(rows(A), n); assert.equal(state.calls.length, 0);
    });
    test('14 an announcement that is unknown or not published gets the same answer (no probing); the security check still had to pass first', async () => {
      const ghost = '00000000-0000-4000-8000-00000000dead';
      const r = await send(ghost, newIp()); assert.deepEqual([r.status, r.json.error], [404, 'unknown_notice']);
      const hidden = owner(`select id from funeral_notices where status <> 'approved' limit 1`);
      if (hidden) assert.equal((await send(hidden, newIp())).json.error, 'unknown_notice');
    });
  });

  describe('the PostgREST bypass is closed', () => {
    test('15 nobody can call submit_funeral_enquiry directly: anonymous, signed-in member, moderator, administrator', async () => {
      const n = rows(A);
      for (const who of [null, 'member', 'moderator', 'admin']) {
        const r = await rpc(who, 'submit_funeral_enquiry', { p_id: A, p_kind: 'takedown', p_message: 'A direct call bypassing the checks', p_contact: 'attacker@accept.test' });
        assert.ok(r.status >= 400, `${who}: ${r.status}`); assert.equal(r.error?.code, '42501', `${who} must get permission denied`);
      }
      assert.equal(rows(A), n); assert.equal(owner(`select count(*) from funeral_change_requests where contact='attacker@accept.test'`), '0');
      assert.equal(owner(`select has_function_privilege('anon','public.submit_funeral_enquiry(uuid,text,text,text,text,text)','execute')::text`), 'false');
      assert.equal(owner(`select has_function_privilege('authenticated','public.submit_funeral_enquiry(uuid,text,text,text,text,text)','execute')::text`), 'false');
      assert.equal(owner(`select has_function_privilege('service_role','public.submit_funeral_enquiry(uuid,text,text,text,text,text)','execute')::text`), 'true', 'the legitimate server-side mechanism still works');
    });
    test('16 nobody can read or reset the limiter either', async () => {
      for (const who of [null, 'member']) { const r = await rpc(who, 'claim_rate_limits', { p_subject: 'ip:x', p_actions: ['funeral_enquiry_ip_day'] }); assert.ok(r.status >= 400); }
    });
  });

  describe('per-client limits: an abuser is stopped by their OWN allowance; other families are unaffected', () => {
    test('17 one client: at most 3 verified enquiries per announcement per day; the 4th is refused with Retry-After and files nothing', async () => {
      const ip = newIp(), id = await announcement('Delta Person'); const n = rows(id);
      for (let i = 0; i < 3; i++) assert.equal((await send(id, ip)).status, 200, `request ${i + 1}`);
      const r = await send(id, ip); assert.deepEqual([r.status, r.json.error], [429, 'rate_limited']); assert.ok(Number(r.headers.get('retry-after')) >= 1);
      assert.equal(rows(id), n + 3);
    });
    test('18 THE ATTACK THAT USED TO WORK: a script spamming one announcement with rotating fake contacts cannot lock a genuine family out of it', async () => {
      const id = await announcement('Echo Person'), attacker = newIp();
      let accepted = 0; for (let i = 0; i < 40; i++) { const r = await send(id, attacker, { contact: `bot${i}-${R}${Math.random().toString(36).slice(2, 6)}@spam.test`, message: `Spam spam spam ${i}` }); if (r.status === 200) accepted++; }
      assert.equal(accepted, 3, 'the attacker gets exactly its own per-announcement allowance (3), however many contacts it invents');
      const family = await send(id, newIp(), { contact: `real.family.${Math.random().toString(36).slice(2, 8)}@accept.test`, message: 'We are the family and would like this corrected.' });
      assert.equal(family.status, 200, 'a genuine family is still served'); assert.equal(rows(id), 4);
    });
    test('19 THE SITE-WIDE ATTACK: one client hammering many announcements is capped by its own hourly allowance (6) and never reaches the shared quotas; every other family still gets through', async () => {
      const ids: string[] = []; for (let i = 0; i < 4; i++) ids.push(await announcement(`Spread ${i}`));
      const attacker = newIp(); let accepted = 0, limited = 0;
      for (let i = 0; i < 40; i++) { const r = await send(ids[i % 4], attacker, { contact: `bot${i}-${R}${Math.random().toString(36).slice(2, 6)}@spam.test`, message: `Spam spam spam ${i}` }); if (r.status === 200) accepted++; else if (r.status === 429) limited++; }
      assert.equal(accepted, 6, 'ip_hour = 6'); assert.ok(limited >= 34);
      const shared = owner(`select coalesce(sum(count),0) from rate_limits where subject = 'global' and action='funeral_enquiry_global'`);
      for (const id of ids) assert.equal((await send(id, newIp(), { message: 'Genuine family request for this announcement.' })).status, 200, 'unrelated families get through');
      assert.ok(Number(shared) < 300, 'the shared circuit-breaker is nowhere near tripped by one client');
    });
    test('20 separate clients each have their own allowance, including two visitors behind different addresses writing about the SAME announcement', async () => {
      const id = await announcement('Foxtrot Person'), a = newIp(), b = newIp();
      for (let i = 0; i < 3; i++) assert.equal((await send(id, a)).status, 200);
      assert.equal((await send(id, a)).status, 429);
      for (let i = 0; i < 3; i++) assert.equal((await send(id, b)).status, 200, 'client B is not charged for client A');
    });
    test('21 cheap attempt cap: a client sending endless garbage is cut off quickly and stops costing Cloudflare calls', async () => {
      resetMock(); const ip = newIp(); let tooMany = 0, calls0 = 0;
      for (let i = 0; i < 30; i++) { const r = await send(A, ip, { turnstile_token: `mock.invalid.funeral-enquiry.${i}.z` }); if (r.status === 429) tooMany++; else calls0++; }
      assert.equal(calls0, 20, 'attempt cap is 20 per 10 minutes'); assert.equal(tooMany, 10); assert.equal(state.calls.length, 20, 'refused attempts never reach Cloudflare');
    });
    test('22 an IPv6 visitor is keyed by its /64: rotating the low bits does not give a new allowance; another network does', async () => {
      const id = await announcement('Golf Person'), p = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:abcd`;
      for (let i = 0; i < 3; i++) assert.equal((await send(id, `${p}::${i + 1}`)).status, 200);
      assert.equal((await send(id, `${p}:0:0:0:ffff`)).status, 429);
      assert.equal((await send(id, newIp())).status, 200);
      assert.equal(normaliseIp('::ffff:192.0.2.5'), '192.0.2.5'); assert.equal(normaliseIp('2001:db8::1')?.endsWith('::/64'), true); assert.equal(normaliseIp('not-an-ip'), null);
    });
    test('23 the client address comes from the trusted header; a spoofed x-forwarded-for first entry is ignored and no address means refusal', async () => {
      const real = '203.0.113.9'; const req = new Request('http://x', { headers: { 'x-forwarded-for': `198.51.100.1, ${real}` } });
      assert.equal(clientIp(req), real, 'last entry (added by the nearest proxy), never the first');
      assert.equal(clientIp(new Request('http://x', { headers: { 'cf-connecting-ip': '192.0.2.77', 'x-forwarded-for': '1.1.1.1' } })), '192.0.2.77');
      const none = await handleLocal(mk(body(A), null)); assert.deepEqual([none.status, (await none.json()).error], [400, 'verification_failed']);
    });
    test('24 the shared per-announcement and site-wide circuit breakers still work (tested with lowered local ceilings), and the DB backstop catches the same contact', async () => {
      const id = await announcement('Hotel Person');
      try {
        owner(`update rate_limit_policies set max_count = 2 where action = 'funeral_enquiry_announcement'`);
        assert.equal((await send(id, newIp())).status, 200); assert.equal((await send(id, newIp())).status, 200);
        const r = await send(id, newIp()); assert.deepEqual([r.status, r.json.error], [429, 'rate_limited'], 'shared per-announcement ceiling');
      } finally { owner(`update rate_limit_policies set max_count = 15 where action = 'funeral_enquiry_announcement'`); }
      const id2 = await announcement('India Person');
      try {
        owner(`delete from rate_limits where subject='global'; update rate_limit_policies set max_count = 1 where action = 'funeral_enquiry_global'`);
        assert.equal((await send(id2, newIp())).status, 200); assert.equal((await send(id2, newIp())).status, 429, 'site-wide breaker');
      } finally { owner(`update rate_limit_policies set max_count = 300 where action = 'funeral_enquiry_global'; delete from rate_limits where subject='global'`); }
      const id3 = await announcement('Juliet Person'); const same = `same.person.${R}${Math.random().toString(36).slice(2, 6)}@accept.test`;
      for (let i = 0; i < 3; i++) assert.equal((await send(id3, newIp(), { contact: same })).status, 200);
      const four = await send(id3, newIp(), { contact: same }); assert.equal(four.status, 429, 'database backstop: one contact, 3 a day');
    });
  });

  describe('privacy boundaries', () => {
    test('25 the limiter stores only keyed hashes and counters: no address, contact, message or announcement text', async () => {
      const subjects = owner(`select string_agg(distinct subject, '|') from rate_limits where action like 'funeral_enquiry%'`);
      assert.ok(subjects.length > 0); assert.ok(!/2001:db8|127\.0\.0\.1|203\.0\.113|@|spam|family/i.test(subjects), subjects.slice(0, 200));
      for (const s of subjects.split('|')) assert.match(s, /^(ip:[0-9a-f]{32}|ipa:[0-9a-f]{32}:[0-9a-f-]{36}|ann:[0-9a-f-]{36}|global)$/);
      assert.equal(owner(`select count(*) from information_schema.columns where table_name='rate_limits' and column_name ~* 'ip|address|contact|message'`), '0');
    });
    test('26 logs name outcomes only: no token, contact, message, address or secret ever appears in a log line', async () => {
      const seen: string[] = []; const orig = console.warn; console.warn = (...a: unknown[]) => { seen.push(a.map(String).join(' ')); };
      try {
        const ip = newIp(), secretish = 'very.private.contact@accept.test', msg = 'A very private message about the family.';
        await send(A, ip, { contact: secretish, message: msg, turnstile_token: 'mock.invalid.funeral-enquiry.x.leak' });
        await send(A, ip, { contact: secretish, message: msg, turnstile_token: token('expired', ENQUIRY_ACTION, A) }); state.outage = 'throw'; await send(A, ip, { contact: secretish, message: msg }); state.outage = null;
        await send(A, ip, {}, { origin: 'https://evil.example' });
      } finally { console.warn = orig; }
      const all = seen.join('\n'); assert.ok(seen.length >= 3); assert.ok(!/mock\.|private|contact|2001:db8|mock-secret|accept\.test/i.test(all), all.slice(0, 300));
    });
    test('27 anonymous visitors still cannot read the enquiries, the public notice has no private field, and error bodies carry only a code and a safe message', async () => {
      for (const t of ['funeral_change_requests', 'rate_limits', 'rate_limit_policies']) { const r = await fetch(`${URL_}/rest/v1/${t}?select=*`, { headers: { apikey: ANON } }); assert.ok(r.status >= 400, t); }
      const pubRow = await fetch(`${URL_}/rest/v1/rpc/get_funeral_notice`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json' }, body: JSON.stringify({ p_id: A }) });
      assert.ok(!/family\w*@accept\.test|07700|Kit Fictional/.test(await pubRow.text()));
      const r = await send(A, newIp(), { turnstile_token: 'nope' }); assert.deepEqual(Object.keys(r.json).sort(), ['error', 'message', 'ok']);
    });
  });

  describe('staff review, verification of authority and takedown are unchanged', () => {
    test('28 a request that came through the endpoint appears for staff, cannot be actioned without recording how authority was verified, and clears the contact when resolved', async () => {
      const id = await announcement('Kilo Person'); const before = notice(id);
      const f = await send(id, newIp(), { kind: 'takedown', message: 'The family would like this removed please.', contact: 'real.family@accept.test', contact_name: 'Una Fictional', relationship: 'Daughter' });
      assert.equal(f.status, 200); assert.equal(notice(id), before, 'filing changes nothing');
      const queue = await rpc('moderator', 'admin_funeral_change_requests', {}); assert.equal(queue.status, 200);
      const mine = (queue.data as any[]).find((q) => q.funeral_id === id); assert.ok(mine, 'visible in the staff queue'); assert.equal(mine.source, 'public'); assert.equal(mine.contact, 'real.family@accept.test');
      for (const who of [null, 'member']) assert.ok((await rpc(who, 'admin_funeral_change_requests', {})).status >= 400, `${who} cannot read the queue`);
      const refused = await rpc('moderator', 'admin_funeral_resolve_change', { p_request: mine.id, p_outcome: 'actioned', p_note: 'Removing' });
      assert.match(JSON.stringify(refused.data), /Verify the requester independently/); assert.equal(owner(`select status from funeral_notices where id='${id}'`), 'approved');
      const ok = await rpc('moderator', 'admin_funeral_resolve_change', { p_request: mine.id, p_outcome: 'actioned', p_note: 'Confirmed by the funeral director', p_authority_check: 'funeral_director_confirmation' });
      assert.ok(ok.status < 300, JSON.stringify(ok.data));
      assert.equal(owner(`select status from funeral_notices where id='${id}'`), 'taken_down');
      assert.equal(owner(`select (contact is null and contact_name is null and authority_check='funeral_director_confirmation')::text from funeral_change_requests where id='${mine.id}'`), 'true', 'contact data removed on resolution');
      assert.match(owner(`select details::text from notice_audit_log where event='funeral_change_resolved' and details->>'request'='${mine.id}'`), /funeral_director_confirmation/);
    });
  });
});
