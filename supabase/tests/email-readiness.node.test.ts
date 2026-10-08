/**
 * email-readiness.node.test.ts
 *
 * notifications-email: production email is launch-ready only if (a) a customer-facing email carries the
 * right identity and only production links, (b) a hostile or merely careless input cannot turn a genuine
 * OneShetland email against its reader, and (c) a failed send is recorded and can never undo the thing it
 * was reporting. Real source runs here against fakes (Supabase, Postmark's HTTP API, env) — nothing is
 * sent, fetched from the network or written anywhere.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadModule, readRepo, REPO_ROOT } from './_support/load-source.ts';

/* ── shared fakes ────────────────────────────────────────────────────────── */

type Row = Record<string, any>;
let env: Record<string, string | undefined>;
let logRows: Row[];
let postmarkCalls: Row[];
let postmarkReply: { status: number; body: Row } | 'throw';

function installGlobals() {
  (globalThis as any).Deno = { env: { get: (k: string) => env[k] } };
  (globalThis as any).fetch = async (url: string, init: any) => {
    assert.equal(url, 'https://api.postmarkapp.com/email', 'only ever talks to Postmark');
    postmarkCalls.push({ headers: init.headers, body: JSON.parse(init.body) });
    if (postmarkReply === 'throw') throw new Error('network down');
    return { ok: postmarkReply.status < 400, status: postmarkReply.status, json: async () => postmarkReply.body };
  };
}

const SETTINGS = {
  from_name: 'OneShetland', from_email: 'orders@oneshetland.com', reply_to: 'hello@oneshetland.com',
  footer_sign_off: 'Thanks,', footer_signature: 'The OneShetland Team',
  footer_tagline: 'Everything Shetland, All in One Place', footer_legal: 'OneShetland · A Darren Fullerton Consultancy Ltd platform',
};

function fakeSupabase(template: Row | null, settings: Row | null = SETTINGS, opts: { logThrows?: boolean } = {}) {
  return {
    from(table: string) {
      return {
        select: () => ({
          eq: () => ({ single: async () => ({ data: template, error: template ? null : { message: 'nf' } }) }),
          single: async () => ({ data: settings, error: null }),
          maybeSingle: async () => ({ data: settings }),
        }),
        insert: async (row: Row) => { if (table === 'email_log') { if (opts.logThrows) throw new Error('db down'); logRows.push(row); } return { error: null }; },
      };
    },
  };
}

const TEMPLATE = {
  key: 'events.tickets_confirmed', enabled: true, postmark_stream: 'outbound',
  subject: 'Your tickets for {{event_title}}', body_html: '<p>Hi {{buyer_name}}, see <a href="{{tickets_url}}">tickets</a></p>', body_text: null,
};

