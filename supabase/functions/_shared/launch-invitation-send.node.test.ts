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
  launchInvitationSend, evaluateGates, resolveReplyTo, validSender, validMessageStream, SHARED_STREAMS, addressOf, MESSAGE, ProviderRejected, ProviderUnknown,
  type CampaignFacts, type SendDeps, type MailMessage,
} from './launch-invitation-send.ts';
import { renderInvitationEmail, checkEmail, CTA_LABEL, CTA_FALLBACK_LINE, EMAIL_LOGO_URL, OUTREACH_OPT_OUT, OUTREACH_IDENTITY, OUTREACH_CONTACT, OUTREACH_COMPANY_NAME, OUTREACH_REGISTRATION, OUTREACH_OFFICE, INVITE_DEFAULT_DAYS, expiryLine } from './launch-invitation-email.ts';
import { postmarkSend, postmarkRequestBody, POSTMARK_URL, type FetchLike } from './launch-invitation-postmark.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string) => readFileSync(here(p), 'utf8');

const TOKEN = '7f3a9c1e5b2d4f60a8c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1';
const CID = '0d38887b-8e0f-4aa6-b5c3-3a41abb38fd6';
const BIZ = 'fdda4cbe-1e28-4f4d-89d8-aed8317be513';
const FROM = 'OneShetland <hello@oneshetland.com>';
/** The dedicated Launch Partner Postmark stream used throughout these tests. It is configuration (LAUNCH_OUTREACH_MESSAGE_STREAM), never a default. */
const STREAM = 'launch-partners';
const OPENING = 'You make something genuinely Shetland, and I think more locals and visitors should be able to find what you do easily.';
const BODY = ['Hello,', '', "I’m Darren, and I’m getting ready to launch OneShetland.", '', '{{PERSONALISED_OPENING}}', '', '{{INVITATION_CTA}}', '', 'Darren'].join('\n');
const future = new Date(Date.now() + 7 * 864e5).toISOString();

const facts = (o: Partial<CampaignFacts> = {}): CampaignFacts => ({
  id: CID, slug: 'zz-launch-email-test', businessId: BIZ, businessName: 'ZZ TEST', stage: 'ready_to_invite', sentAt: null,
  contactEmail: 'recipient@example.test', subject: 'I’ve made a private OneShetland preview for ZZ TEST', opening: OPENING, body: BODY,
  invitation: { status: 'open', expiresAt: future }, ...o,
});
const confirm = (f = facts()) => ({ confirm: true, recipient: f.contactEmail!, subject: f.subject! });

function rig(over: Partial<{ facts: CampaignFacts | null; tokenBiz: string | null; claim: unknown; send: (m: MailMessage) => Promise<{ id: string }>; markFails: number; releaseThrows: boolean; from: string | null; replyTo: string | null; messageStream: string | null }> = {}) {
  const calls: string[] = [];
  const sent: MailMessage[] = [];
  let markFails = over.markFails ?? 0;
  const deps: SendDeps = {
    origin: 'https://oneshetland.com', from: over.from === undefined ? FROM : over.from, replyTo: over.replyTo === undefined ? 'hello@oneshetland.com' : over.replyTo, messageStream: over.messageStream === undefined ? STREAM : over.messageStream, now: () => new Date(),
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
  const msg: MailMessage = { from: FROM, replyTo: 'hello@oneshetland.com', to: 'recipient@example.test', subject: 'S', text: 'T', html: '<p>H</p>', metadata: { kind: 'launch_partner_invitation', campaign: 'zz' }, messageStream: STREAM };
  const KEY = 'pm-secret-key-should-never-leak';
  const fake = (status: number, body: unknown): { fn: FetchLike; calls: { url: string; init: Parameters<FetchLike>[1] }[] } => {
    const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
    return { calls, fn: async (url, init) => { calls.push({ url, init }); return { ok: status >= 200 && status < 300, status, json: async () => body }; } };
  };
  test('tracking is OFF, link rewriting is OFF, the stream is the dedicated launch stream, Reply-To is bare', async () => {
    const f = fake(200, { MessageID: 'pm-1', ErrorCode: 0 }); const out = await postmarkSend(f.fn, KEY, msg);
    assert.equal(out.id, 'pm-1'); assert.equal(f.calls[0].url, POSTMARK_URL);
    const b = JSON.parse(f.calls[0].init.body);
    assert.equal(b.TrackOpens, false); assert.equal(b.TrackLinks, 'None'); assert.equal(b.MessageStream, STREAM);
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
    const f = facts({ stage: i.stage, sentAt: i.sentAt, contactEmail: i.contactEmail, subject: i.subject, opening: i.opening, body: i.body, invitation: { status: i.invitationStatus, expiresAt: i.expiresAt }, outreachStopped: i.outreachStopped === true });
    const got = evaluateGates(f, i.tokenValid, i.confirm, new Date(g.nowIso));
    assert.deepEqual([...got].sort(), g.expected);
  });
});

