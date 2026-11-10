/** Pure tests for the Editions email templates. Run: node --test supabase/functions/_shared/editions-email-templates.node.test.ts */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderEditionEmail, EMAIL_KINDS, esc } from './editions-email-templates.ts';

const P = { organiser_name: 'Folk Festival', edition_title: 'Folk 2027', subject_name: 'Harbour Cafe', tier_name: 'Full member', business_name: 'Harbour Cafe', label: 'Full member', period_end: '2027-06-01T10:00:00Z', charge_pence: 1000, vat_pence: 167, legal_name: 'Folk Ltd', vat_number: 'GB123456789', answer: 'approved', organiser_slug: 'folk', note: 'Thanks for everything' };
const O = 'https://oneshetland.com/';

describe('every queued kind renders', () => {
  test('subject, text and html exist, link to our origin only, and say why the person got it', () => {
    for (const kind of EMAIL_KINDS) {
      const r = renderEditionEmail({ kind, payload: P }, O)!;
      assert.ok(r && r.subject && r.text && r.html, kind);
      assert.ok(!/[\r\n]/.test(r.subject), `${kind}: subject is one line`);
      assert.match(r.text, /https:\/\/oneshetland\.com\/[a-z]/, kind); assert.ok(!r.text.includes('//account') && !r.text.includes('com//'), kind);
      assert.match(r.text, /You are receiving this/, kind);
      for (const url of r.html.match(/href="[^"]+"/g) ?? []) assert.ok(url.startsWith('href="https://oneshetland.com/'), `${kind}: ${url}`);
      assert.ok(!/utm_|pixel|track/i.test(r.html), kind);
    }
  });
  test('unknown kinds render nothing', () => { assert.equal(renderEditionEmail({ kind: 'mystery', payload: {} }, O), null); });
});

describe('safety', () => {
  const evil = { ...P, organiser_name: 'Evil\r\nBcc: attacker@example.com', edition_title: '<script>alert(1)</script>', subject_name: '"><img src=x onerror=1>', tier_name: "T'ier & co" };
  test('names cannot forge headers or inject markup', () => {
    for (const kind of EMAIL_KINDS) {
      const r = renderEditionEmail({ kind, payload: evil }, O)!;
      assert.ok(!/[\r\n]/.test(r.subject), kind); assert.ok(!/<script|<img/i.test(r.html) && !/"><img/.test(r.html), kind);
    }
    assert.equal(esc(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
  test('long values are trimmed; missing values leave no "undefined" or "null"', () => {
    const r = renderEditionEmail({ kind: 'membership_welcome', payload: { organiser_name: 'x'.repeat(500), tier_name: 'T', business_name: 'B' } }, O)!;
    assert.ok(r.subject.length <= 150); assert.ok(!/undefined|null|NaN/.test(r.text + r.html));
    assert.ok(!/undefined|null|NaN/.test(renderEditionEmail({ kind: 'payment_receipt', payload: {} }, O)!.text));
  });
});

describe('content', () => {
  test('a receipt shows pounds from pence, VAT only when there is some, and the supplier details', () => {
    const r = renderEditionEmail({ kind: 'payment_receipt', payload: P }, O)!;
    assert.match(r.text, /£10\.00/); assert.match(r.text, /VAT of £1\.67/); assert.match(r.text, /Folk Ltd \(VAT no\. GB123456789\)/);
    assert.ok(!/VAT of/.test(renderEditionEmail({ kind: 'payment_receipt', payload: { ...P, vat_pence: 0 } }, O)!.text));
  });
  test('invitations reassure about control; a failed payment says what to do; dates are London dates', () => {
    assert.match(renderEditionEmail({ kind: 'partner_invited', payload: P }, O)!.text, /step back at any time/);
    assert.match(renderEditionEmail({ kind: 'membership_invited', payload: P }, O)!.text, /never changes your listing, plan or offers/);
    assert.match(renderEditionEmail({ kind: 'membership_payment_failed', payload: P }, O)!.text, /update your payment details/i);
    assert.match(renderEditionEmail({ kind: 'membership_welcome', payload: { ...P, period_end: '2027-06-30T23:30:00Z' } }, O)!.text, /1 July 2027/);
  });
  test('the sender function never stores an address and uses the transactional stream with tracking off', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../editions-email-cron/index.ts', import.meta.url), 'utf8');
    assert.match(src, /MessageStream: 'outbound'/); assert.match(src, /TrackOpens: false/); assert.match(src, /TrackLinks: 'None'/); assert.match(src, /Unauthorised/); assert.ok(!/launch|marketing|broadcast/i.test(src));
  });
});

test('partner emails to a Hub\'s administrators say they help run the Hub, and still send them to their invitations', () => {
  const P = { organiser_name: 'Festival Co', edition_title: 'Fest 2027', subject_name: 'Slippit Hub', subject_kind: 'hub', link_id: 'l1' };
  const r = renderEditionEmail({ kind: 'partner_invited', payload: P }, 'https://example.test')!;
  assert.match(r.text, /you help run this Hub/); assert.match(r.text, /\/account\/editions/); assert.doesNotMatch(r.text, /manage this listing/);
  assert.match(renderEditionEmail({ kind: 'partner_removed', payload: P }, 'https://example.test')!.text, /you help run this Hub/);
  assert.match(renderEditionEmail({ kind: 'partner_invited', payload: { ...P, subject_kind: 'business' } }, 'https://example.test')!.text, /manage this listing/);
});

describe('approval, package and helper emails', () => {
  const N = { edition_title: 'Folk 2027', edition_slug: 'folk-2027', organiser_slug: 'folk-fest', organiser_name: 'Folk Festival', subject_kind: 'hub', note: 'Please add a venue and a clearer summary.', ends_at: '2027-06-30T23:30:00Z', amount_pence: 5000, role: 'editor', inviter: 'Ann Smith' };
  const NEW = ['edition_approved', 'edition_changes_requested', 'edition_rejected', 'package_active', 'helper_invited'] as const;
  const links = (kind: string, payload: Record<string, unknown> = N) => (renderEditionEmail({ kind, payload }, 'https://oneshetland.com/')!.text.match(/https:\/\/\S+/g) ?? []);
  test('all five are registered and render subject, text and html', () => {
    for (const k of NEW) { assert.ok((EMAIL_KINDS as readonly string[]).includes(k), k); const r = renderEditionEmail({ kind: k, payload: N }, O)!; assert.ok(r.subject && r.text && r.html, k); }
  });
  test('links use the organiser and Edition web addresses; helper invitations go to /organise', () => {
    for (const k of ['edition_approved', 'edition_changes_requested', 'edition_rejected', 'package_active']) assert.deepEqual(links(k), ['https://oneshetland.com/organise/folk-fest/editions/folk-2027'], k);
    assert.deepEqual(links('helper_invited'), ['https://oneshetland.com/organise']);
  });
  test('approved tells them the next step; changes and rejection show the note; both reach people with no note too', () => {
    assert.match(renderEditionEmail({ kind: 'edition_approved', payload: N }, O)!.text, /Next: choose a package, then publish when you are ready\./);
    for (const k of ['edition_changes_requested', 'edition_rejected']) {
      assert.match(renderEditionEmail({ kind: k, payload: N }, O)!.text, /Please add a venue and a clearer summary\./, k);
      const none = renderEditionEmail({ kind: k, payload: { ...N, note: undefined } }, O)!; assert.ok(none.subject && !/reviewer.s message/.test(none.text), k);
    }
  });
  test('package_active: London end date, "free" at 0, pounds otherwise, publishing is up to them', () => {
    const paid = renderEditionEmail({ kind: 'package_active', payload: N }, O)!.text;
    assert.match(paid, /active until 1 July 2027/); assert.match(paid, /£50\.00/); assert.match(paid, /publishing is now up to you|Publishing is now up to you/);
    const free = renderEditionEmail({ kind: 'package_active', payload: { ...N, amount_pence: 0 } }, O)!.text;
    assert.match(free, /free/i); assert.ok(!/£/.test(free));
    assert.ok(!/Amount paid|Cost/.test(renderEditionEmail({ kind: 'package_active', payload: { ...N, amount_pence: undefined, ends_at: undefined } }, O)!.text));
  });
  test('footers say why: Hub helps run, Business owns, helper_invited was invited', () => {
    assert.match(renderEditionEmail({ kind: 'edition_approved', payload: N }, O)!.text, /you help run this Hub/);
    assert.match(renderEditionEmail({ kind: 'edition_approved', payload: { ...N, subject_kind: 'business' } }, O)!.text, /you own this Business/);
    const h = renderEditionEmail({ kind: 'helper_invited', payload: N }, O)!.text;
    assert.match(h, /someone invited this email address/); assert.match(h, /Ann Smith has invited you/); assert.match(h, /as an editor/);
    assert.match(h, /sign in using this email address/i); assert.match(h, /create an account using this same email address/i);
    assert.match(renderEditionEmail({ kind: 'helper_invited', payload: { ...N, role: 'admin', inviter: null } }, O)!.text, /You have been invited to help .* as an admin/);
  });
  test('hostile payload text is escaped or flattened in every new kind', () => {
    const evil = { ...N, edition_title: '<script>alert(1)</script>', organiser_name: 'A"B\r\nBcc: x@y.z', note: '<img src=x onerror=alert(1)> "quoted" & \'q\'', inviter: '</p><script>x</script>', organiser_slug: 'a"b<c', edition_slug: 'x"y' };
    for (const k of NEW) {
      const r = renderEditionEmail({ kind: k, payload: evil }, O)!;
      assert.ok(!/[\r\n]/.test(r.subject), k); assert.ok(!/<script|<img/i.test(r.html), k);
      for (const url of r.html.match(/href="[^"]*"/g) ?? []) assert.ok(!/[<>]|"[^"]*"$/.test(url.slice(6, -1)) , `${k}: ${url}`);
    }
    assert.match(renderEditionEmail({ kind: 'edition_changes_requested', payload: evil }, O)!.html, /&lt;img src=x onerror=alert\(1\)&gt; &quot;quoted&quot; &amp; &#39;q&#39;/);
  });
  test('missing values never print undefined, null or NaN, and never leave empty paragraphs', () => {
    for (const k of NEW) {
      const r = renderEditionEmail({ kind: k, payload: {} }, O)!;
      assert.ok(r.subject && r.text && r.html, k); assert.ok(!/undefined|null|NaN/.test(`${r.subject}${r.text}${r.html}`), k); assert.ok(!r.html.includes('<p style="margin:0 0 .9rem"></p>'), k);
      const nul = renderEditionEmail({ kind: k, payload: { edition_title: null, organiser_name: null, ends_at: null, amount_pence: null, note: null, inviter: null } }, O)!;
      assert.ok(!/undefined|null|NaN/.test(`${nul.subject}${nul.text}${nul.html}`), k);
    }
  });
  test('the cron works for a row with no user id (an invitee without an account) and never stores or logs the address', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../editions-email-cron/index.ts', import.meta.url), 'utf8');
    assert.ok(!/user_id/.test(src), 'nothing in the sender depends on a user id'); assert.ok(!/console\.(log|error|warn|info)/.test(src), 'nothing is logged');
    assert.ok(!/last_error|p_error: .*\.email|\.email.*p_error/.test(src)); assert.match(src, /To: r\.email/);
    assert.ok(renderEditionEmail({ id: 1, kind: 'helper_invited', user_id: null, email: 'x@example.test', payload: N, attempts: 0 }, O));
  });
});