beforeEach(() => {
  env = { POSTMARK_API_KEY: 'pm-test-token', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' };
  logRows = []; postmarkCalls = []; postmarkReply = { status: 200, body: { MessageID: 'pm-1', ErrorCode: 0 } };
  installGlobals();
});

const sendEmail = () => loadModule('supabase/functions/_shared/send-email.ts',
  { 'https://esm.sh/@supabase/supabase-js@2': {} }).sendEmail as (s: any, i: any) => Promise<any>;

/* ── the shared sender: identity, escaping, failure ──────────────────────── */

describe('shared sender — identity', () => {
  test('From is the transactional identity and replies go to the monitored support inbox', async () => {
    const r = await sendEmail()(fakeSupabase(TEMPLATE), { templateKey: TEMPLATE.key, recipientEmail: 'buyer@example.org',
      variables: { event_title: 'Up Helly Aa', buyer_name: 'Sam', tickets_url: 'https://oneshetland.com/account/tickets' } });
    assert.equal(r.ok, true);
    const b = postmarkCalls[0].body;
    assert.equal(b.From, 'OneShetland <orders@oneshetland.com>');
    assert.equal(b.ReplyTo, 'hello@oneshetland.com');
    assert.equal(b.To, 'buyer@example.org');
    assert.equal(b.MessageStream, 'outbound');
    assert.equal(postmarkCalls[0].headers['X-Postmark-Server-Token'], 'pm-test-token');
  });

  test('no personal address appears anywhere in a built message', async () => {
    await sendEmail()(fakeSupabase(TEMPLATE), { templateKey: TEMPLATE.key, recipientEmail: 'buyer@example.org',
      variables: { event_title: 'X', buyer_name: 'Sam', tickets_url: 'https://oneshetland.com/account/tickets' } });
    const everything = JSON.stringify(postmarkCalls[0].body);
    for (const bad of ['gmail.com', 'hotmail', 'darrenfullerton.com', 'darren@', 'localhost']) assert.ok(!everything.includes(bad), bad);
    assert.match(everything, /oneshetland\.com/);
  });

  test('the footer carries the brand and legal entity', async () => {
    await sendEmail()(fakeSupabase(TEMPLATE), { templateKey: TEMPLATE.key, recipientEmail: 'a@b.co', variables: { event_title: 'X', buyer_name: 'S', tickets_url: 'https://oneshetland.com' } });
    assert.match(postmarkCalls[0].body.HtmlBody, /The OneShetland Team/);
    assert.match(postmarkCalls[0].body.HtmlBody, /Darren Fullerton Consultancy Ltd/);
  });

  test('a plain-text part is always sent (derived from the HTML when the template has none)', async () => {
    await sendEmail()(fakeSupabase(TEMPLATE), { templateKey: TEMPLATE.key, recipientEmail: 'a@b.co', variables: { event_title: 'X', buyer_name: 'Sam', tickets_url: 'https://oneshetland.com' } });
    const t = postmarkCalls[0].body.TextBody;
    assert.match(t, /Hi Sam/);
    assert.doesNotMatch(t, /<[a-z]/i);
  });
});

describe('shared sender — a title cannot inject markup into a genuine email', () => {
  const EVIL = 'Gig <img src=x onerror=alert(1)><a href="https://evil.example">claim refund</a>';
  test('THE DEFECT: the subject used to land unescaped in the HTML header and <title>', async () => {
    await sendEmail()(fakeSupabase(TEMPLATE), { templateKey: TEMPLATE.key, recipientEmail: 'a@b.co',
      variables: { event_title: EVIL, buyer_name: 'S', tickets_url: 'https://oneshetland.com' } });
    const html: string = postmarkCalls[0].body.HtmlBody;
    assert.ok(!html.includes('<img src=x'), 'no injected <img>');
    assert.ok(!html.includes('href="https://evil.example"'), 'no injected link');
    assert.match(html, /&lt;img src=x/);
  });

  test('the Subject header itself stays plain text, not HTML-escaped', async () => {
    await sendEmail()(fakeSupabase(TEMPLATE), { templateKey: TEMPLATE.key, recipientEmail: 'a@b.co',
      variables: { event_title: 'Tom & Jerry', buyer_name: 'S', tickets_url: 'https://oneshetland.com' } });
    assert.equal(postmarkCalls[0].body.Subject, 'Your tickets for Tom & Jerry');
  });

  test('variables in the body are escaped; pre-rendered *_html keys are the only raw ones', async () => {
    const t = { ...TEMPLATE, subject: 'S', body_html: '<p>{{buyer_name}}</p>{{codes_html}}' };
    await sendEmail()(fakeSupabase(t), { templateKey: t.key, recipientEmail: 'a@b.co',
      variables: { buyer_name: '<script>x</script>', codes_html: '<strong>ABC123</strong>' } });
    const html: string = postmarkCalls[0].body.HtmlBody;
    assert.ok(!html.includes('<script>x'));
    assert.ok(html.includes('<strong>ABC123</strong>'));
  });
});

describe('shared sender — failure is recorded, never thrown, never silent', () => {
  const input = { templateKey: TEMPLATE.key, recipientEmail: 'a@b.co', recipientId: 'u1',
    variables: { event_title: 'X', buyer_name: 'S', tickets_url: 'https://oneshetland.com' } };

  test('provider rejects (e.g. an inactive recipient): ok:false, error stored, nothing thrown', async () => {
    postmarkReply = { status: 422, body: { ErrorCode: 406, Message: 'You tried to send to recipient(s) that have been marked as inactive.' } };
    const r = await sendEmail()(fakeSupabase(TEMPLATE), input);
    assert.equal(r.ok, false);
    assert.equal(logRows.length, 1);
    assert.equal(logRows[0].status, 'failed');
    assert.match(logRows[0].error_message, /inactive/);
    assert.equal(logRows[0].recipient_email, 'a@b.co');
  });

  test('network failure: same — a recorded failure, not an exception', async () => {
    postmarkReply = 'throw';
    const r = await sendEmail()(fakeSupabase(TEMPLATE), input);
    assert.equal(r.ok, false);
    assert.equal(logRows[0].status, 'failed');
    assert.match(logRows[0].error_message, /network down/);
  });

  test('missing provider key: recorded as failed, no request made', async () => {
    delete env.POSTMARK_API_KEY;
    const r = await sendEmail()(fakeSupabase(TEMPLATE), input);
    assert.equal(r.ok, false);
    assert.equal(postmarkCalls.length, 0);
    assert.equal(logRows[0].status, 'failed');
  });

  test('unknown template: recorded as failed', async () => {
    const r = await sendEmail()(fakeSupabase(null), input);
    assert.equal(r.ok, false);
    assert.equal(logRows[0].status, 'failed');
    assert.equal(postmarkCalls.length, 0);
  });

  test('disabled template: skipped and logged as skipped, nothing sent', async () => {
    const r = await sendEmail()(fakeSupabase({ ...TEMPLATE, enabled: false }), input);
    assert.deepEqual([r.ok, r.skipped], [true, true]);
    assert.equal(logRows[0].status, 'skipped');
    assert.equal(postmarkCalls.length, 0);
  });

  test('a sent email is logged with its provider id', async () => {
    await sendEmail()(fakeSupabase(TEMPLATE), input);
    assert.equal(logRows[0].status, 'sent');
    assert.equal(logRows[0].postmark_id, 'pm-1');
  });

  test('even a broken log table cannot throw out of the sender', async () => {
    postmarkReply = { status: 500, body: { Message: 'boom' } };
    const r = await sendEmail()(fakeSupabase(TEMPLATE, SETTINGS, { logThrows: true }), input);
    assert.equal(r.ok, false);
  });
});

/* ── password reset: the emailed link may only land on our own reset page ──── */

describe('password reset link', () => {
  let handler: (r: Request) => Promise<Response>;
  let sent: Row[];

  function load() {
    sent = [];
    const chain: any = { eq: () => chain, gte: async () => ({ count: 0 }) };
    const svc = {
      from: () => ({ select: () => chain }),
      auth: { admin: { generateLink: async () => ({ data: { properties: { hashed_token: 'HASH123', redirect_to: 'https://oneshetland.com' } }, error: null }) } },
    };
    loadModule('supabase/functions/request-password-reset/index.ts', {
      'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
      'https://esm.sh/@supabase/supabase-js@2': { createClient: () => svc },
      '../_shared/send-email.ts': { sendEmail: async (_s: any, i: any) => { sent.push(i); return { ok: true }; } },
      '../_shared/rate-limit.ts': { enforceRateLimit: async () => ({}), GLOBAL_SUBJECT: 'global' },
    });
  }
  const ask = (redirect_to?: string) => handler(new Request('https://x.supabase.co/functions/v1/request-password-reset', {
    method: 'POST', body: JSON.stringify({ email: 'Victim@Example.org', ...(redirect_to === undefined ? {} : { redirect_to }) }),
  }));
  beforeEach(load);

  test('the real web flow works: link lands on /reset-password with the token hash', async () => {
    const res = await ask('https://oneshetland.com/reset-password');
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].variables.reset_url, 'https://oneshetland.com/reset-password?token_hash=HASH123&type=recovery');
    assert.equal(sent[0].recipientEmail, 'victim@example.org');
    assert.equal(sent[0].templateKey, 'account.password_reset');
  });

  test('www is accepted, and stays on www', async () => {
    await ask('https://www.oneshetland.com/reset-password');
    assert.match(sent[0].variables.reset_url, /^https:\/\/www\.oneshetland\.com\/reset-password\?token_hash=/);
  });

  test('no redirect_to at all still produces the production reset page', async () => {
    await ask();
    assert.match(sent[0].variables.reset_url, /^https:\/\/oneshetland\.com\/reset-password\?token_hash=/);
  });

  for (const hostile of [
    'https://evil.example/reset-password',
    'https://evil.example/',
    'https://oneshetland.com.evil.example/reset-password',
    'https://evil-oneshetland.com/reset-password',
    'https://oneshetland.com@evil.example/reset-password',
    'https://oneshetland.com:8443/reset-password',
    'http://oneshetland.com/reset-password',
    'http://localhost:3000/reset-password',
    '//evil.example/reset-password',
    'javascript:alert(1)',
    'https://oneshetland.com/sign-in',
    'https://oneshetland.com/reset-password/../../evil',
    'not a url',
  ]) {
    test(`THE DEFECT: redirect_to=${hostile} can never carry the token off-site`, async () => {
      const res = await ask(hostile);
      assert.deepEqual(await res.json(), { ok: true }, 'still never reveals anything');
      assert.equal(sent.length, 1);
      const u = new URL(sent[0].variables.reset_url);
      assert.equal(u.origin, 'https://oneshetland.com');
      assert.equal(u.pathname, '/reset-password');
      assert.equal(u.searchParams.get('token_hash'), 'HASH123');
    });
  }
});