describe('sender: OneShetland <hello@oneshetland.com>', () => {
  const NEW_FROM = 'OneShetland <hello@oneshetland.com>';
  test('the configured sender resolves to that exact display name and the SAME address; Reply-To stays the bare address', () => {
    assert.equal(FROM, NEW_FROM);
    assert.equal(validSender(NEW_FROM), NEW_FROM); assert.equal(addressOf(NEW_FROM), 'hello@oneshetland.com');
    assert.equal(resolveReplyTo(NEW_FROM, undefined), 'hello@oneshetland.com'); assert.doesNotMatch(NEW_FROM, /Darren|·/);
  });
  test('a send uses that From and that Reply-To end to end, and the provider request keeps tracking OFF', async () => {
    const r = rig({ from: NEW_FROM }); await go(r); const m = r.sent[0];
    assert.equal(m.from, NEW_FROM); assert.equal(m.replyTo, 'hello@oneshetland.com');
    const b = postmarkRequestBody(m); assert.equal(b.From, NEW_FROM); assert.equal(b.ReplyTo, 'hello@oneshetland.com');
    assert.equal(b.TrackOpens, false); assert.equal(b.TrackLinks, 'None'); assert.equal(b.MessageStream, STREAM);
  });
  test('the function’s own documentation names the new sender, not the old one', () => {
    const src = read('../send-launch-invitation/index.ts'); assert.ok(src.includes('"OneShetland <hello@oneshetland.com>"')); assert.ok(!src.includes('Darren Fullerton ·'));
  });
});

describe('the email carries light OneShetland branding and nothing else changed', () => {
  const LINK = `https://oneshetland.com/launch/zz-launch-email-test?invite=${TOKEN}`;
  const input = { subject: 'S', body: BODY, opening: OPENING, businessName: 'ZZ TEST', invitationUrl: LINK };
  const out = renderInvitationEmail(input);
  test('the header is the live site’s mark (resized copy of logo-mark-keyed.png) plus the name as real text, first in the card', () => {
    assert.equal(EMAIL_LOGO_URL, 'https://oneshetland.com/brand/email/logo-mark-120.png');
    assert.ok(out.html.includes(`<img src="${EMAIL_LOGO_URL}" width="40" height="40" alt="OneShetland"`));
    assert.match(out.html, />OneShetland<\/td>/, 'the name is text, so it survives blocked images');
    assert.ok(out.html.indexOf(EMAIL_LOGO_URL) < out.html.indexOf('Hello,'), 'header above the message');
  });
  test('the logo is a bare image on our own domain: no link, no query string, no second image, no tracking pixel', () => {
    assert.ok(!/\?/.test(EMAIL_LOGO_URL)); assert.equal((out.html.match(/<img /g) ?? []).length, 1);
    assert.equal((out.html.match(/<a /g) ?? []).length, 1, 'the only link is the invitation button');
  });
  test('message, opening position and invitation CTA are intact', () => {
    const iHello = out.html.indexOf('Hello,'), iOpening = out.html.indexOf(OPENING), iBtn = out.html.indexOf(CTA_LABEL), iSign = out.html.lastIndexOf('Darren');
    assert.ok(iHello > 0 && iHello < iOpening && iOpening < iBtn && iBtn < iSign, 'order: greeting, opening, button, sign-off');
    assert.ok(out.html.includes(`href="${LINK}"`)); assert.equal(out.html.split(LINK).length - 1, 2, 'button href + fallback text only');
    assert.equal(out.hasInvitation, true);
  });
  test('the plain-text version is untouched by the branding: no markup, no logo, same words, link present', () => {
    assert.ok(!/<|>/.test(out.text.replace(/→/g, ''))); assert.ok(!out.text.includes(EMAIL_LOGO_URL) && !/<img/i.test(out.text));
    const wanted = BODY.replace('{{PERSONALISED_OPENING}}', OPENING).replace('{{INVITATION_CTA}}', `View your private preview: ${LINK}\n${expiryLine(null)}`);
    assert.equal(out.text, `${wanted}\n\n--\n${OUTREACH_IDENTITY}\n${OUTREACH_REGISTRATION}\n${OUTREACH_OFFICE}\n${OUTREACH_CONTACT}\n\n${OUTREACH_OPT_OUT}\n`, 'the words are the draft\'s own, then the quiet company disclosure and the opt-out line');
  });
  test('no marketing furniture: no unsubscribe, footer, banner or tracking pixel', () => {
    assert.doesNotMatch(out.html.toLowerCase(), /unsubscribe|manage preferences|view in browser|newsletter|pixel|track/);
  });
});


