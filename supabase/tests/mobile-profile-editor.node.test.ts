/**
 * mobile-profile-editor.node.test.ts — Business 2.0 Phase 3F.
 *
 * "Edit business" held six unrelated subjects in one column: profile, contact,
 * a services taxonomy, seven days of opening-hours controls, the whole visitor
 * questionnaire, and payment/payout toggles. Contact details sat BELOW the
 * questionnaire, so an owner sent here by "Add a way customers can contact you"
 * arrived at a form and had to scroll past three other subjects to do the one
 * thing they had been asked to do.
 *
 * Same fields, same writes, arranged so the primary job is the primary thing.
 *
 * Run: npm test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string) => readFileSync(join(REPO_ROOT, p), 'utf8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ED = 'app/local-business-register.tsx';
const ed = () => code(ED);
const raw = () => read(ED);
const DASH = 'app/local-business-dashboard.tsx';

/** The rendered body, so a field's mere presence in state does not count. */
const body = () => { const s = raw(); return s.slice(s.indexOf('<ScrollView')); };

/* ── 1. Every field survives ──────────────────────────────────────────────── */

describe('nothing was lost in the move', () => {
  test('every profile write is still sent', () => {
    const payload = ed().slice(ed().indexOf('const payload'), ed().indexOf('};', ed().indexOf('const payload')));
    for (const f of ['name', 'category', 'description', 'address', 'lat, lng',
                     'phone', 'website', 'email', 'tags', 'opening_hours']) {
      assert.ok(payload.includes(f), `${f} must still be written`);
    }
    assert.match(payload, /hasPlannerContext\(planner\)/, 'the visitor answers still save');
    assert.match(ed(), /logo_url: uploaded\.publicUrl/, 'and the logo');
    assert.match(ed(), /brand_color: color/, 'and the colour taken from it');
  });

  test('every editable control is still rendered somewhere', () => {
    const b = body();
    for (const control of ['value={name}', 'value={description}', 'value={phone}',
                           'value={website}', 'value={email}', 'onPress={pickLogo}',
                           'GooglePlacesAutocomplete', '<OpeningHoursEditor',
                           '<PlannerContextEditor']) {
      assert.ok(b.includes(control), `${control} must still exist`);
    }
  });

  test('the location mechanism is unchanged — no second map was introduced', () => {
    assert.match(ed(), /setLat\(details\.geometry\.location\.lat\)/);
    assert.doesNotMatch(ed(), /MapPinPicker|draggable/i, 'typing an address beats dragging a pin on a phone');
  });
});

/* ── 2. Profile and contact come first ────────────────────────────────────── */

describe('the primary job is the primary thing', () => {
  test('contact details sit above the collapsed sections', () => {
    const b = body();
    const phone = b.indexOf('value={phone}');
    const website = b.indexOf('value={website}');
    const email = b.indexOf('value={email}');
    const hours = b.indexOf('>Opening hours<');
    const offer = b.indexOf('>What you offer<');
    const visitors = b.indexOf('>For visitors<');
    for (const [name, i] of [['phone', phone], ['website', website], ['email', email]] as const) {
      assert.ok(i > -1, `${name} must render`);
      assert.ok(i < hours && i < offer && i < visitors,
        `${name} must come before the collapsed sections`);
    }
  });

  test('address and about are in the same first run', () => {
    const b = body();
    assert.ok(b.indexOf('GooglePlacesAutocomplete') < b.indexOf('>Opening hours<'));
    assert.ok(b.indexOf('value={description}') < b.indexOf('>Opening hours<'));
  });
});

/* ── 3. Progressive disclosure ────────────────────────────────────────────── */

