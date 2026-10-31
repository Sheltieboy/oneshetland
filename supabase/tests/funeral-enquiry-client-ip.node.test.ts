/**
 * funeral-enquiry-client-ip.node.test.ts — which client identity the funeral enquiry limiter uses, and what happens when the address header is forged, missing
 * or malformed. PURE and OFFLINE: the handler runs with an injected fake fetch that records every call; nothing touches a network, Supabase or Cloudflare.
 *
 * It proves the CODE's behaviour for every header it can be handed. It does NOT prove what the hosted Supabase edge puts in those headers: that needs a
 * deployment and is a recorded release check (docs/notices-funeral-enquiry-protection.md, "Release verification").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp, normaliseIp, handleFuneralEnquiry, ENQUIRY_ACTION } from '../functions/_shared/funeral-enquiry.ts';

const ID = '11111111-2222-4333-8444-555555555555';
const ENV: Record<string, string> = { TURNSTILE_SECRET_KEY: 's', TURNSTILE_ALLOWED_HOSTNAMES: 'localhost', FUNERAL_ENQUIRY_ALLOWED_ORIGINS: 'http://localhost:3011', FUNERAL_ENQUIRY_IP_SALT: 'salt-for-tests-0123456789', SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const body = { announcement_id: ID, kind: 'enquiry', message: 'A genuine question here', contact: 'someone@accept.test', turnstile_token: `t-${ENQUIRY_ACTION}` };
const req = (headers: Record<string, string>) => new Request('http://x/f', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3011', ...headers }, body: JSON.stringify(body) });

/** a fake network: records calls; the limiter always allows; Cloudflare always says "invalid" so the handler stops right after the first limiter claim */
function net(opts: { forbid?: boolean } = {}) {
  const calls: { url: string; body: any }[] = [];
  const fetch = (async (u: any, i: any) => {
    if (opts.forbid) throw new Error('network must not be touched');
    const url = String(u); const b = i?.body ? JSON.parse(i.body) : null; calls.push({ url, body: b });
    if (url.includes('claim_rate_limits')) return new Response(JSON.stringify([{ allowed: true, retry_after_secs: 0 }]), { status: 200 });
    return new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { calls, deps: { env: (k: string) => ENV[k], fetch } };
}
const subjectFor = async (headers: Record<string, string>) => { const n = net(); const r = await handleFuneralEnquiry(req(headers), n.deps); return { r, subject: n.calls.find((c) => c.url.includes('claim_rate_limits'))?.body?.p_subject as string | undefined, n }; };

test('1 only cf-connecting-ip is read: x-forwarded-for is never used, first entry or last, alone or beside it', () => {
  assert.equal(clientIp(new Request('http://x', { headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.9' } })), null);
  assert.equal(clientIp(new Request('http://x', { headers: { 'x-forwarded-for': '203.0.113.9' } })), null);
  assert.equal(clientIp(new Request('http://x', { headers: { 'x-real-ip': '203.0.113.9', 'x-client-ip': '203.0.113.9', forwarded: 'for=203.0.113.9', 'true-client-ip': '203.0.113.9' } })), null, 'no other header is trusted either');
  assert.equal(clientIp(new Request('http://x', { headers: { 'cf-connecting-ip': ' 192.0.2.77 ', 'x-forwarded-for': '1.1.1.1' } })), '192.0.2.77');
});

test('2 a forged x-forwarded-for cannot change the visitor identity: same cf-connecting-ip → same limiter subject whatever x-forwarded-for says', async () => {
  const a = await subjectFor({ 'cf-connecting-ip': '192.0.2.10', 'x-forwarded-for': 'spoofed' });
  const b = await subjectFor({ 'cf-connecting-ip': '192.0.2.10', 'x-forwarded-for': '203.0.113.1, 203.0.113.2, 203.0.113.3' });
  const c = await subjectFor({ 'cf-connecting-ip': '192.0.2.10' });
  assert.match(a.subject!, /^ip:[0-9a-f]{32}$/); assert.equal(a.subject, b.subject); assert.equal(a.subject, c.subject);
});

test('3 and a forged x-forwarded-for cannot merge or split visitors: different cf-connecting-ip → different subjects even if x-forwarded-for is identical', async () => {
  const a = await subjectFor({ 'cf-connecting-ip': '192.0.2.10', 'x-forwarded-for': '198.51.100.7' });
  const b = await subjectFor({ 'cf-connecting-ip': '192.0.2.11', 'x-forwarded-for': '198.51.100.7' });
  assert.notEqual(a.subject, b.subject, 'two unrelated visitors never share an identity because of a header they do not control');
});

test('4 no trusted address (header absent, x-forwarded-for only) → 503, and NOT ONE network call is made (no limiter claim, no Cloudflare call, nothing stored)', async () => {
  for (const h of [{}, { 'x-forwarded-for': '203.0.113.9' }, { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }]) {
    const n = net({ forbid: true }); const r = await handleFuneralEnquiry(req(h), n.deps); const j = await r.json();
    assert.deepEqual([r.status, j.error], [503, 'unavailable'], JSON.stringify(h));
  }
});

test('5 malformed cf-connecting-ip → 503 and no network call: garbage, empty, several comma-joined values, ports, out-of-range, octal-looking, oversized, injected text', async () => {
  const bad = ['spoofed', '999.1.1.1', '1.2.3.4, 5.6.7.8', '1.2.3.4:443', '1.2.3', '010.0.0.1', '::1', '::', 'gggg::1', '2001:db8::1::2', '<script>', '1.2.3.4\u0000', 'x'.repeat(5000), '2001:db8:1:2:3:4:5:6:7', '::ffff:999.1.1.1'];
  for (const v of bad) {
    let headers: Record<string, string> | null = { 'cf-connecting-ip': v };
    try { new Headers(headers); } catch { headers = null; }      // a value the platform could not even carry is refused by the runtime itself
    if (!headers) continue;
    const n = net({ forbid: true }); const r = await handleFuneralEnquiry(req(headers), n.deps);
    assert.equal(r.status, 503, JSON.stringify(v).slice(0, 40)); assert.equal((await r.json()).error, 'unavailable');
  }
});

test('6 unrelated visitors never share an identity by accident: IPv4-mapped, NAT64 and loopback-style IPv6 forms do not collapse into one /64 bucket', () => {
  assert.equal(normaliseIp('::ffff:192.0.2.5'), '192.0.2.5'); assert.equal(normaliseIp('::ffff:c000:205'), '192.0.2.5'); assert.equal(normaliseIp('64:ff9b::192.0.2.5'), '192.0.2.5'); assert.equal(normaliseIp('64:ff9b::c000:205'), '192.0.2.5');
  assert.notEqual(normaliseIp('::ffff:c000:205'), normaliseIp('::ffff:c000:206'));
  assert.notEqual(normaliseIp('64:ff9b::c000:205'), normaliseIp('64:ff9b::c000:206'));
  for (const v of ['::', '::1', '::192.0.2.5', '0:0:0:0:0:0:0:1']) assert.equal(normaliseIp(v), null, `${v} has no usable /64 and is refused rather than shared`);
  assert.equal(normaliseIp('192.0.2.5'), '192.0.2.5'); assert.equal(normaliseIp('010.0.0.1'), null);
});

test('7 IPv6 /64 grouping: every spelling of one /64 gives one key; a different /64 gives a different key; the low 64 bits never matter', () => {
  const same = ['2001:db8:1:2::1', '2001:db8:1:2::ffff', '2001:db8:1:2:0:0:0:1', '2001:DB8:1:2:abcd:ef01:2345:6789', '[2001:db8:1:2::9]', '2001:db8:0001:0002:0000:0000:0000:0001', '2001:db8:1:2::'];
  const keys = new Set(same.map((v) => normaliseIp(v)));
  assert.equal(keys.size, 1); assert.equal([...keys][0], '2001:0db8:0001:0002::/64');
  for (const other of ['2001:db8:1:3::1', '2001:db8:2:2::1', '2001:db9:1:2::1', '2001:db8:1::2']) assert.notEqual(normaliseIp(other), '2001:0db8:0001:0002::/64', other);
  assert.equal(normaliseIp('fe80::1%eth0'), 'fe80:0000:0000:0000::/64', 'a zone id is dropped');
  assert.equal(normaliseIp('1::'), '0001:0000:0000:0000::/64'); assert.equal(normaliseIp('2001:db8::'), '2001:0db8:0000:0000::/64');
});

test('8 the same /64 shares ONE limiter subject end to end; a neighbouring /64 does not', async () => {
  const a = await subjectFor({ 'cf-connecting-ip': '2001:db8:aaaa:1::1' }), b = await subjectFor({ 'cf-connecting-ip': '2001:db8:aaaa:1:ffff:ffff:ffff:ffff' }), c = await subjectFor({ 'cf-connecting-ip': '2001:db8:aaaa:2::1' });
  assert.equal(a.subject, b.subject); assert.notEqual(a.subject, c.subject);
});

test('9 the address is never sent anywhere raw except to Cloudflare as remoteip; the limiter only ever sees a keyed hash; the key depends on the secret salt', async () => {
  const n = net(); await handleFuneralEnquiry(req({ 'cf-connecting-ip': '192.0.2.10' }), n.deps);
  const claims = n.calls.filter((c) => c.url.includes('claim_rate_limits')); assert.ok(claims.length >= 1); for (const c of claims) assert.ok(!JSON.stringify(c.body).includes('192.0.2.10'));
  const cf = n.calls.find((c) => c.url.includes('siteverify')); assert.equal(cf?.body.remoteip, '192.0.2.10');
  const other = net(); await handleFuneralEnquiry(req({ 'cf-connecting-ip': '192.0.2.10' }), { ...other.deps, env: (k) => (k === 'FUNERAL_ENQUIRY_IP_SALT' ? 'a-different-salt-0123456789' : ENV[k]) });
  assert.notEqual(other.calls[0].body.p_subject, n.calls[0].body.p_subject, 'a different salt gives different keys, so a leaked limiter table cannot be reversed without it');
});
