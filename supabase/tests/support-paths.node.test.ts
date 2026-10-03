/**
 * support-paths.node.test.ts
 *
 * operations-support: "a public way to get help and someone answering it". For launch that means
 * a real person can discover how to reach OneShetland WITHOUT knowing a hidden URL — on the web
 * and in the app, signed in or out — that every link lands on a real page, and that every
 * contact address is the real support identity, not a placeholder.
 *
 * Source-level and read-only: nothing is sent, fetched or written. Needs the sibling
 * ../oneshetland-web checkout (skipped, loudly, if absent).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(MOBILE, '..', 'oneshetland-web');
const haveWeb = existsSync(join(WEB, 'app', 'support', 'page.tsx'));
const opts = { skip: haveWeb ? false : 'sibling oneshetland-web checkout not found' };

const mobile = (rel: string) => readFileSync(join(MOBILE, rel), 'utf8');
const web = (rel: string) => readFileSync(join(WEB, rel), 'utf8');
const SUPPORT_EMAIL = 'hello@oneshetland.com';
const SUPPORT_URL = 'https://oneshetland.com/support';
const SUPPORT_PHONE = '01595 922404';
const SUPPORT_PHONE_INTL = '+44 1595 922404';
const SUPPORT_PHONE_TEL = 'tel:+441595922404';

/** Every route directory under the web app (page.tsx present). */
function routes(dir = join(WEB, 'app'), prefix = ''): Set<string> {
  const out = new Set<string>();
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    if (existsSync(join(p, 'page.tsx')) || existsSync(join(p, 'route.ts'))) out.add(`${prefix}/${name}`);
    for (const r of routes(p, `${prefix}/${name}`)) out.add(r);
  }
  return out;
}

