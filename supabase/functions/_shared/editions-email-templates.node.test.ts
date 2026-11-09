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
