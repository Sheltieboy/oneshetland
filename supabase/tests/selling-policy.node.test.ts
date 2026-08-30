/**
 * selling-policy.node.test.ts — what a business may offer, and what publishing
 * that rule must NOT disturb.
 *
 * Three documents are easy to confuse, and this suite exists mostly to keep
 * them apart:
 *
 *   /terms §11        what a seller is RESPONSIBLE for. Accepted per version and
 *                     enforced in the database since W3I, so it must not move.
 *   /selling-policy   what may be OFFERED. Dated only, incorporated by §11's
 *                     existing "any policy we publish" sentence.
 *   /restricted-goods what Fetch may CARRY. A different question entirely.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = join(REPO_ROOT, '..', 'oneshetland-web');
const readWeb = (p: string) => readFileSync(join(WEB, p), 'utf8');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');

const POLICY = 'app/selling-policy/page.tsx';
const policy = readWeb(POLICY);
/**
 * The words a reader actually sees. Section headings live in the `h` attribute
 * of <L>, so they must be pulled out BEFORE tags are stripped — otherwise the
 * headings vanish and every "is X in the banned section" check silently reads
 * the whole page instead.
 */
const prose = policy
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/className="[^"]*"/g, '')
  .replace(/<L\s+h="([^"]*)"[^>]*>/g, ' §§ $1 §§ ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\{" "\}/g, ' ')
  .replace(/&rsquo;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');

function sql(body: string): Record<string, unknown>[] {
  const out = execFileSync('npx',
    ['supabase', 'db', 'query', '--linked', `select 1 as _guard where false;\n${body}`, '--output-format', 'json'],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { rows?: Record<string, unknown>[]; error?: unknown };
  if (parsed.error) throw new Error(JSON.stringify(parsed.error).slice(0, 400));
  return parsed.rows ?? [];
}

/* ── 1. The policy exists and says what was approved ────────────────────── */

describe('the policy is published and complete', () => {
  test('the page exists at /selling-policy', () => {
    assert.ok(existsSync(join(WEB, POLICY)));
  });

  test('it carries the approved title', () => {
    assert.match(policy, /title="Selling on OneShetland — what you may offer"/);
  });

  test('nothing was left unfinished in it', () => {
    for (const leftover of ['[Placeholder', 'Option A —', 'Option B —', 'TODO', 'TBC', 'Darren to choose', 'Lorem']) {
      assert.ok(!policy.includes(leftover), `unresolved: ${leftover}`);
    }
  });

  test('it is dated, and not dated into the future', () => {
    const m = policy.match(/updated="([A-Z][a-z]+ \d{4})"/);
    assert.ok(m, 'the page must carry a date');
    const [month, year] = m![1].split(' ');
    const dated = new Date(`${month} 1, ${year}`);
    const now = new Date();
    assert.ok(dated <= now, `dated ${m![1]}, which has not happened yet`);
  });
});

/* ── 2. The decisions the policy encodes ────────────────────────────────── */

describe('the decisions taken, and the ones deliberately not taken', () => {
  test('age-restricted goods are prohibited at launch', () => {
    assert.match(prose, /don't allow age-restricted goods to be sold/i);
    for (const item of ['alcohol', 'tobacco', 'vapes and nicotine', 'knives and bladed items', 'fireworks']) {
      assert.ok(prose.toLowerCase().includes(item), `the prohibition must name ${item}`);
    }
    assert.match(prose, /don't yet have a way to check a buyer's age/i,
      'the reason belongs in the policy — it is not a judgement about the business');
  });

  test('the conditional option was not shipped', () => {
    // Option B would have promised controls that do not exist: no age flag on
    // any commercial table, no authorised-seller concept, nothing forcing
    // collection-only.
    assert.ok(!/only be offered by a business holding whatever licence/i.test(prose));
    assert.ok(!/responsible for checking the customer's age at handover/i.test(prose));
    assert.ok(!/age[- ]verif/i.test(prose.split('Things you can only offer')[0] ?? ''),
      'no age-verification mechanism may be implied where none exists');
  });

  test('food is not banned by default', () => {
    assert.match(prose, /Plenty of Shetland businesses sell food, and you're welcome to/);
    assert.ok(!/food[^.]{0,40}(is not permitted|not allowed|prohibited)/i.test(prose));
  });

  test('live animals and hazardous retail goods stay conditional, not banned', () => {
    const banned = prose.slice(prose.indexOf('Not permitted on OneShetland'), prose.indexOf('Age-restricted goods'));
    const conditional = prose.slice(prose.indexOf('Things you can only offer'));
    for (const item of ['live animals', 'fuels, chemicals and solvents']) {
      assert.ok(!banned.toLowerCase().includes(item.split(',')[0]), `${item} must not be in the never-list`);
      assert.ok(conditional.toLowerCase().includes(item.toLowerCase()), `${item} belongs in the conditional group`);
    }
  });

  test('adult products are stated as a platform rule, not as law', () => {
    assert.match(prose, /adult and sexual products/i);
    assert.match(prose, /some are simply our choice for a local island marketplace/i);
    assert.ok(!/it is illegal to sell/i.test(prose), 'do not assert universal illegality');
  });

  test('services are covered, not just physical goods', () => {
    assert.match(prose, /applies to services as much as to things in boxes/i);
    assert.match(prose, /products in the Shop, services and appointments, passes and packs, tickets/);
  });

  test('a Directory listing is not selling', () => {
    assert.match(prose, /does not apply to having a Directory listing/i);
  });
});

/* ── 3. The two policies must not be mistaken for each other ────────────── */

describe('selling here and Fetch carrying it are different questions', () => {
  test('the policy says so, and links to the carriage rules', () => {
    assert.match(prose, /does not mean it can be delivered by a Fetch driver/i);
    assert.match(policy, /<Link href="\/restricted-goods"/);
  });

  test('the link is internal — no external or Claude URL anywhere in it', () => {
    assert.ok(!/claude\.ai/i.test(policy), 'a Claude-environment URL must never ship');
    assert.ok(!/https?:\/\/(?!fonts\.)/.test(policy.replace(/mailto:[^"]*/g, '')),
      'policy links must be internal routes');
  });

  test('the Fetch policy was not quietly turned into a sales policy', () => {
    const fetchPolicy = readWeb('app/restricted-goods/page.tsx');
    assert.match(fetchPolicy, /can&rsquo;t be carried by community drivers/);
    for (const word of ['sell', 'selling', 'marketplace', 'listing']) {
      assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(fetchPolicy.replace(/\/\*[\s\S]*?\*\//g, '')),
        `/restricted-goods must stay about carriage, not ${word}`);
    }
  });
});

/* ── 4. Where it is linked from ─────────────────────────────────────────── */

describe('a business can actually find it', () => {
  test('both legal navigations list it', () => {
    assert.match(readWeb('components/site/LegalLayout.tsx'), /href="\/selling-policy"/);
    assert.match(readWeb('components/site/SiteFooter.tsx'), /href="\/selling-policy"/);
  });

  test('the acceptance surface points at it without asking for a second acceptance', () => {
    const accept = readWeb('components/business/CommercialTermsAccept.tsx');
    assert.match(accept, /href="\/selling-policy"/);
    assert.match(accept, /not a second thing to accept/i);
    // Still exactly one checkbox and one writer call.
    assert.equal((accept.match(/type="checkbox"/g) ?? []).length, 1);
    assert.equal((accept.match(/record_commercial_terms_acceptance/g) ?? []).length, 1);
  });

  test('the products manager offers it without blocking anything', () => {
    const pm = readWeb('components/business/ProductsManager.tsx');
    assert.match(pm, /href="\/selling-policy"/);
    assert.match(pm, /What can I sell on OneShetland\?/);
    // No new gate: the save path is unchanged apart from the link.
    assert.ok(!/selling.?policy.{0,120}(disabled|required|checked)/is.test(pm),
      'the link must not become a condition of saving');
  });
});

/* ── 5. What publishing this must not have disturbed ────────────────────── */

describe('the accepted Terms did not move', () => {
  test('section 11 is textually unchanged from the W3I baseline', () => {
    const terms = readWeb('app/terms/page.tsx');
    const from = terms.search(/<L[^>]*\sh="11\./);
    const to = terms.search(/<L[^>]*\sh="12\./);
    assert.ok(from >= 0 && to > from);
    const section = terms.slice(from, to);
    // The sentence that lets a new policy exist without the Terms changing.
    assert.match(section, /must follow any policy we publish for the feature you&rsquo;re using/);
    assert.match(section, /Where we publish further rules for a feature, they apply from the date we give/);
    // And the anchor and removal powers W3H/W3I depend on.
    assert.match(terms, /<L id="commercial"[^>]*\sh="11\./);
    assert.match(section, /remove a listing, product, service, pass, offer or event/);
    assert.equal((terms.match(/<L[^>]*\sh=/g) ?? []).length, 18, 'no section was added or removed');
  });

  test('the commercial terms version is still 1.0, on both clients and the server', () => {
    const [row] = sql(`select public.commercial_terms_version() as v;`);
    assert.equal(row.v, '1.0');
    assert.match(readWeb('lib/compliance.ts'), /COMMERCIAL_TERMS_VERSION = "1\.0"/);
    assert.match(read('lib/compliance.ts'), /COMMERCIAL_TERMS_VERSION = '1\.0'/);
  });

  test('the policy carries no version of its own that could be mistaken for one', () => {
    // Dated only. A numbered version tied to acceptance would lock every
    // business out of commercial writes until they accepted again.
    assert.ok(!/COMMERCIAL_TERMS_VERSION|document_version|record_commercial_terms_acceptance/.test(policy));
  });

  test('W3I enforcement is untouched and still on', () => {
    const [row] = sql(`
      select (select count(*)::int from pg_trigger
               where tgname='commercial_terms_guard' and not tgisinternal) as guarded,
             (select count(*)::int from pg_trigger
               where tgname='local_businesses_commercial_guard' and not tgisinternal) as lb_guard,
             (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
               where n.nspname='public' and p.proname='business_may_transact') as predicate;`);
    assert.equal(row.guarded, 9);
    assert.equal(row.lb_guard, 1);
    assert.equal(row.predicate, 1);
  });

  test('nobody has to accept anything again because of this', () => {
    // Acceptance is keyed on (user, business, document_version). Publishing a
    // dated operational policy touches none of those.
    const [row] = sql(`
      select count(*)::int as invalidated from public.compliance_log
       where event_type = 'business.commercial_terms_accepted'
         and document_version <> public.commercial_terms_version();`);
    assert.equal(row.invalidated, 0);
  });

  test('no reporting or moderation feature was started', () => {
    const mod = readWeb('lib/moderation.ts');
    for (const t of ['product', 'offer', 'listing', 'service', 'pass', 'ticket']) {
      assert.ok(!new RegExp(`"${t}"`).test(mod), `commercial reporting is a later task — found "${t}"`);
    }
    assert.ok(!/ContentActions|reportContent/.test(policy));
    assert.match(prose, /contact hello@oneshetland\.com/i, 'reporting is by email until the feature exists');
  });
});