/* ═══ Launch Partner outreach safeguards: do not contact, identity, opt-out ═══════════════════════════════════════════ */
const NOTE = 'INTERNAL-NOTE-MARKER-31b9';
describe('do not contact — the send is refused SERVER-SIDE, before the mail provider is touched', () => {
  test('1 · a normal business (not stopped) can send', async () => {
    const r = rig(); assert.equal((await go(r)).ok, true); assert.equal(r.sent.length, 1);
  });
  test('2 · a business whose outreach is stopped is refused at the gates: nothing reserved, nothing sent, nothing recorded as sent', async () => {
    const r = rig({ facts: facts({ outreachStopped: true }) }); const out = await go(r);
    assert.equal(out.ok, false); assert.equal((out as { code: string }).code, 'do_not_contact');
    assert.deepEqual(r.calls, ['get', 'resolve'], 'it stopped before claim, send and markSent'); assert.equal(r.sent.length, 0);
  });
  test('3 · a suppressed ADDRESS/contact is treated the same (the database reports it through the same flag, whichever scope matched)', async () => {
    const r = rig({ facts: facts({ outreachStopped: true, contactEmail: 'someone-who-opted-out@example.test' }) });
    assert.equal(((await go(r)) as { code: string }).code, 'do_not_contact'); assert.equal(r.sent.length, 0);
  });
  test('4 · STALE page/facts: the read said "not stopped", but the database refuses the reservation — still no email, no record, and the right explanation', async () => {
    const r = rig({ claim: { ok: false, reason: 'do_not_contact' } }); const out = await go(r) as { ok: boolean; code: string; message: string };
    assert.equal(out.ok, false); assert.equal(out.code, 'do_not_contact'); assert.deepEqual(r.calls, ['get', 'resolve', 'claim']); assert.equal(r.sent.length, 0);
    assert.equal(out.message, MESSAGE.do_not_contact);
  });
  test('5 · NO Postmark request is made: driven through the real Postmark client with a counting fake fetch', async () => {
    let requests = 0; const fetchFn: FetchLike = async () => { requests++; return { ok: true, status: 200, json: async () => ({ MessageID: 'x' }) }; };
    for (const over of [{ facts: facts({ outreachStopped: true }) }, { claim: { ok: false, reason: 'do_not_contact' } }]) {
      const r = rig({ ...over, send: undefined }); r.deps.send = (m) => postmarkSend(fetchFn, 'token', m);
      assert.equal(((await go(r)) as { code: string }).code, 'do_not_contact');
    }
    assert.equal(requests, 0, 'the provider was never called');
  });
  test('6 · no false "sent" state: markSent and releaseSend are never called for a refused send', async () => {
    for (const over of [{ facts: facts({ outreachStopped: true }) }, { claim: { ok: false, reason: 'do_not_contact' } }]) {
      const r = rig(over); await go(r); assert.ok(!r.calls.includes('markSent') && !r.calls.includes('send'), r.calls.join());
    }
  });
  test('the refusal outranks every other problem and never mentions the reason or any internal note', () => {
    const g = evaluateGates(facts({ outreachStopped: true, stage: 'preparing', contactEmail: null }), false, null, new Date());
    assert.equal(g[0], 'do_not_contact'); assert.ok(g.length > 1);
    assert.doesNotMatch(MESSAGE.do_not_contact, /requested|complaint|bounce|note|reason/i); assert.doesNotMatch(NOTE + MESSAGE.do_not_contact, /INTERNAL-NOTE.*(?:requested|complaint)/);
  });
  test('the function reads the flag from the database and nothing from the request: index.ts maps the campaign\'s outreach field, and the request has no suppression input', () => {
    const idx = read('../send-launch-invitation/index.ts');
    assert.match(idx, /outreachStopped: !!c\.outreach/); assert.match(idx, /'do_not_contact'/);
    assert.doesNotMatch(idx, /body\.(outreach|suppress|override|skip|force)/i);
    assert.match(idx, /admin_launch_partner_get/);
  });
  test('an inactive recipient (the provider already suppresses it after a bounce or complaint) is explained plainly, released, and not recorded as sent', async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 422, json: async () => ({ ErrorCode: 406, Message: 'inactive' }) });
    const r = rig(); r.deps.send = (m) => postmarkSend(fetchFn, 'token', m); const out = await go(r) as { code: string; message: string };
    assert.equal(out.code, 'recipient_inactive'); assert.deepEqual(r.calls, ['get', 'resolve', 'claim', 'release']); assert.match(out.message, /inactive.*do not contact/i);
    const other: FetchLike = async () => ({ ok: false, status: 422, json: async () => ({ ErrorCode: 300, Message: 'invalid' }) });
    const r2 = rig(); r2.deps.send = (m) => postmarkSend(other, 'token', m); assert.equal(((await go(r2)) as { code: string }).code, 'provider_rejected');
  });
});