describe('web support page', opts, () => {
  const page = () => web('app/support/page.tsx');

  test('the page exists and covers payments/refunds, account help, and businesses', () => {
    const p = page();
    assert.match(p, /Payments &amp; refunds/);
    assert.match(p, /Account &amp; login help/);
    assert.match(p, /Businesses &amp; organisations/);
  });

  test('every mailto on the page is the support identity — never a placeholder or a personal address', () => {
    const mails = [...page().matchAll(/mailto:([^"'`\s>]+)/g)].map((m) => m[1]);
    assert.ok(mails.length >= 3, 'the page offers email in several places');
    for (const m of mails) assert.equal(m, SUPPORT_EMAIL);
  });

  test('every internal link on the page lands on a real route', () => {
    const known = routes();
    const hrefs = [...page().matchAll(/href="(\/[a-z0-9-]*)"/g)].map((m) => m[1]).filter((h) => h !== '/');
    assert.ok(hrefs.length >= 6);
    for (const h of new Set(hrefs)) assert.ok(known.has(h), `${h} has no page in the web app`);
  });

  test('it is a public page: no auth redirect, so signed-out users can read it', () => {
    assert.doesNotMatch(page(), /redirect\(|getUser|createClient|requireUser/);
    assert.match(web('app/sitemap.ts'), /path: "\/support"/);
  });
});

describe('web discoverability', opts, () => {
  test('the site footer — on every page, signed in or out — links to /support', () => {
    assert.match(web('components/site/SiteFooter.tsx'), /href="\/support"/);
    assert.match(web('app/layout.tsx'), /SiteFooter/);
  });

  test('the error page tells people how to reach us, on the support identity', () => {
    const e = web('app/error.tsx');
    assert.ok(e.includes(`mailto:${SUPPORT_EMAIL}`));
  });

  test('legal pages offer the same support address (privacy, delete-account, terms, guidelines, shared layout)', () => {
    for (const f of ['app/privacy/page.tsx', 'app/delete-account/page.tsx', 'app/terms/page.tsx',
      'app/community-guidelines/page.tsx', 'components/site/LegalLayout.tsx']) {
      assert.ok(web(f).includes(`mailto:${SUPPORT_EMAIL}`), `${f} should offer ${SUPPORT_EMAIL}`);
    }
  });

  test('no placeholder contact details on any public legal/support page', () => {
    for (const f of ['app/support/page.tsx', 'app/privacy/page.tsx', 'app/terms/page.tsx', 'app/delete-account/page.tsx',
      'app/community-guidelines/page.tsx', 'app/selling-policy/page.tsx', 'app/legal/page.tsx']) {
      const emails = web(f).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g) ?? [];
      for (const e of emails) assert.equal(e, SUPPORT_EMAIL, `${f}: ${e}`);
    }
  });

  test('the web account area is never the only way to find help (footer is outside auth)', () => {
    const layout = web('app/layout.tsx');
    assert.doesNotMatch(layout, /redirect\(/);
  });
});

describe('support telephone', opts, () => {
  const page = () => web('app/support/page.tsx');
  const legalPages = ['app/support/page.tsx', 'app/privacy/page.tsx', 'app/terms/page.tsx', 'app/delete-account/page.tsx',
    'app/community-guidelines/page.tsx', 'app/selling-policy/page.tsx', 'app/legal/page.tsx', 'components/site/LegalLayout.tsx'];

  test('the support page shows the number in national and international form, with a tap-to-call link', () => {
    const p = page();
    assert.ok(p.includes(SUPPORT_PHONE), 'national format');
    assert.ok(p.includes(SUPPORT_PHONE_INTL), 'international format');
    assert.ok(p.includes(`href="${SUPPORT_PHONE_TEL}"`), 'tel: link');
  });

  test('the visible number, the international form and the tel: link are the same number', () => {
    const digits = (x: string) => x.replace(/\D/g, '');
    assert.equal(digits(SUPPORT_PHONE_INTL).slice(2), digits(SUPPORT_PHONE).slice(1));
    assert.equal(digits(SUPPORT_PHONE_TEL), digits(SUPPORT_PHONE_INTL));
    assert.match(SUPPORT_PHONE, /^01595 \d{6}$/); // Shetland geographic code
  });

  test('no other or placeholder phone number appears on a support or legal page', () => {
    for (const f of legalPages) {
      const src = web(f);
      const nums = src.match(/(?:\+44[ \d]{9,13}|\b0[1-37-9]\d{2,3}[ ]?\d{3}[ ]?\d{3,4}\b)/g) ?? [];
      const same = (n: string) => {
        const d = n.replace(/\D/g, '');
        return d === SUPPORT_PHONE.replace(/\D/g, '') || d === SUPPORT_PHONE_INTL.replace(/\D/g, '');
      };
      for (const n of nums) assert.ok(same(n), `${f}: unexpected number ${n}`);
      assert.doesNotMatch(src, /07700 ?900|0123 ?456|555-?01\d\d|tel:\+?0*\s*"/);
    }
  });

  test('the page does not promise a live answer — it tells people to leave a message', () => {
    assert.match(page(), /can&rsquo;t always answer live/);
    assert.match(page(), /leave a message/);
    assert.doesNotMatch(page(), /24\/7|24 hours a day|open (?:daily|9)|opening hours/i);
  });

  test('the runbook records the same number and what to do with a voicemail', () => {
    const rb = mobile('SUPPORT-RUNBOOK.md');
    assert.ok(rb.includes(SUPPORT_PHONE) && rb.includes(SUPPORT_PHONE_INTL));
    assert.match(rb, /Voicemail left on 01595 922404/);
    assert.match(rb, /Soho66/);
  });

  test('the Google-Wallet-facing details and the site agree: email, URL and phone on one page', () => {
    const p = page();
    assert.ok(p.includes(`mailto:${SUPPORT_EMAIL}`) && p.includes(SUPPORT_PHONE_TEL));
    assert.ok(mobile('app/(tabs)/me.tsx').includes(SUPPORT_URL)); // the app opens that same page
  });
});

describe('mobile app: help is findable, signed in and signed out', () => {
  test('the sign-in screen links to Help (a locked-out user has no other way)', () => {
    const s = mobile('app/(auth)/sign-in.tsx');
    assert.ok(s.includes(`Linking.openURL('${SUPPORT_URL}')`));
    assert.match(s, />\s*Help\s*</);
  });

  test('the Me tab and the Account screen both offer Help & support', () => {
    for (const f of ['app/(tabs)/me.tsx', 'app/account.tsx']) {
      const s = mobile(f);
      assert.ok(s.includes(`Linking.openURL('${SUPPORT_URL}')`), f);
      assert.match(s, /Help & support/);
    }
  });

  test('Help sits next to the legal links, not buried (same group as Privacy and Terms)', () => {
    const a = mobile('app/account.tsx');
    const legal = a.slice(a.indexOf('Help & legal'), a.indexOf('Session</Text>'));
    for (const l of ['Privacy Policy', 'Terms of Service', 'Help & support']) assert.ok(legal.includes(l), l);
    const m = mobile('app/(tabs)/me.tsx');
    const i = m.indexOf('label="Privacy Policy"');
    assert.ok(m.indexOf('label="Help & support"') > i && m.indexOf('label="Help & support"') - i < 1200);
  });

  test('deleting an account is reachable in the app', () => {
    assert.match(mobile('app/(tabs)/me.tsx'), /label="Delete account"/);
    assert.match(mobile('app/account.tsx'), /handleDeleteAccount/);
  });

  test('users can report content in the app (ReportSheet exists and is wired)', () => {
    assert.ok(existsSync(join(MOBILE, 'components/ReportSheet.tsx')));
    assert.match(mobile('components/ContentActions.tsx'), /ReportSheet/);
  });
});

describe('mobile ⇄ web parity', opts, () => {
  const known = () => routes();

  test('every support/legal URL the app opens exists on the web, exactly', () => {
    const files = ['app/(auth)/sign-in.tsx', 'app/(auth)/sign-up.tsx', 'app/(tabs)/me.tsx', 'app/account.tsx',
      'components/CommercialTermsGate.tsx'];
    const paths = new Set<string>();
    for (const f of files) for (const m of mobile(f).matchAll(/https:\/\/oneshetland\.com(\/[a-z-]+)/g)) paths.add(m[1]);
    for (const required of ['/support', '/privacy', '/terms']) assert.ok(paths.has(required), `${required} is linked in the app`);
    for (const p of paths) assert.ok(known().has(p), `app links to ${p} but the web has no such page`);
  });

  test('the app only ever mails the support identity or a business/hub/job contact — no placeholders in code', () => {
    const walk = (d: string, acc: string[] = []): string[] => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p, acc); else if (/\.(tsx?)$/.test(n)) acc.push(p);
      }
      return acc;
    };
    for (const f of [...walk(join(MOBILE, 'app')), ...walk(join(MOBILE, 'components'))]) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/mailto:([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,})/g)) {
        assert.equal(m[1], SUPPORT_EMAIL, `${f} hard-codes ${m[1]}`);
      }
    }
  });

  test('the same support address is used on web and in the runbook', () => {
    assert.ok(mobile('SUPPORT-RUNBOOK.md').includes(SUPPORT_EMAIL));
    assert.ok(mobile('SUPPORT-RUNBOOK.md').includes('https://oneshetland.com/support'));
  });
});

