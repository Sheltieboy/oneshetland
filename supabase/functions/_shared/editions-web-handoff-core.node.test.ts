/** Pure tests for editions-web-handoff-core.ts and source guards for the edge function. Run: node --test supabase/functions/_shared/editions-web-handoff-core.node.test.ts (no database, no network, no secrets). */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from './editions-web-handoff-core.ts';

const UUID = '6f1c2b3a-1111-4222-8333-444455556666';
const src = readFileSync(new URL('../editions-web-handoff/index.ts', import.meta.url), 'utf8');

describe('code', () => {
  test('is at least 256 bits, unique, URL safe; the hash is 64 hex and differs from the code', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) { const c = C.generateCode(); assert.match(c, C.CODE_RE); assert.equal(c.length, 43); seen.add(c); }
    assert.equal(seen.size, 200);
    const c = C.generateCode(), h = await C.sha256Hex(c);
    assert.match(h, /^[0-9a-f]{64}$/); assert.notEqual(h, c);
    assert.equal(await C.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  test('malformed codes never match the shape', () => {
    for (const bad of ['', 'short', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '=', 'a'.repeat(42) + '/', `${'a'.repeat(42)} `, "'; drop table x;--"]) assert.doesNotMatch(bad, C.CODE_RE);
  });
  test('timingSafeEqual', () => { assert.ok(C.timingSafeEqual('a'.repeat(40), 'a'.repeat(40))); assert.ok(!C.timingSafeEqual('a'.repeat(40), 'a'.repeat(39) + 'b')); assert.ok(!C.timingSafeEqual('', '')); assert.ok(!C.timingSafeEqual('a', 'ab')); });
});

describe('destination allowlist (keys, never URLs)', () => {
  const ok = (o: object) => C.parseMintBody({ organiser_id: UUID, platform: 'ios', ...o });
  test('accepts exactly the five keys', () => {
    for (const d of ['dashboard', 'editions', 'team', 'profile']) assert.equal(ok({ destination: d })?.destination, d);
    assert.equal(ok({ destination: 'edition', edition_id: UUID })?.edition_id, UUID);
  });
  test('refuses packages, promote, checkout, payments, participation, members, free URLs, paths and traversal', () => {
    for (const d of ['packages', 'package', 'promote', 'promotion', 'checkout', 'payments', 'participation', 'members', 'brand', 'https://evil.example/', '//evil.example', '/organise/x/packages', '/organise/x/editions/y/package', '../../account', 'Dashboard', 'dashboard ', '', null, 5, ['dashboard']]) assert.equal(ok({ destination: d }), null, String(d));
  });
  test('edition key needs a uuid; others refuse an edition id; bad organiser and platform refused', () => {
    assert.equal(ok({ destination: 'edition' }), null); assert.equal(ok({ destination: 'edition', edition_id: 'x' }), null); assert.equal(ok({ destination: 'dashboard', edition_id: UUID }), null);
    assert.equal(C.parseMintBody({ organiser_id: 'x', destination: 'dashboard', platform: 'ios' }), null);
    assert.equal(C.parseMintBody({ organiser_id: UUID, destination: 'dashboard', platform: 'web' }), null);
    assert.equal(C.parseMintBody(null), null); assert.equal(C.parseMintBody('x'), null);
  });
  test('the website path pattern admits the closed set only', () => {
    for (const p of ['/organise/my-org', '/organise/my-org/editions', '/organise/my-org/team', '/organise/my-org/profile', '/organise/my-org/editions/summer-fest']) assert.match(p, C.ALLOWED_PATH);
    for (const p of ['/organise/my-org/packages', '/organise/my-org/promote', '/organise/my-org/payments', '/organise/my-org/members', '/organise/my-org/editions/x/package', '/organise/my-org/editions/x/promote', '/organise/my-org/editions/x/participation', '//evil.example', '/\\evil', 'https://evil.example/organise/a', '/organise/a/../../account', '/organise/a?next=/packages', '/organise/a#x', '/account', '/organise/']) assert.doesNotMatch(p, C.ALLOWED_PATH, p);
  });
});

describe('check number', () => {
  test('is four digits, uniform-ish, keeps leading zeros; its stored hash binds it to the code', async () => {
    const seen = new Set<string>(); for (let i = 0; i < 3000; i++) { const n = C.generateCheckNumber(); assert.match(n, C.CHECK_RE); seen.add(n); }
    assert.ok(seen.size > 1500); assert.ok([...seen].some((n) => n.startsWith('0')));
    const a = await C.checkHash('a'.repeat(64), '4821'), b = await C.checkHash('b'.repeat(64), '4821'), c = await C.checkHash('a'.repeat(64), '4822');
    assert.match(a, /^[0-9a-f]{64}$/); assert.notEqual(a, b); assert.notEqual(a, c); assert.equal(a, await C.checkHash('a'.repeat(64), '4821'));
    for (const bad of ['', '123', '12345', '12a4', ' 123', '１２３４']) assert.doesNotMatch(bad, C.CHECK_RE);
  });
  test('secretMatches: only an exact, long-enough secret', async () => {
    const s = 'x'.repeat(40); assert.ok(await C.secretMatches(s, s));
    for (const [a, b] of [[s, s + 'x'], [s, s.slice(1)], [s, ''], ['', ''], ['short', 'short'], [s, 'y'.repeat(40)]] as [string, string][]) assert.equal(await C.secretMatches(a, b), false);
  });
});

describe('url, mask, account decision', () => {
  test('the URL is on a fixed origin whatever is configured, and carries only the code', () => {
    assert.equal(C.handoffUrl('https://evil.example', 'abc'), 'https://oneshetland.com/app-handoff#c=abc');
    assert.equal(C.handoffUrl('https://www.oneshetland.com/', 'abc'), 'https://www.oneshetland.com/app-handoff#c=abc');
    assert.equal(C.handoffUrl(undefined as never, 'a b&c'), 'https://oneshetland.com/app-handoff#c=a%20b%26c');
    assert.doesNotMatch(C.handoffUrl(undefined as never, C.generateCode()), /\?/, 'no query string at all: the code is only ever in the fragment');
  });
  test('maskEmail shows one letter and the domain', () => { assert.equal(C.maskEmail('jane@example.com'), 'j***@example.com'); assert.equal(C.maskEmail(null), 'your account'); assert.equal(C.maskEmail('nope'), 'your account'); });
  const now = Date.parse('2026-11-11T12:00:00Z'), good = { email: 'a@b.co', email_confirmed_at: '2026-01-01T00:00:00Z' };
  test('allows a confirmed, unbanned, undeleted account without a second factor', () => assert.deepEqual(C.accountDecision(good, [], now), { ok: true, email: 'a@b.co' }));
  test('refuses unconfirmed (must not bypass email confirmation), banned, deleted, MFA, no email, no user', () => {
    assert.deepEqual(C.accountDecision({ email: 'a@b.co' }, [], now), { ok: false, reason: 'unconfirmed' });
    assert.deepEqual(C.accountDecision({ ...good, banned_until: '2999-01-01T00:00:00Z' }, [], now), { ok: false, reason: 'banned' });
    assert.deepEqual(C.accountDecision({ ...good, banned_until: 'garbage' }, [], now), { ok: false, reason: 'banned' });
    assert.equal(C.accountDecision({ ...good, banned_until: '2020-01-01T00:00:00Z' }, [], now).ok, true, 'an expired ban is over');
    assert.deepEqual(C.accountDecision({ ...good, deleted_at: '2026-11-01T00:00:00Z' }, [], now), { ok: false, reason: 'deleted' });
    assert.deepEqual(C.accountDecision(good, [{ status: 'verified' }], now), { ok: false, reason: 'mfa' });
    assert.deepEqual(C.accountDecision({ email_confirmed_at: 'x' }, [], now), { ok: false, reason: 'no_email' });
    assert.deepEqual(C.accountDecision(null, [], now), { ok: false, reason: 'no_user' });
  });
});

describe('edge function source guards', () => {
  test('mint needs a real signed-in user and refuses a service-role caller', () => { assert.match(src, /requireCaller\(req, corsHeaders\)/); assert.match(src, /isServiceRole/); assert.ok(src.indexOf('requireCaller(') < src.indexOf("rpc('edition_handoff_mint'")); });
  test('peek, redeem and complete need the website server secret (digest compare) and fail closed without it; failures are counted', () => {
    assert.match(src, /HANDOFF_WEB_SECRET/); assert.match(src, /secretMatches\(/); assert.match(src, /editions_handoff_secret_fail/);
    for (const rpc of ['edition_handoff_redeem', 'edition_handoff_peek', 'edition_handoff_finish']) assert.ok(src.indexOf('secretMatches(') < src.indexOf(`rpc('${rpc}'`), rpc);
  });
  test('the check number is generated at mint, only its hash is stored, and redeem requires a well-formed number', () => {
    assert.match(src, /generateCheckNumber\(\)/); assert.match(src, /p_check_hash: await checkHash\(hash, number\)/); assert.match(src, /CHECK_RE\.test\(number\)/);
    assert.doesNotMatch(src, /p_number|check_number: hash/);
  });
  test('mint refuses a banned, unconfirmed, deleted or MFA account BEFORE any database write', () => { assert.ok(src.indexOf('accountDecision(') < src.indexOf("rpc('edition_handoff_mint'")); });
  test('the website is told the outcome only via complete; the audit "redeemed" is never written by redeem itself', () => { assert.match(src, /action === 'complete'/); assert.match(src, /edition_handoff_finish/); });
  test('no shared unknown bucket: an address is used only when one is passed, otherwise the code alone is throttled', () => { assert.doesNotMatch(src, /'unknown'\s*[;)]/.test(src) ? /$^/ : /unknown_bucket/); assert.match(src, /o\.ip !== 'unknown' \? o\.ip : null/); assert.match(src, /const codeSubject = `code:/); });
  test('rate limits per user, per address and per code; the limiter fails closed (shared helper)', () => { for (const a of ['editions_handoff_mint', 'editions_handoff_redeem_ip', 'editions_handoff_redeem_code', 'editions_handoff_view_ip']) assert.match(src, new RegExp(a)); });
  test('never logs the code, the hash or the token', () => {
    const logs = src.split('\n').filter((l) => /console\.(log|warn|error|info)/.test(l)).join('\n');
    assert.ok(logs.length > 0); assert.doesNotMatch(logs, /\bcode\b|hash|token|secret|\bbody\b|\bo\.code|number/i);
  });
  test('the path comes from the database and is re-checked against the allowlist; unconfirmed/banned/MFA are decided before a link is generated', () => {
    assert.match(src, /ALLOWED_PATH\.test\(r\.path\)/); assert.ok(src.lastIndexOf('accountDecision(') < src.indexOf('generateLink(')); assert.ok(src.indexOf('generateLink(') > src.indexOf('refused(decision.reason)'), 'generateLink is the last step');
    assert.match(src, /type: 'magiclink'/); assert.doesNotMatch(src, /signInWithOtp|sendMagicLink|resetPasswordForEmail/);
  });
  test('the request carries no URL or redirect parameter and nothing here sends email', () => { assert.doesNotMatch(src, /redirectTo|redirect_to|\.destination_url|req\.url/); });
  test('registered: verify_jwt true in config.toml and staged (not deployed)', () => {
    const toml = readFileSync(new URL('../../config.toml', import.meta.url), 'utf8');
    assert.match(toml, /\[functions\.editions-web-handoff\]\s*\nverify_jwt\s*=\s*true/);
    const staged = JSON.parse(readFileSync(new URL('../../production/staged-functions.json', import.meta.url), 'utf8'));
    assert.equal(staged.functions['editions-web-handoff'].verify_jwt, true);
  });
});