describe('every outreach email carries the identity and opt-out lines', () => {
  const link = `https://oneshetland.com/launch/zz?invite=${TOKEN}`;
  const variants: [string, Parameters<typeof renderInvitationEmail>[0]][] = [
    ['the default draft with a real link', { subject: 's', body: BODY, opening: OPENING, businessName: 'ZZ', invitationUrl: link }],
    ['a hand-edited draft that dropped any sign-off', { subject: 's', body: 'Hi.\n\n{{INVITATION_CTA}}', invitationUrl: link }],
    ['an OLDER saved draft from before this feature', { subject: 's', body: 'Old text\n\n{{INVITATION_LINK}}\n\nDarren', invitationUrl: link }],
    ['a preview with no invitation yet', { subject: 's', body: BODY, opening: OPENING, businessName: 'ZZ' }],
    ['hostile text in the draft', { subject: '<b>x</b>', body: '<script>1</script>\n\n{{INVITATION_CTA}}', invitationUrl: link }],
  ];
  for (const [name, input] of variants) {
    test(`11/12/13 · ${name}: the opt-out line and the identity line + contact are in BOTH the HTML and the plain text`, () => {
      const out = renderInvitationEmail(input);
      for (const part of [OUTREACH_OPT_OUT, OUTREACH_IDENTITY, OUTREACH_COMPANY_NAME, OUTREACH_REGISTRATION, OUTREACH_OFFICE, OUTREACH_CONTACT, '15480428', 'England and Wales', '155A Tottenham Lane']) { assert.ok(out.text.includes(part), `text: ${part}`); assert.ok(out.html.includes(part.replace(/&/g, '&amp;')), `html: ${part}`); }
      assert.ok(out.text.trimEnd().endsWith(OUTREACH_OPT_OUT), 'the opt-out line is the last thing');
    });
  }
  test('the exact wording, and the particulars as the Companies House record holds them (company 15480428)', () => {
    assert.equal(OUTREACH_OPT_OUT, 'If you’d rather not receive another Launch Partner invitation from us, just reply and let us know.');
    assert.equal(OUTREACH_COMPANY_NAME, 'Darren Fullerton Consultancy Ltd'); assert.equal(OUTREACH_IDENTITY, 'OneShetland is operated by Darren Fullerton Consultancy Ltd.');
    assert.equal(OUTREACH_REGISTRATION, 'Registered in England and Wales · Company No. 15480428');
    assert.equal(OUTREACH_OFFICE, 'Registered office: 155A Tottenham Lane, London, N8 9BT'); assert.equal(OUTREACH_CONTACT, 'hello@oneshetland.com');
  });
  test('statutory particulars: registered name, place of registration, number and registered office are each present, EXACTLY once, in both versions — the trading address is not used', () => {
    const out = renderInvitationEmail({ subject: 's', body: BODY, opening: OPENING, businessName: 'ZZ', invitationUrl: link });
    for (const v of [out.text, out.html]) {
      for (const part of ['Darren Fullerton Consultancy Ltd', 'England and Wales', '15480428', '155A Tottenham Lane, London, N8 9BT']) assert.equal(v.split(part).length - 1, 1, `${part} appears once`);
      assert.doesNotMatch(v, /Burra|Hamnavoe|ZE2/, 'the registered office is the London address; Burra is only a trading address');
    }
  });
  test('the disclosure is RENDERER-ENFORCED: a draft that tries to remove it, replace it or carry its own different details cannot change what is added', () => {
    const tamper = ['No footer here.\n\n{{INVITATION_CTA}}', 'Registered in Scotland · Company No. SC000000\n\n{{INVITATION_CTA}}', '{{INVITATION_CTA}}\n\n--'];
    for (const body of tamper) { const out = renderInvitationEmail({ subject: 's', body, invitationUrl: link }); for (const part of [OUTREACH_REGISTRATION, OUTREACH_OFFICE, OUTREACH_IDENTITY, OUTREACH_OPT_OUT]) { assert.ok(out.text.includes(part) && out.html.includes(part), part); } }
    assert.ok(![...tamper.slice(0, 1)].some((b) => b.includes('15480428')), 'and the stored default template does not carry it, so there is nothing in a draft to edit away');
  });
  test('it is quiet: small grey text after a hairline; no link, image, unsubscribe URL, banner or promotional copy was added by the footer', () => {
    const out = renderInvitationEmail({ subject: 's', body: BODY, opening: OPENING, businessName: 'ZZ', invitationUrl: link });
    const footer = out.html.slice(out.html.lastIndexOf('<div style="margin:22px 0 8px'));
    assert.match(footer, /font-size:12px/); assert.doesNotMatch(footer, /<a |<img|href=|unsubscribe|newsletter|sale|offer|discount|follow us/i);
    assert.equal((out.html.match(/<a /g) ?? []).length, 1, 'the only link in the whole email is still the private-preview button');
    assert.equal((out.html.match(/<img /g) ?? []).length, 1, 'and the only image is still the header mark');
  });
  test('the reply route is real: Reply-To is the bare hello@ address, so "just reply" reaches a monitored mailbox', () => {
    assert.equal(resolveReplyTo(FROM, undefined), 'hello@oneshetland.com'); assert.equal(OUTREACH_CONTACT, addressOf(FROM));
  });
});