/* ── hub broadcast email ──────────────────────────────────────────────────── */

describe('hub broadcast email', () => {
  let handler: (r: Request) => Promise<Response>;

  function load(users: Record<string, string | null>) {
    const memberRows = Object.keys(users).map((user_id) => ({ user_id }));
    const q: any = { select: () => q, eq: () => q, or: () => Promise.resolve({ data: memberRows }), maybeSingle: async () => ({ data: { name: 'Lerwick Hub', reply_to: 'hello@oneshetland.com' } }) };
    const svc: any = {
      rpc: async () => ({ data: true }),
      from: (t: string) => t === 'email_log'
        ? { insert: async (row: Row) => { logRows.push(row); return { error: null }; } }
        : t === 'hub_members' ? { select: () => ({ eq: () => ({ eq: () => ({ or: () => Promise.resolve({ data: memberRows }) }) }) }) }
        : { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: 'Lerwick Hub' } }) }), maybeSingle: async () => ({ data: { reply_to: 'hello@oneshetland.com' } }) }) },
      auth: { admin: { getUserById: async (id: string) => ({ data: { user: users[id] ? { email: users[id] } : null } }) } },
    };
    const anon: any = { auth: { getUser: async () => ({ data: { user: { id: 'admin1' } } }) } };
    let n = 0;
    loadModule('supabase/functions/hub-broadcast/index.ts', {
      'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
      'https://esm.sh/@supabase/supabase-js@2': { createClient: () => (n++ % 2 === 0 ? anon : svc) },
      '../_shared/send-push.ts': { sendUserPushBulk: async () => ({ sent: 0 }) },
      '../_shared/safe-error.ts': { safeError: (_n: string, e: any) => String(e?.message ?? e) },
      '../_shared/rate-limit.ts': { enforceRateLimit: async () => ({}), userSubject: (id: string) => id },
    });
  }
  const post = () => handler(new Request('https://x/functions/v1/hub-broadcast', {
    method: 'POST', headers: { Authorization: 'Bearer t' },
    body: JSON.stringify({ hub_id: 'h1', title: 'Meeting <b>Tue</b>', message: 'Hall at 7', channel: 'email' }),
  }));

  test('replies go to the support inbox, not the send-only sender', async () => {
    load({ u1: 'one@example.org' });
    await post();
    assert.equal(postmarkCalls.length, 1);
    assert.equal(postmarkCalls[0].body.From, 'OneShetland <orders@oneshetland.com>');
    assert.equal(postmarkCalls[0].body.ReplyTo, 'hello@oneshetland.com');
  });

  test('every attempt is logged, so a failure shows in the Email centre', async () => {
    load({ u1: 'one@example.org', u2: 'two@example.org' });
    await post();
    assert.equal(logRows.length, 2);
    assert.ok(logRows.every((r) => r.template_key === 'hub.broadcast' && r.status === 'sent' && r.postmark_id === 'pm-1'));
  });

  test('a provider rejection is logged as failed and the broadcast still completes', async () => {
    load({ u1: 'one@example.org' });
    postmarkReply = { status: 422, body: { Message: 'inactive recipient' } };
    const res = await post();
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.email, 0);
    assert.equal(logRows[0].status, 'failed');
    assert.match(logRows[0].error_message, /inactive/);
  });

  test('content is escaped in the HTML body', async () => {
    load({ u1: 'one@example.org' });
    await post();
    assert.ok(!postmarkCalls[0].body.HtmlBody.includes('<b>Tue</b>'));
  });
});