describe('three subjects summarised, not spread out', () => {
  test('opening hours shows a summary and opens the real editor', () => {
    const b = body();
    assert.match(b, /\{hoursSummary\}/);
    assert.match(b, /\{open\.hours && \(<>/);
    const idx = b.indexOf('<OpeningHoursEditor');
    assert.ok(b.lastIndexOf('{open.hours && (<>', idx) > -1,
      'the seven-day editor must sit behind the disclosure');
  });

  test('the summary reads the week, and invents no rules', () => {
    const src = ed();
    assert.match(src, /function summariseHours/);
    assert.match(src, /if \(!hasAnyHours\(hours\)\) return 'Not set';/);
    // Presentation only: the stored shape and the Closed/overnight rules stay
    // with OpeningHoursEditor.
    assert.doesNotMatch(src.slice(src.indexOf('function summariseHours'), src.indexOf('export default')),
      /setHours|Closed|midnight/i);
  });

  test('the services taxonomy is not rendered by default', () => {
    const b = body();
    assert.match(b, /\{offerSummary\}/);
    assert.match(b, /\{open\.offer && \(<>/);
    const chips = b.indexOf('Services &amp; trades');
    assert.ok(b.lastIndexOf('{open.offer && (<>', chips) > -1, 'the chip wall is behind the disclosure');
  });

  test('selections are shown, never asked for again', () => {
    assert.match(ed(), /tags\.length === 0\s*\n?\s*\? 'Nothing selected'/);
    assert.match(ed(), /\$\{tags\.slice\(0, 2\)\.join\(' · '\)\} · \$\{tags\.length - 2\} more/);
    assert.match(ed(), /setTags\(b\.tags \?\? \[\]\)/, 'existing choices still load');
  });

  test('the visitor questionnaire is not rendered by default', () => {
    const b = body();
    assert.match(b, /\{visitorSummary\}/);
    assert.match(b, /\{open\.visitors && \(<>/);
    const q = b.indexOf('<PlannerContextEditor');
    assert.ok(b.lastIndexOf('{open.visitors && (<>', q) > -1);
  });

  test('unanswered visitor questions are optional, not errors', () => {
    const src = ed();
    const summary = src.slice(src.indexOf('const visitorSummary'), src.indexOf('const visitorSummary') + 300);
    assert.match(summary, /Optional/);
    for (const scold of ['required', 'missing', 'incomplete', 'error', 'needed']) {
      assert.ok(!summary.toLowerCase().includes(scold), `must not say "${scold}"`);
    }
  });

  test('no score, ring or percentage was added', () =>
    assert.doesNotMatch(ed(), /% complete|completion|progressRing|setupPercent/i));
});

/* ── 4. Money left profile ────────────────────────────────────────────────── */

describe('payments and payouts are not profile', () => {
  test('the editor no longer renders or writes them', () => {
    const src = raw();
    assert.doesNotMatch(src, /Payments & Payouts/);
    assert.doesNotMatch(src, /use_business_payment|use_business_payout/,
      'a duplicate write path is how two truths start');
  });

  test('and both toggles still live in Money on Business Home', () => {
    const d = code(DASH);
    assert.match(d, /updateBusiness\(activeBusiness\.id, \{ use_business_payment: value \}/);
    assert.match(d, /updateBusiness\(activeBusiness\.id, \{ use_business_payout: value \}/);
    const money = read(DASH).slice(read(DASH).indexOf('>Money<'), read(DASH).indexOf('>Grow<'));
    assert.match(money, /use_business_payment/, 'and are reachable from the Money section');
  });

  test('no Stripe or payout logic was touched', () => {
    // The business-email hint still explains what the address is used for, and
    // that is copy, not logic. What must not be here is any Stripe CALL or
    // payout setting.
    assert.doesNotMatch(ed(), /account_link|payout_enabled|stripe_account|supabase\.functions\.invoke/i);
    const hits = ed().split('\n').filter((l) => /stripe/i.test(l));
    assert.deepEqual(hits.map((l) => l.trim()),
      ['<Text style={styles.fieldHint}>Used for Stripe payouts and account verification</Text>'],
      'the only mention of Stripe left is a hint on the email field');
  });
});

/* ── 5. NEXT lands where it sent you ──────────────────────────────────────── */

describe('being told what to do, then taken there', () => {
  test('the editor accepts a focus and opens that section', () => {
    assert.match(ed(), /useLocalSearchParams<\{ focus\?: string \}>\(\)\.focus/);
    assert.match(ed(), /hours:\s+focus === 'opening_hours'/);
  });

  test('Home passes the milestone NEXT actually asked for', () => {
    assert.match(code(DASH), /const editBusiness = \(focus\?: string\) =>/);
    assert.match(code(DASH), /\.\.\.\(focus \? \{ focus \} : \{\}\)/);
    assert.match(code(DASH), /onPress=\{\(\) => editBusiness\(next\.key\)\}/);
  });

  test('contact, description and image land on the profile run, which is the top', () => {
    // Those three fields are in the first section, so no anchor machinery is
    // needed — and none was added.
    const b = body();
    assert.ok(b.indexOf('value={phone}') < b.indexOf('>Opening hours<'));
    assert.doesNotMatch(ed(), /scrollTo\(|measureLayout|useRef<ScrollView/,
      'no brittle scroll state was invented');
  });
});

/* ── 6. Be Found is untouched ─────────────────────────────────────────────── */

describe('the derivation did not move', () => {
  test('be-found.ts is unchanged and still a copy of web', () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !l.trim().startsWith('import ')).join('\n')
      .replace(/\n{2,}/g, '\n').trim();
    assert.equal(strip(read('lib/be-found.ts')),
                 strip(readFileSync(join(REPO_ROOT, '..', 'oneshetland-web', 'lib', 'be-found.ts'), 'utf8')));
  });

  test('and is_active is still no part of it', () =>
    assert.doesNotMatch(code('lib/be-found.ts'), /is_active/));
});