describe('what has NOT changed: sender, Reply-To, tracking, the provider request', () => {
  test('14/15 · a send goes out From "OneShetland <hello@oneshetland.com>" with Reply-To hello@oneshetland.com', async () => {
    const r = rig(); await go(r); assert.equal(r.sent[0].from, 'OneShetland <hello@oneshetland.com>'); assert.equal(r.sent[0].replyTo, 'hello@oneshetland.com');
    assert.ok(r.sent[0].text.includes(OUTREACH_OPT_OUT) && r.sent[0].html.includes(OUTREACH_IDENTITY), 'and the email that actually goes to the provider has the lines');
  });
  test('16/17 · open tracking OFF, link tracking OFF, the DEDICATED stream, metadata without link/token/recipient; no extra provider fields', async () => {
    const r = rig(); await go(r); const b = postmarkRequestBody(r.sent[0]) as Record<string, unknown>;
    assert.equal(b.TrackOpens, false); assert.equal(b.TrackLinks, 'None'); assert.equal(b.MessageStream, STREAM); assert.equal(b.From, 'OneShetland <hello@oneshetland.com>'); assert.equal(b.ReplyTo, 'hello@oneshetland.com');
    assert.deepEqual(Object.keys(b).sort(), ['From', 'HtmlBody', 'Metadata', 'MessageStream', 'ReplyTo', 'Subject', 'TextBody', 'To', 'TrackLinks', 'TrackOpens'].sort());
    assert.doesNotMatch(JSON.stringify(b.Metadata), /invite=|recipient|@/);
  });
  test('18 · transactional email is a different code path and knows nothing about outreach suppression', () => {
    for (const f of ['./send-email.ts', './refund-notice.ts', './ticket-receipt.ts', '../request-password-reset/index.ts']) { let t = ''; try { t = read(f); } catch { continue; } assert.doesNotMatch(t, /outreach|do_not_contact|launch_outreach|admin_launch_partner/i, f); }
  });
  test('19 · every pre-existing behaviour still holds: already sent, not ready, in progress, provider refused, unknown outcome', async () => {
    assert.equal(((await go(rig({ facts: facts({ sentAt: new Date().toISOString() }) }))) as { code: string }).code, 'already_sent');
    assert.equal(((await go(rig({ facts: facts({ stage: 'preparing' }) }))) as { code: string }).code, 'not_ready');
    assert.equal(((await go(rig({ claim: { ok: false, reason: 'send_in_progress' } }))) as { code: string }).code, 'send_in_progress');
    assert.equal(((await go(rig({ send: async () => { throw new ProviderRejected('no'); } }))) as { code: string }).code, 'provider_rejected');
    assert.equal(((await go(rig({ send: async () => { throw new ProviderUnknown('?'); } }))) as { code: string }).code, 'outcome_unknown');
  });
});