/* ── source-level guarantees across every sender ──────────────────────────── */

const walk = (d: string, acc: string[] = []): string[] => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p, acc); }
    else if (n.endsWith('.ts') && !n.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
};
const FUNCS = join(REPO_ROOT, 'supabase', 'functions');
const emailSenders = walk(FUNCS).filter((f) => /sendEmail\(|api\.postmarkapp\.com/.test(readFileSync(f, 'utf8')));

describe('every email-sending function', () => {
  test('the inventory is what we think it is (a new sender must be reviewed here)', () => {
    const names = emailSenders.map((f) => f.slice(FUNCS.length + 1)).sort();
    assert.deepEqual(names, [
      '_shared/fulfilment.ts', '_shared/launch-invitation-postmark.ts', '_shared/send-email.ts', '_shared/ticket-receipt.ts', 'confirm-gift/index.ts',
      'hub-broadcast/index.ts', 'notify-event-update/index.ts', 'request-password-reset/index.ts',
      'send-email/index.ts', 'stripe-webhook/index.ts', 'verify-gift-recipient/index.ts',
    ]);
  });

  test('only production links are ever built — no dev, preview or placeholder hosts', () => {
    for (const f of emailSenders) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(src, /localhost|127\.0\.0\.1|netlify\.app|ngrok|example\.com|staging\./i, f);
      for (const m of src.matchAll(/https?:\/\/[a-z0-9.-]+/gi)) {
        if (/postmarkapp|esm\.sh|deno\.land|supabase\.co|w3\.org|api\.stripe\.com/i.test(m[0])) continue;
        assert.match(m[0], /^https:\/\/(www\.)?oneshetland\.com$/, `${f}: ${m[0]}`);
      }
    }
  });

  test('From addresses are only the two OneShetland identities; no personal address is embedded', () => {
    for (const f of emailSenders) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of src.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g)) {
        assert.ok(['orders@oneshetland.com', 'hello@oneshetland.com'].includes(m[0]) || /^you@|^name@/.test(m[0]), `${f}: ${m[0]}`);
      }
    }
  });

  test('every direct Postmark call sets a ReplyTo', () => {
    for (const f of emailSenders) {
      const src = readFileSync(f, 'utf8');
      if (!src.includes('api.postmarkapp.com/email')) continue;
      assert.match(src, /ReplyTo/, f);
    }
  });
});

