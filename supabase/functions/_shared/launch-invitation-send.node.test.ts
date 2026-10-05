/**
 * launch-invitation-send.node.test.ts — the launch-outreach send, proved without a mailbox or a network.
 *
 * Every side effect (database, Postmark, clock) is a recording stub. NOTHING in this file can send a real email: the only
 * "provider" is a stub, and the Postmark module is driven by a fake fetch that never leaves the process.
 *
 * Run (only this file):  node --test supabase/functions/_shared/launch-invitation-send.node.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  launchInvitationSend, evaluateGates, resolveReplyTo, validSender, addressOf, MESSAGE, ProviderRejected, ProviderUnknown,
  type CampaignFacts, type SendDeps, type MailMessage,
} from './launch-invitation-send.ts';
import { renderInvitationEmail, checkEmail, CTA_LABEL, CTA_FALLBACK_LINE } from './launch-invitation-email.ts';
import { postmarkSend, postmarkRequestBody, POSTMARK_URL, type FetchLike } from './launch-invitation-postmark.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string) => readFileSync(here(p), 'utf8');

const TOKEN = '7f3a9c1e5b2d4f60a8c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1';
const CID = '0d38887b-8e0f-4aa6-b5c3-3a41abb38fd6';
const BIZ = 'fdda4cbe-1e28-4f4d-89d8-aed8317be513';
const FROM = 'Darren Fullerton · OneShetland <hello@oneshetland.com>';
const OPENING = 'You make something genuinely Shetland, and I think more locals and visitors should be able to find what you do easily.';
const BODY = ['Hello,', '', "I’m Darren, and I’m getting ready to launch OneShetland.", '', '{{PERSONALISED_OPENING}}', '', '{{INVITATION_CTA}}', '', 'Darren'].join('\n');
const future = new Date(Date.now() + 7 * 864e5).toISOString();

const facts = (o: Partial<CampaignFacts> = {}): CampaignFacts => ({
  id: CID, slug: 'zz-launch-email-test', businessId: BIZ, businessName: 'ZZ TEST', stage: 'ready_to_invite', sentAt: null,
  contactEmail: 'recipient@example.test', subject: 'I’ve made a private OneShetland preview for ZZ TEST', opening: OPENING, body: BODY,
  invitation: { status: 'open', expiresAt: future }, ...o,
});
const confirm = (f = facts()) => ({ confirm: true, recipient: f.contactEmail!, subject: f.subject! });

function rig(over: Partial<{ facts: CampaignFacts | null; tokenBiz: string | null; claim: unknown; send: (m: MailMessage) => Promise<{ id: string }>; markFails: number; releaseThrows: boolean; from: string | null; replyTo: string | null }> = {}) {
  const calls: string[] = [];
  const sent: MailMessage[] = [];
  let markFails = over.markFails ?? 0;
  const deps: SendDeps = {
    origin: 'https://oneshetland.com', from: over.from === undefined ? FROM : over.from, replyTo: over.replyTo === undefined ? 'hello@oneshetland.com' : over.replyTo, now: () => new Date(),
    async getCampaign() { calls.push('get'); return over.facts === undefined ? facts() : over.facts; },
    async resolveToken() { calls.push('resolve'); return over.tokenBiz === undefined ? BIZ : over.tokenBiz; },
    async claimSend() { calls.push('claim'); return (over.claim ?? { ok: true }) as never; },
    async releaseSend() { calls.push('release'); if (over.releaseThrows) throw new Error('db down'); },
    async markSent(_id, note) { calls.push('markSent'); if (markFails > 0) { markFails--; throw new Error('db down'); } assert.match(note, /^Emailed from Admin \(provider message [^)]+\)$/); },
    async send(m) { calls.push('send'); sent.push(m); return (over.send ?? (async () => ({ id: 'pm-123' })))(m); },
  };
  return { deps, calls, sent };
}
const go = (r: ReturnType<typeof rig>, o: Partial<{ campaignId: unknown; token: unknown; confirmation: unknown }> = {}) =>
  launchInvitationSend({ campaignId: CID, token: TOKEN, confirmation: confirm(), ...o } as never, r.deps);

describe('the happy path', () => {
  test('reads, checks, reserves, sends once, then records — in that order', async () => {
    const r = rig(); const out = await go(r);
    assert.equal(out.ok, true);
    assert.deepEqual(r.calls, ['get', 'resolve', 'claim', 'send', 'markSent']);
    assert.equal(r.sent.length, 1);
    if (out.ok) { assert.equal(out.messageId, 'pm-123'); assert.equal(out.recipient, 'recipient@example.test'); assert.equal(out.recorded, true); assert.equal(out.expiresAt, future); }
  });
  test('From keeps the display name, Reply-To is the BARE address, the recipient is the SAVED contact', async () => {
    const r = rig(); await go(r); const m = r.sent[0];
    assert.equal(m.from, FROM); assert.equal(m.replyTo, 'hello@oneshetland.com'); assert.doesNotMatch(m.replyTo, /[<>·]|Darren/);
    assert.equal(m.to, 'recipient@example.test');
  });
  test('the email is rendered HERE from the saved draft, with this campaign’s own link: button, fallback, plain text', async () => {
    const r = rig(); await go(r); const m = r.sent[0];
    const link = `https://oneshetland.com/launch/zz-launch-email-test?invite=${TOKEN}`;
    assert.ok(m.html.includes(CTA_LABEL) && m.html.includes(`href="${link}"`) && m.html.includes(CTA_FALLBACK_LINE));
    assert.ok(m.text.includes(`View your private preview: ${link}`)); assert.ok(m.html.includes(OPENING) && m.text.includes(OPENING));
    assert.ok(!m.html.includes('{{') && !m.text.includes('{{'));
  });
  test('the provider’s metadata never carries the link, the token or the recipient', async () => {
    const r = rig(); await go(r);
    assert.deepEqual(Object.keys(r.sent[0].metadata).sort(), ['campaign', 'kind']);
    const meta = JSON.stringify(r.sent[0].metadata); assert.ok(!meta.includes(TOKEN) && !meta.includes('example.test') && !meta.includes('http'));
  });
});

describe('nothing is sent unless every gate passes (and nothing is even reserved)', () => {
  const blocked: [string, Parameters<typeof rig>[0], string][] = [
    ['already sent', { facts: facts({ sentAt: '2026-10-05T00:00:00Z' }) }, 'already_sent'],
    ['not ready', { facts: facts({ stage: 'preparing' }) }, 'not_ready'],
    ['no contact', { facts: facts({ contactEmail: null }) }, 'contact_missing'],
    ['bad contact', { facts: facts({ contactEmail: 'nope' }) }, 'contact_invalid'],
    ['no subject', { facts: facts({ subject: '' }) }, 'draft_incomplete'],
    ['opening still the prompt', { facts: facts({ opening: '[Your short personal opening — why you chose X, in your own words. Replace this line before sending.]' }) }, 'draft_incomplete'],
    ['no call-to-action token', { facts: facts({ body: 'no token here' }) }, 'draft_incomplete'],
    ['real link pasted into the draft', { facts: facts({ body: BODY.replace('{{INVITATION_CTA}}', `https://oneshetland.com/launch/x?invite=${TOKEN}`) }) }, 'draft_incomplete'],
    ['no invitation', { facts: facts({ invitation: { status: 'none', expiresAt: null } }) }, 'invitation_invalid'],
    ['revoked invitation', { facts: facts({ invitation: { status: 'revoked', expiresAt: future } }) }, 'invitation_invalid'],
    ['expired invitation', { facts: facts({ invitation: { status: 'open', expiresAt: '2000-01-01T00:00:00Z' } }) }, 'invitation_expired'],
    ['token is for a different business', { tokenBiz: '00000000-0000-4000-8000-000000000000' }, 'invitation_invalid'],
    ['token not valid at all', { tokenBiz: null }, 'invitation_invalid'],
  ];
  for (const [name, over, code] of blocked) {
    test(name, async () => {
      const r = rig(over); const out = await go(r);
      assert.equal(out.ok, false); if (!out.ok) assert.ok(out.failures.includes(code as never), `${code} in ${out.failures}`);
      assert.ok(!r.calls.includes('claim') && !r.calls.includes('send') && !r.calls.includes('markSent'), `calls: ${r.calls}`);
    });
  }
  test('not confirmed / no confirmation', async () => {
    for (const conf of [{ ...confirm(), confirm: false }, null, undefined, { ...confirm(), confirm: 'yes' }]) {
      const r = rig(); const out = await go(r, { confirmation: conf }); assert.equal(out.ok, false); assert.deepEqual(r.calls.filter((c) => c !== 'get' && c !== 'resolve'), []);
    }
  });
  test('the recipient or subject changed since the administrator confirmed', async () => {
    for (const [conf, code] of [[{ ...confirm(), recipient: 'someone-else@example.test' }, 'recipient_changed'], [{ ...confirm(), subject: 'an older subject' }, 'subject_changed']] as const) {
      const r = rig(); const out = await go(r, { confirmation: conf }); assert.equal(out.ok, false); if (!out.ok) assert.ok(out.failures.includes(code)); assert.ok(!r.calls.includes('send'));
    }
    const ok = rig(); assert.equal((await go(ok, { confirmation: { ...confirm(), recipient: 'RECIPIENT@Example.TEST' } })).ok, true, 'recipient comparison ignores case');
  });
  test('malformed requests are refused before the database is touched', async () => {
    const bad = [{ campaignId: 'not-a-uuid' }, { campaignId: undefined }, { token: 'short' }, { token: undefined }, { confirmation: { confirm: true, recipient: 5, subject: 's' } }, { confirmation: { confirm: true } }];
    for (const b of bad) { const r = rig(); const out = await go(r, b as never); assert.equal(out.ok, false); assert.deepEqual(r.calls, []); if (!out.ok) assert.equal(out.code, 'bad_request'); }
  });
  test('unknown campaign', async () => { const r = rig({ facts: null }); const out = await go(r); assert.equal(out.ok, false); if (!out.ok) assert.equal(out.code, 'not_found'); assert.deepEqual(r.calls, ['get']); });
  test('no sender configured => stop before anything is read, reserved or sent', async () => {
    for (const o of [{ from: null }, { replyTo: null }]) { const r = rig(o); const out = await go(r); assert.equal(out.ok, false); if (!out.ok) assert.equal(out.code, 'not_configured'); assert.deepEqual(r.calls, []); }
  });
  test('every refusal has a plain-English message', () => { for (const k of Object.keys(MESSAGE)) assert.ok(MESSAGE[k as keyof typeof MESSAGE].length > 12, k); });
});

describe('the double-send guard', () => {
  test('a refused reservation means no send, whatever the reason', async () => {
    for (const reason of ['send_in_progress', 'already_sent', 'not_ready']) {
      const r = rig({ claim: { ok: false, reason } }); const out = await go(r); assert.equal(out.ok, false); assert.ok(!r.calls.includes('send') && !r.calls.includes('markSent'), reason);
    }
  });
  test('two simultaneous requests: exactly ONE reaches the provider', async () => {
    let claimed = false; const sent: string[] = [];
    const mk = () => rig({ send: async () => { sent.push('x'); await new Promise((r) => setTimeout(r, 5)); return { id: 'pm-1' }; } });
    const a = mk(), b = mk();
    const claim = async () => { await Promise.resolve(); if (claimed) return { ok: false, reason: 'send_in_progress' } as never; claimed = true; return { ok: true } as never; };
    a.deps.claimSend = claim; b.deps.claimSend = claim;
    const [ra, rb] = await Promise.all([go(a), go(b)]);
    assert.equal(sent.length, 1); assert.equal([ra, rb].filter((x) => x.ok).length, 1);
    const loser = [ra, rb].find((x) => !x.ok)!; if (!loser.ok) assert.equal(loser.code, 'send_in_progress');
  });
});

describe('failures never become successes', () => {
  test('provider REFUSES: nothing recorded as sent, reservation released so a retry is safe', async () => {
    const r = rig({ send: async () => { throw new ProviderRejected('422'); } }); const out = await go(r);
    assert.equal(out.ok, false); if (!out.ok) assert.equal(out.code, 'provider_rejected');
    assert.deepEqual(r.calls, ['get', 'resolve', 'claim', 'send', 'release']); assert.ok(!r.calls.includes('markSent'));
  });
  test('provider outcome UNKNOWN (timeout / 5xx): NOT recorded as sent and the reservation is KEPT so a blind retry cannot double-send', async () => {
    const r = rig({ send: async () => { throw new ProviderUnknown('timeout'); } }); const out = await go(r);
    assert.equal(out.ok, false); if (!out.ok) { assert.equal(out.code, 'outcome_unknown'); assert.match(out.message, /NOT been recorded as sent/); }
    assert.ok(!r.calls.includes('markSent') && !r.calls.includes('release'));
  });
  test('an unexpected exception during the send is treated as UNKNOWN, never as failure-safe-to-retry', async () => {
    const r = rig({ send: async () => { throw new TypeError('boom'); } }); const out = await go(r);
    assert.equal(out.ok, false); if (!out.ok) assert.equal(out.code, 'outcome_unknown'); assert.ok(!r.calls.includes('release') && !r.calls.includes('markSent'));
  });
  test('a failing release does not mask the provider’s answer', async () => {
    const r = rig({ send: async () => { throw new ProviderRejected('x'); }, releaseThrows: true }); const out = await go(r);
    assert.equal(out.ok, false); if (!out.ok) assert.equal(out.code, 'provider_rejected');
  });
  test('sent but the first recording fails: retried once and reported as recorded', async () => {
    const r = rig({ markFails: 1 }); const out = await go(r);
    assert.equal(out.ok && out.recorded, true); assert.equal(r.calls.filter((c) => c === 'markSent').length, 2); assert.ok(!r.calls.includes('release'));
  });
  test('sent but recording fails twice: ok:true with recorded:false (the email HAS gone), reservation kept, never "failed"', async () => {
    const r = rig({ markFails: 5 }); const out = await go(r);
    assert.equal(out.ok, true); if (out.ok) assert.equal(out.recorded, false); assert.ok(!r.calls.includes('release'));
  });
});

describe('Reply-To and the sender', () => {
  test('Reply-To is the bare address of the sender, or an explicit override — never the display string', () => {
    assert.equal(addressOf(FROM), 'hello@oneshetland.com'); assert.equal(addressOf('hello@oneshetland.com'), 'hello@oneshetland.com'); assert.equal(addressOf('nope'), null);
    assert.equal(resolveReplyTo(FROM, undefined), 'hello@oneshetland.com'); assert.equal(resolveReplyTo(FROM, ''), 'hello@oneshetland.com');
    assert.equal(resolveReplyTo(FROM, 'Darren <darren@example.test>'), 'darren@example.test'); assert.equal(resolveReplyTo(null, null), null); assert.equal(resolveReplyTo('not an address', null), null);
  });
  test('only a well-formed sender is accepted (no silent substitution)', () => { assert.equal(validSender(FROM), FROM); assert.equal(validSender('nonsense'), null); assert.equal(validSender(''), null); assert.equal(validSender(undefined), null); });
});

describe('the Postmark request', () => {
  const msg: MailMessage = { from: FROM, replyTo: 'hello@oneshetland.com', to: 'recipient@example.test', subject: 'S', text: 'T', html: '<p>H</p>', metadata: { kind: 'launch_partner_invitation', campaign: 'zz' } };
  const KEY = 'pm-secret-key-should-never-leak';
  const fake = (status: number, body: unknown): { fn: FetchLike; calls: { url: string; init: Parameters<FetchLike>[1] }[] } => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    return { calls, fn: async (url, init) => { calls.push({ url, init }); return { ok: status >= 200 && status < 300, status, json: async () => body }; } };
  };
  test('tracking is OFF, link rewriting is OFF, the stream is transactional, Reply-To is bare', async () => {
    const f = fake(200, { MessageID: 'pm-1', ErrorCode: 0 }); const out = await postmarkSend(f.fn, KEY, msg);
    assert.equal(out.id, 'pm-1'); assert.equal(f.calls[0].url, POSTMARK_URL);
    const b = JSON.parse(f.calls[0].init.body);
    assert.equal(b.TrackOpens, false); assert.equal(b.TrackLinks, 'None'); assert.equal(b.MessageStream, 'outbound');
    assert.equal(b.From, FROM); assert.equal(b.ReplyTo, 'hello@oneshetland.com'); assert.equal(b.To, 'recipient@example.test');
    assert.deepEqual(Object.keys(b).sort(), ['From', 'HtmlBody', 'Metadata', 'MessageStream', 'ReplyTo', 'Subject', 'TextBody', 'To', 'TrackLinks', 'TrackOpens'].sort(), 'no unsubscribe, template, tag or bulk fields');
  });
  test('the API key is only ever a header: not in the body, not in any error', async () => {
    const f = fake(200, { MessageID: 'pm-1' }); await postmarkSend(f.fn, KEY, msg);
    assert.equal(f.calls[0].init.headers['X-Postmark-Server-Token'], KEY); assert.ok(!f.calls[0].init.body.includes(KEY));
    for (const [status, ctor] of [[422, ProviderRejected], [500, ProviderUnknown]] as const) {
      await assert.rejects(postmarkSend(fake(status, { ErrorCode: 300, Message: `bad ${KEY}` }).fn, KEY, msg), (e: Error) => e instanceof ctor && !e.message.includes(KEY));
    }
  });
  test('4xx = definitely refused; 5xx, unreadable answers, dropped connections and timeouts = unknown', async () => {
    await assert.rejects(postmarkSend(fake(422, { ErrorCode: 406 }).fn, KEY, msg), ProviderRejected);
    await assert.rejects(postmarkSend(fake(401, { ErrorCode: 10 }).fn, KEY, msg), ProviderRejected);
    await assert.rejects(postmarkSend(fake(500, {}).fn, KEY, msg), ProviderUnknown);
    await assert.rejects(postmarkSend(fake(200, {}).fn, KEY, msg), ProviderUnknown, '2xx without a MessageID is not an acceptance');
    await assert.rejects(postmarkSend((async () => { throw new Error('ECONNRESET'); }) as FetchLike, KEY, msg), ProviderUnknown);
    await assert.rejects(postmarkSend(((_u, init) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))))) as FetchLike, KEY, msg, 10), ProviderUnknown, 'a hung request times out as UNKNOWN');
  });
  test('the request body builder is exactly the fixed shape', () => { assert.equal(postmarkRequestBody(msg).TrackOpens, false); });
});

describe('the Edge Function entry point', () => {
  const src = read('../send-launch-invitation/index.ts');
  test('admin only, with the project’s rate limit, and no service-role key', () => {
    assert.match(src, /enforceRateLimit\('send-launch-invitation', userSubject\(user\.id\), \['email_send'\]/); assert.match(src, /me\?\.role !== 'admin'/);
    assert.doesNotMatch(src, /SERVICE_ROLE|service_role|createServiceClient/);
    assert.match(src, /sb\.auth\.getUser\(\)/);
  });
  test('the Postmark key and sender come only from Supabase secrets, and never reach a response or a log', () => {
    assert.match(src, /Deno\.env\.get\('POSTMARK_API_KEY'\)/); assert.match(src, /Deno\.env\.get\('LAUNCH_OUTREACH_FROM'\)/);
    assert.doesNotMatch(src, /console\.[a-z]+\([^)]*(apiKey|POSTMARK)/); assert.doesNotMatch(src, /json\([^)]*apiKey/);
    assert.doesNotMatch(src, /re_[A-Za-z0-9]{10,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.*POSTMARK/);
  });
  test('it is not a relay: the request has no recipient, subject, body or sender field', () => {
    assert.match(src, /Body: \{ campaign_id: uuid, invite_token: string, confirm:/);
    for (const k of ['body.to', 'body.subject', 'body.html', 'body.text', 'body.from', 'body.recipient', 'body.reply']) assert.ok(!src.includes(k), k);
  });
  test('every database call runs as the calling administrator', () => {
    for (const fn of ['admin_launch_partner_get', 'launch_invite_resolve', 'admin_launch_partner_claim_send', 'admin_launch_partner_release_send', 'admin_launch_partner_mark_sent']) assert.ok(src.includes(`'${fn}'`), fn);
    assert.equal((src.match(/createClient\(/g) ?? []).length, 1);
  });
});

describe('parity with the web renderer (golden vectors shared by both repos)', () => {
  const golden = JSON.parse(read('./launch-invitation-email.golden.json'));
  for (const r of golden.renders) test(`render: ${r.name}`, () => { assert.deepEqual(renderInvitationEmail(r.input), r.expected); });
  for (const c of golden.checks) test(`check: ${c.name}`, () => { assert.deepEqual(checkEmail(c.input), c.expected); });
  for (const g of golden.gates) test(`gates: ${g.name}`, () => {
    const i = g.input;
    const f = facts({ stage: i.stage, sentAt: i.sentAt, contactEmail: i.contactEmail, subject: i.subject, opening: i.opening, body: i.body, invitation: { status: i.invitationStatus, expiresAt: i.expiresAt } });
    const got = evaluateGates(f, i.tokenValid, i.confirm, new Date(g.nowIso));
    assert.deepEqual([...got].sort(), g.expected);
  });
});