/* ═══ Invitation links: ONE canonical lifetime, stated in the email by the RENDERER ═══════════════════════════════════ */
describe('the invitation email states how long the link lasts', () => {
  const link = `https://oneshetland.com/launch/zz?invite=${TOKEN}`;
  const EXP = '2026-11-05T19:50:17.506Z';
  const sentence = (v: string) => (/Your private invitation link is available [^\n<]*?\./.exec(v) ?? [''])[0];
  test('17 · the canonical lifetime is 30 days, and the wording is natural: "available until <date>" for a real invitation, "for 30 days" before one exists', () => {
    assert.equal(INVITE_DEFAULT_DAYS, 30);
    assert.equal(expiryLine(EXP), 'Your private invitation link is available until 5 November 2026.');
    assert.equal(expiryLine(null), 'Your private invitation link is available for 30 days.'); assert.equal(expiryLine('not a date'), expiryLine(null));
  });
  test('the date is the London date: 23:30 UTC in summer time is already the next day', () => { assert.equal(expiryLine('2026-10-06T23:30:00.000Z'), 'Your private invitation link is available until 7 October 2026.'); });
  test('18 · the HTML and the plain text carry the SAME sentence, once each, next to the link', () => {
    const out = renderInvitationEmail({ subject: 's', body: BODY, opening: OPENING, businessName: 'ZZ', invitationUrl: link, invitationExpiresAt: EXP });
    assert.equal(sentence(out.text), expiryLine(EXP)); assert.equal(sentence(out.html), expiryLine(EXP));
    for (const v of [out.text, out.html]) assert.equal(v.split('Your private invitation link is available').length - 1, 1);
    assert.ok(out.text.indexOf(link) < out.text.indexOf('Your private invitation link is available') && out.html.indexOf(link) < out.html.indexOf('Your private invitation link is available'));
  });
  test('it is renderer-enforced: a draft cannot remove it, and a draft that claims a different lifetime cannot change what the renderer says', () => {
    const own = renderInvitationEmail({ subject: 's', body: 'Valid for 90 days, honest.\n\n{{INVITATION_CTA}}', invitationUrl: link, invitationExpiresAt: EXP });
    assert.equal(sentence(own.text), expiryLine(EXP)); assert.equal(sentence(own.html), expiryLine(EXP));
    for (const body of ['Hi.\n\n{{INVITATION_CTA}}', 'Old.\n\n{{INVITATION_LINK}}\n\nDarren']) assert.ok(renderInvitationEmail({ subject: 's', body, invitationUrl: link, invitationExpiresAt: EXP }).text.includes(expiryLine(EXP)));
  });
  test('a real send states that invitation\'s own expiry, read from the database — not a number typed into the draft', async () => {
    const r = rig({ facts: facts({ invitation: { status: 'open', expiresAt: '2026-12-01T12:00:00.000Z' } }) }); await go(r);
    assert.ok(r.sent[0].text.includes('Your private invitation link is available until 1 December 2026.') && r.sent[0].html.includes('Your private invitation link is available until 1 December 2026.'));
  });
  test('19/20 · the I3 company disclosure and the opt-out wording are still there, in order, after the expiry line', async () => {
    const r = rig(); await go(r); const t = r.sent[0].text;
    for (const part of [OUTREACH_IDENTITY, OUTREACH_REGISTRATION, OUTREACH_OFFICE, OUTREACH_CONTACT, OUTREACH_OPT_OUT]) { assert.ok(t.includes(part), part); assert.ok(r.sent[0].html.includes(part)); }
    assert.ok(t.indexOf('Your private invitation link is available') < t.indexOf(OUTREACH_IDENTITY) && t.indexOf(OUTREACH_IDENTITY) < t.indexOf(OUTREACH_OPT_OUT));
  });
  test('21 · the do-not-contact gate and the sender/tracking settings are unaffected', async () => {
    assert.equal(((await go(rig({ facts: facts({ outreachStopped: true }) }))) as { code: string }).code, 'do_not_contact');
    const r = rig(); await go(r); const b = postmarkRequestBody(r.sent[0]) as Record<string, unknown>;
    assert.equal(b.From, 'OneShetland <hello@oneshetland.com>'); assert.equal(b.ReplyTo, 'hello@oneshetland.com'); assert.equal(b.TrackOpens, false); assert.equal(b.TrackLinks, 'None');
  });
  test('the function\'s own lifetime wording agrees with the database migration (30 days) and not the old 45', () => {
    const mig = readFileSync(here('../../migrations/20261114000000_launch_invite_default_30_days.sql'), 'utf8');
    assert.match(mig, /default \(now\(\) \+ interval '30 days'\)/); assert.doesNotMatch(mig.replace(/--.*$/gm, ''), /45 days/);
  });
});