describe('email can never undo or block what it reports', () => {
  test('ticket receipt: a failure is caught and the tickets and payment stand', () => {
    const src = readRepo('supabase/functions/_shared/ticket-receipt.ts');
    assert.match(src, /catch \(e\) \{[\s\S]*A receipt must never fail fulfilment/);
    assert.match(src, /console\.error\('\[ticket-receipt\] failed:'/);
  });

  test('billing emails: caught, so a Stripe webhook never fails (and retries) over an email', () => {
    const src = readRepo('supabase/functions/stripe-webhook/index.ts');
    assert.match(src, /plan-change email failed:/);
  });

  test('gift emails: failure leaves email_sent_at unset (so it is visibly unsent) and is not fatal', () => {
    for (const f of ['supabase/functions/_shared/fulfilment.ts', 'supabase/functions/confirm-gift/index.ts']) {
      const src = readRepo(f);
      assert.match(src, /emailResult\.ok && !emailResult\.skipped/);
      assert.match(src, /email_sent_at/);
    }
  });

  test('password reset never reveals whether an address exists, even when sending fails', () => {
    const src = readRepo('supabase/functions/request-password-reset/index.ts');
    assert.match(src, /return ok\(\); \/\/ never surface details/);
  });

  test('the shared sender never throws on a provider failure (callers do not need defensive try/catch to stay safe)', () => {
    const src = readRepo('supabase/functions/_shared/send-email.ts');
    assert.match(src, /catch \(err\) \{[\s\S]*status: 'failed'[\s\S]*return \{ ok: false/);
  });

  test('the email log accepts every status the code writes', () => {
    const migs = readdirSync(join(REPO_ROOT, 'supabase', 'migrations')).map((n) => readRepo(`supabase/migrations/${n}`)).join('\n');
    assert.ok(/email_log_status_check/.test(migs) || /'sent'.*'delivered'.*'bounced'.*'failed'.*'skipped'/s.test(migs));
  });
});

describe('support details and legal identity in customer email', () => {
  test('the sender default and the support inbox are the intended identities', () => {
    const src = readRepo('supabase/functions/_shared/send-email.ts');
    assert.match(src, /'orders@oneshetland\.com'/);
    assert.match(src, /ReplyTo:\s+settings\?\.reply_to \?\? fromEmail/);
  });

  test('the Email centre editor placeholder for the reply-to is the support inbox', () => {
    assert.match(readRepo('app/(admin)/email-centre.tsx'), /placeholder: 'hello@oneshetland\.com \(optional\)'/);
  });
});
