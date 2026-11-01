/**
 * claim-emails.node.test.ts — the emails around a business claim: received, approved, rejected, and the admin alert.
 *
 * Runs the REAL shared module (_shared/claim-emails.ts) against an in-memory database and a recording sender. No Postmark, no network, no real email.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emailClaimReceived, emailClaimOutcome } from '../functions/_shared/claim-emails.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

type Row = Record<string, any>;
function db(seed: Record<string, Row[]> = {}, emails: Record<string, string | null> = {}) {
  const t: Record<string, Row[]> = { business_claims: [], local_businesses: [], profiles: [], email_log: [], ...seed };
  const q = (name: string) => {
    const filters: ((r: Row) => boolean)[] = []; let lim = Infinity;
    const b: any = {
      select() { return b; }, eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
      contains(c: string, o: Row) { filters.push((r) => Object.entries(o).every(([k, v]) => r[c]?.[k] === v)); return b; },
      limit(n: number) { lim = n; return b; },
      maybeSingle() { return Promise.resolve({ data: t[name].filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null }); },
      then(ok: any, bad: any) { return Promise.resolve({ data: t[name].filter((r) => filters.every((f) => f(r))).slice(0, lim), error: null }).then(ok, bad); },
    };
    return b;
  };
  return { tables: t, from: q, auth: { admin: { getUserById: async (id: string) => ({ data: { user: { email: emails[id] ?? null } } }) } } };
}
const recorder = (opts: { fail?: Set<string>; disabled?: Set<string>; svc?: any } = {}) => {
  const sent: { templateKey: string; to: string; vars: Record<string, string>; metadata: any }[] = [];
  const send = async (svc: any, i: any) => {
    if (opts.fail?.has(i.templateKey)) return { ok: false, skipped: false, error: 'postmark down' };
    if (opts.disabled?.has(i.templateKey)) return { ok: true, skipped: true };
    sent.push({ templateKey: i.templateKey, to: i.recipientEmail, vars: i.variables, metadata: i.metadata });
    svc.tables.email_log.push({ template_key: i.templateKey, recipient_email: i.recipientEmail, metadata: i.metadata, status: 'sent' });   // what the real sender logs
    return { ok: true, skipped: false };
  };
  return { sent, send };
};

const CLAIM = { id: 'c1', user_id: 'u1', business_id: 'b1', contact_name: 'Ann Smith', contact_email: 'ann@elsewhere.example', role: 'Owner', evidence: 'Our website is annbakes.example' };
const world = () => db({
  business_claims: [CLAIM], local_businesses: [{ id: 'b1', name: 'Ann’s Bakehouse' }],
  profiles: [{ id: 'u1', full_name: 'Ann Smith', role: 'customer' }, { id: 'a1', role: 'admin' }, { id: 'a2', role: 'admin' }],
}, { u1: 'ann@account.example', a1: 'admin1@oneshetland.example', a2: 'admin2@oneshetland.example' });

describe('claim received', () => {
  test('the claimant is emailed at their ACCOUNT address (never the free-text contact email), with their first name and the business', async () => {
    const w = world(); const r = recorder({ svc: w });
    const out = await emailClaimReceived(w, 'c1', { send: (s, i) => r.send(w, i) });
    const mine = r.sent.find((s) => s.templateKey === 'business.claim_received')!;
    assert.equal(mine.to, 'ann@account.example'); assert.notEqual(mine.to, CLAIM.contact_email);
    assert.deepEqual(mine.vars, { name: 'Ann', business_name: 'Ann’s Bakehouse' }); assert.equal(mine.metadata.claim_id, 'c1');
    assert.equal(out.claimant?.sent, true); assert.deepEqual(out.errors, []);
  });
  test('every admin is told by email, with the claimant, business, role, how to verify them and a link to the review page', async () => {
    const w = world(); const r = recorder({ svc: w });
    const out = await emailClaimReceived(w, 'c1', { send: (s, i) => r.send(w, i) });
    const adm = r.sent.filter((s) => s.templateKey === 'admin.business_claim_received');
    assert.deepEqual(adm.map((a) => a.to).sort(), ['admin1@oneshetland.example', 'admin2@oneshetland.example']); assert.equal(out.admins, 2);
    assert.deepEqual(adm[0].vars, { claimant_name: 'Ann Smith', claimant_email: 'ann@elsewhere.example', business_name: 'Ann’s Bakehouse', role: 'Owner', evidence: 'Our website is annbakes.example', review_url: 'https://oneshetland.com/admin/claims' });
  });
  test('long, messy claimant text is trimmed and flattened before it goes into an email', async () => {
    const w = world(); w.tables.business_claims[0].evidence = ('line one\n\n   line two ' + 'x'.repeat(600)); const r = recorder({ svc: w });
    await emailClaimReceived(w, 'c1', { send: (s, i) => r.send(w, i) });
    const ev = r.sent.find((s) => s.templateKey === 'admin.business_claim_received')!.vars.evidence;
    assert.ok(ev.length <= 300); assert.doesNotMatch(ev, /\n/);
  });
  test('sent once only: a repeated notification sends nothing more', async () => {
    const w = world(); const r = recorder({ svc: w }); const deps = { send: (s: any, i: any) => r.send(w, i) };
    await emailClaimReceived(w, 'c1', deps); const n = r.sent.length; assert.equal(n, 3);
    const again = await emailClaimReceived(w, 'c1', deps); assert.equal(r.sent.length, n); assert.equal(again.claimant?.reason, 'already-sent'); assert.equal(again.admins, 0);
  });
  test('a claimant with no account email still triggers the admin emails, and the gap is reported', async () => {
    const w = db({ business_claims: [CLAIM], local_businesses: [{ id: 'b1', name: 'Ann’s Bakehouse' }], profiles: [{ id: 'a1', role: 'admin' }] }, { a1: 'admin1@oneshetland.example' }); const r = recorder({ svc: w });
    const out = await emailClaimReceived(w, 'c1', { send: (s, i) => r.send(w, i) });
    assert.equal(r.sent.length, 1); assert.equal(r.sent[0].templateKey, 'admin.business_claim_received'); assert.ok(out.errors.some((e) => /no account email/.test(e)));
  });
  test('a failing mail provider never throws, and is reported', async () => {
    const w = world(); const r = recorder({ svc: w, fail: new Set(['business.claim_received', 'admin.business_claim_received']) });
    const out = await emailClaimReceived(w, 'c1', { send: (s, i) => r.send(w, i) });
    assert.equal(r.sent.length, 0); assert.ok(out.errors.includes('claimant email failed')); assert.ok(out.errors.includes('admin email failed'));
  });
  test('a template switched off in the Email Centre is respected (nothing sent, no error)', async () => {
    const w = world(); const r = recorder({ svc: w, disabled: new Set(['business.claim_received']) });
    const out = await emailClaimReceived(w, 'c1', { send: (s, i) => r.send(w, i) });
    assert.equal(out.claimant?.sent, false); assert.equal(out.claimant?.reason, 'template-disabled'); assert.deepEqual(out.errors, []);
  });
  test('an unknown claim, or a broken database, returns an error instead of throwing', async () => {
    const w = world(); assert.ok((await emailClaimReceived(w, 'nope', { send: async () => ({ ok: true, skipped: false }) })).errors.includes('claim not found'));
    const broken: any = { from() { throw new Error('db down'); } };
    assert.ok((await emailClaimReceived(broken, 'c1', { send: async () => ({ ok: true, skipped: false }) })).errors.length > 0);
  });
});

describe('claim outcome', () => {
  test('approved: emailed at the account address with a link to THAT business’s dashboard', async () => {
    const w = world(); const r = recorder({ svc: w });
    const out = await emailClaimOutcome(w, 'c1', 'approved', { send: (s, i) => r.send(w, i) });
    assert.equal(out.sent, true); const m = r.sent[0];
    assert.equal(m.templateKey, 'business.claim_approved'); assert.equal(m.to, 'ann@account.example'); assert.equal(m.vars.manage_url, 'https://oneshetland.com/business/b1/manage');
  });
  test('rejected: a different, gentler email, with no dashboard link', async () => {
    const w = world(); const r = recorder({ svc: w });
    await emailClaimOutcome(w, 'c1', 'rejected', { send: (s, i) => r.send(w, i) });
    assert.equal(r.sent[0].templateKey, 'business.claim_rejected'); assert.equal('manage_url' in r.sent[0].vars, false);
  });
  test('each outcome is sent once per claim; approving then rejecting the same claim still sends each template at most once', async () => {
    const w = world(); const r = recorder({ svc: w }); const deps = { send: (s: any, i: any) => r.send(w, i) };
    await emailClaimOutcome(w, 'c1', 'approved', deps); await emailClaimOutcome(w, 'c1', 'approved', deps); assert.equal(r.sent.length, 1);
  });
  test('failure and missing address are reported, not thrown', async () => {
    const w = world(); const r = recorder({ svc: w, fail: new Set(['business.claim_approved']) });
    assert.ok((await emailClaimOutcome(w, 'c1', 'approved', { send: (s, i) => r.send(w, i) })).errors.includes('outcome email failed'));
    const w2 = db({ business_claims: [CLAIM], local_businesses: [{ id: 'b1', name: 'X' }] }, {});
    assert.equal((await emailClaimOutcome(w2, 'c1', 'rejected', { send: async () => ({ ok: true, skipped: false }) })).reason, 'no-email');
  });
});

describe('templates (migration 20261203000000)', () => {
  const sql = read('supabase/migrations/20261203000000_business_claim_emails.sql');
  const rows = [...sql.matchAll(/\('([a-z_.]+)', '([a-z]+)', '[^']*', '[^']*',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*ARRAY\[([^\]]*)\]/g)].map((m) => ({ key: m[1], subject: m[3], body: m[4], vars: [...m[5].matchAll(/'(\w+)'/g)].map((x) => x[1]) }));
  test('the four templates exist and are inserted without touching existing rows', () => {
    assert.deepEqual(rows.map((r) => r.key).sort(), ['admin.business_claim_received', 'business.claim_approved', 'business.claim_received', 'business.claim_rejected']);
    assert.match(sql, /on conflict \(key\) do nothing/i); assert.doesNotMatch(code(sql), /update public\.email_templates|delete from/i);
  });
  test('every placeholder used is declared, and every declared one is supplied by the sender', async () => {
    const w = world(); const r = recorder({ svc: w });
    await emailClaimReceived(w, 'c1', { send: (s, i) => r.send(w, i) }); await emailClaimOutcome(w, 'c1', 'approved', { send: (s, i) => r.send(w, i) });
    const w2 = world(); const r2 = recorder({ svc: w2 }); await emailClaimOutcome(w2, 'c1', 'rejected', { send: (s, i) => r2.send(w2, i) });
    const supplied = new Map([...r.sent, ...r2.sent].map((s) => [s.templateKey, Object.keys(s.vars).sort()]));
    for (const t of rows) {
      const used = new Set([...(t.subject + t.body).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
      for (const u of used) assert.ok(t.vars.includes(u), `${t.key} uses {{${u}}} but does not declare it`);
      assert.deepEqual(supplied.get(t.key), [...t.vars].sort(), `${t.key}: sender supplies exactly the declared variables`);
    }
  });
  test('wording promises no timescale and says claiming is free', () => {
    assert.doesNotMatch(sql, /within \d|\d+\s*(hours?|days?|minutes?)|working days|shortly|soon\b(?! as)/i); assert.match(sql, /free/i);
  });
});

describe('wiring', () => {
  const nbc = code(read('supabase/functions/notify-business-claim/index.ts')), nc = code(read('supabase/functions/notify-claim/index.ts'));
  test('submission: the caller is authorised (and rate limited) before any email, which follows the admin push', () => {
    assert.ok(nbc.indexOf('authoriseBusinessClaimNotify(') < nbc.indexOf('emailClaimReceived(')); assert.ok(nbc.indexOf('sendPush(') < nbc.indexOf('emailClaimReceived('));
    assert.match(nbc, /return json\(\{ ok: true, notified, emails \}\)/);
  });
  test('outcome: only an admin deciding the claim triggers the email, after the push', () => {
    assert.ok(nc.indexOf('authoriseClaimOutcomeNotify(') < nc.indexOf('emailClaimOutcome(')); assert.ok(nc.indexOf('sendUserPush(') < nc.indexOf('emailClaimOutcome('));
    assert.match(nc, /approved \? 'approved' : 'rejected'/);
  });
  test('the existing push notifications and their authorisation are unchanged', () => {
    assert.match(nbc, /'New business claim'/); assert.match(nbc, /requireCaller\(req, corsHeaders\)/); assert.match(nc, /business\.claim_approved/); assert.match(nc, /You're verified/);
  });
});