describe('operator process', () => {
  const rb = () => mobile('SUPPORT-RUNBOOK.md');

  test('the runbook has an owner/action path for every request type that matters at launch', () => {
    for (const h of ['Customer: account / sign-in', 'Customer: payment, ticket, booking, pass, membership, refund',
      'Failed Wallet settlement', 'Business / merchant / organiser', 'Reporting a problem with content',
      'Privacy / data requests', 'Urgent operational issue / outage', 'Secret exposed']) {
      assert.ok(rb().includes(h), `runbook missing: ${h}`);
    }
  });

  test('the runbook points at tools that actually exist', () => {
    const adminSidebar = haveWeb ? web('components/admin/AdminSidebar.tsx') : '';
    for (const path of ['/admin/reports', '/admin/payments', '/admin/claims', '/admin/compliance', '/admin/config']) {
      assert.ok(rb().includes(path), `runbook mentions ${path}`);
      if (haveWeb) assert.ok(existsSync(join(WEB, 'app', path, 'page.tsx')), `${path} page exists`);
    }
    if (haveWeb) assert.match(adminSidebar, /\/admin\/reports/);
    for (const f of ['refund-reconcile', 'refund-reconcile-sweep', 'delete-account']) {
      assert.ok(existsSync(join(MOBILE, 'supabase/functions', f, 'index.ts')), f);
    }
    assert.ok(existsSync(join(MOBILE, 'DISASTER-RECOVERY-RUNBOOK.md')));
  });

  test('the runbook repeats only the response times the legal pages promise', () => {
    assert.match(rb(), /within 24 hours/i);
    assert.match(rb(), /within \*\*30 days\*\*/);
    if (haveWeb) {
      assert.match(web('app/terms/page.tsx'), /within 24 hours of the report/);
      assert.match(web('app/delete-account/page.tsx'), /within 30 days/);
    }
  });

  test('known gaps are written down, not hidden', () => {
    assert.match(rb(), /Known gaps/);
    assert.match(rb(), /does not take content down|does not remove content/i);
  });
});