/* ═══ I2 — Launch Partner outreach has a DEDICATED Postmark stream; it fails closed and never falls back to the transactional one ═══════════ */
describe('the dedicated Launch Partner stream', () => {
  const postmarkRefuses = (errorCode: number) => async () => { throw new ProviderRejected('refused', errorCode); };
  test('1 · every launch email goes out on the configured dedicated stream, and the request body carries exactly that', async () => {
    const r = rig(); await go(r); assert.equal(r.sent[0].messageStream, STREAM);
    assert.equal((postmarkRequestBody(r.sent[0]) as Record<string, unknown>).MessageStream, STREAM);
  });
  test('2 · it NEVER uses the transactional (or any shared) stream: the shared names are refused as configuration, and no send path names one', async () => {
    for (const bad of ['outbound', 'broadcast', 'broadcasts', 'inbound', ' OUTBOUND ', 'Outbound']) assert.equal(validMessageStream(bad), null, bad);
    for (const name of SHARED_STREAMS) { const r = rig({ messageStream: name }); const out = await go(r) as { code: string }; assert.equal(out.code, 'stream_not_configured', name); assert.equal(r.sent.length, 0); }
    for (const f of ['./launch-invitation-send.ts', './launch-invitation-postmark.ts', '../send-launch-invitation/index.ts']) assert.doesNotMatch(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), /MessageStream\s*:\s*['"]/, `${f} has no literal stream`);
  });
  test('3 · a valid configuration is accepted (lowercase letters, digits and dashes); anything else is not', () => {
    for (const ok of ['launch-partners', 'launch-outreach', 'launch-partners-2']) assert.equal(validMessageStream(ok), ok);
    for (const bad of [null, undefined, '', '   ', 'ab', 'Launch Partners', 'launch_partners', '-launch', 'launch/partners', 'x'.repeat(60), "launch'; drop"]) assert.equal(validMessageStream(bad as never), null, String(bad));
  });
  test('4 · MISSING or invalid stream configuration FAILS CLOSED: nothing is read, reserved, sent or recorded, and the admin is told exactly why', async () => {
    for (const messageStream of [null, '', 'outbound']) {
      const r = rig({ messageStream }); const out = await go(r) as { ok: boolean; code: string; message: string };
      assert.equal(out.ok, false); assert.equal(out.code, 'stream_not_configured'); assert.deepEqual(r.calls, [], 'no database call and no provider call at all'); assert.equal(r.sent.length, 0);
      assert.match(out.message, /no dedicated mail stream.*nothing was sent.*not fall back to the everyday email stream/i);
    }
  });
  test('4b · through the REAL Postmark client with a counting fake fetch: a missing stream means zero provider requests', async () => {
    let requests = 0; const fetchFn: FetchLike = async () => { requests++; return { ok: true, status: 200, json: async () => ({ MessageID: 'x' }) }; };
    const r = rig({ messageStream: null }); r.deps.send = (m) => postmarkSend(fetchFn, 'token', m); await go(r); assert.equal(requests, 0);
  });
  test('4c · the Edge Function reads the setting from the environment only, validates it, and passes null when it is not usable', () => {
    const idx = read('../send-launch-invitation/index.ts');
    assert.match(idx, /const messageStream = validMessageStream\(Deno\.env\.get\('LAUNCH_OUTREACH_MESSAGE_STREAM'\)\);/); assert.match(idx, /\n      messageStream,/);
    assert.doesNotMatch(idx, /body\.(stream|messageStream|message_stream)/i, 'a request cannot choose the stream');
  });
  test('5 · Postmark saying the stream does not exist (1235) or cannot send (1236): no false "sent", the reservation is released, and the admin gets a useful message', async () => {
    for (const [code, expected, rx] of [[1235, 'stream_missing', /does not exist on this server.*Create it in Postmark/i], [1236, 'stream_type_unsupported', /wrong stream type/i]] as const) {
      const r = rig({ send: postmarkRefuses(code) }); const out = await go(r) as { ok: boolean; code: string; message: string };
      assert.equal(out.ok, false); assert.equal(out.code, expected); assert.match(out.message, rx);
      assert.deepEqual(r.calls, ['get', 'resolve', 'claim', 'send', 'release']); assert.ok(!r.calls.includes('markSent'), 'never recorded as sent');
    }
  });
  test('5b · through the real client: a 422 with ErrorCode 1235 becomes stream_missing; 1236 stream_type_unsupported; 406 stays recipient_inactive; anything else stays provider_rejected', async () => {
    const via = (code: number): FetchLike => async () => ({ ok: false, status: 422, json: async () => ({ ErrorCode: code, Message: 'x' }) });
    for (const [code, expected] of [[1235, 'stream_missing'], [1236, 'stream_type_unsupported'], [406, 'recipient_inactive'], [300, 'provider_rejected']] as const) {
      const r = rig(); r.deps.send = (m) => postmarkSend(via(code), 'token', m); assert.equal(((await go(r)) as { code: string }).code, expected, String(code));
    }
  });
  test('6/7 · suppression still fails BEFORE Postmark, and a stale page cannot bypass it — on the dedicated stream exactly as before', async () => {
    let requests = 0; const fetchFn: FetchLike = async () => { requests++; return { ok: true, status: 200, json: async () => ({ MessageID: 'x' }) }; };
    for (const over of [{ facts: facts({ outreachStopped: true }) }, { claim: { ok: false, reason: 'do_not_contact' } }]) { const r = rig(over); r.deps.send = (m) => postmarkSend(fetchFn, 'token', m); assert.equal(((await go(r)) as { code: string }).code, 'do_not_contact'); assert.ok(!r.calls.includes('send')); }
    assert.equal(requests, 0);
  });
  test('8–13 · sender, Reply-To, tracking, company disclosure, opt-out and expiry wording are all unchanged', async () => {
    const r = rig(); await go(r); const m = r.sent[0]; const b = postmarkRequestBody(m) as Record<string, unknown>;
    assert.equal(b.From, 'OneShetland <hello@oneshetland.com>'); assert.equal(b.ReplyTo, 'hello@oneshetland.com'); assert.equal(b.TrackOpens, false); assert.equal(b.TrackLinks, 'None');
    for (const part of [OUTREACH_IDENTITY, OUTREACH_REGISTRATION, OUTREACH_OFFICE, OUTREACH_CONTACT, OUTREACH_OPT_OUT]) { assert.ok(m.text.includes(part) && m.html.includes(part), part); }
    assert.match(m.text, /Your private invitation link is available until \d+ \w+ \d{4}\./); assert.match(m.html, /Your private invitation link is available until \d+ \w+ \d{4}\./);
    assert.deepEqual(Object.keys(b).sort(), ['From', 'HtmlBody', 'Metadata', 'MessageStream', 'ReplyTo', 'Subject', 'TextBody', 'To', 'TrackLinks', 'TrackOpens'].sort());
  });
  test('14/15 · transactional email is a different code path and is UNCHANGED: send-email.ts still takes its stream from the template (default outbound), hub-broadcast keeps its own, and none knows the launch setting', () => {
    const se = read('./send-email.ts'); assert.match(se, /const stream = tmpl\.postmark_stream \?\? 'outbound';/); assert.match(se, /MessageStream: stream,/);
    for (const f of ['./send-email.ts', './refund-notice.ts', './ticket-receipt.ts', '../request-password-reset/index.ts', '../hub-broadcast/index.ts', '../stripe-webhook/index.ts']) { let t = ''; try { t = read(f); } catch { continue; } assert.doesNotMatch(t, /LAUNCH_OUTREACH|launch-invitation|validMessageStream/, f); }
    assert.match(read('../hub-broadcast/index.ts'), /MessageStream: 'outbound'/, 'untouched by this change');
  });
  test('only the launch function reads the launch stream setting', () => {
    const hits = ['../send-launch-invitation/index.ts', '../request-password-reset/index.ts', '../hub-broadcast/index.ts', './send-email.ts'].filter((f) => { try { return /LAUNCH_OUTREACH_MESSAGE_STREAM/.test(read(f).replace(/\/\*[\s\S]*?\*\//g, '')); } catch { return false; } });
    assert.deepEqual(hits, ['../send-launch-invitation/index.ts']);
  });
});
