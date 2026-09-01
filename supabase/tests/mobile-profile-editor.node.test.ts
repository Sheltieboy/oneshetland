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

  test('the first run follows Be Found priority, not form history', () => {
    const b = body();
    const at = (needle: string) => { const i = b.indexOf(needle); assert.ok(i > -1, needle); return i; };
    const order = ['onLayout(\'image\')', 'value={name}', 'Category *',
                   'GooglePlacesAutocomplete', 'value={phone}', 'value={website}',
                   'value={email}', 'value={description}'].map(at);
    assert.deepEqual([...order].sort((x, y) => x - y), order,
      'logo, name, category, address, phone, website, email, then about');
  });

  test('the essentials come before the description', () => {
    const b = body();
    // Contact and location are Be Found ESSENTIALS; a description is an
    // improvement after them, so it must not sit between them and the top.
    assert.ok(b.indexOf('value={email}') < b.indexOf('value={description}'),
      'About must come after the contact block');
    assert.ok(b.indexOf('GooglePlacesAutocomplete') < b.indexOf('value={phone}'));
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

  test('contact, description and image are all in the first run', () => {
    // This used to also assert that NO scroll mechanism existed, because Phase
    // 3F sent every Be Found milestone to the top of the section. The refinement
    // that followed aims at each one instead, using onLayout — measured, not
    // guessed — which the tests below pin.
    const b = body();
    assert.ok(b.indexOf('value={phone}') < b.indexOf('>Opening hours<'));
    assert.ok(b.indexOf('value={description}') < b.indexOf('>Opening hours<'));
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

/* ── 7. Phase 3F refinement — a shorter first screen, aimed properly ─────── */

describe('the first viewport is the job, not the furniture', () => {
  test('the logo is a thumbnail row, not a hero block', () => {
    const b = body();
    assert.match(b, /styles\.logoRow/);
    assert.match(b, /styles\.logoThumb/);
    assert.doesNotMatch(raw(), /logoBanner|logoHint/, 'the hero block and its caption are gone');
    // 48pt, so it cannot quietly become a hero again.
    assert.match(ed(), /logoThumb:\s*\{ width: 48, height: 48/);
  });

  test('the upload and the colour it produces are untouched', () => {
    const b = body();
    assert.equal((b.match(/onPress=\{pickLogo\}/g) ?? []).length, 1, 'still one way to change it');
    assert.match(ed(), /brand_color: color/, 'and the extraction still runs on save');
    assert.doesNotMatch(ed(), /cover_url/, 'no cover image was invented');
  });

  test('contact fields are one block, above the fold', () => {
    const b = body();
    const contact = b.indexOf("onLayout('contact')");
    assert.ok(contact > -1, 'the contact block must be anchored');
    for (const f of ['value={phone}', 'value={website}', 'value={email}']) {
      assert.ok(b.indexOf(f) > contact, `${f} belongs inside the contact block`);
    }
    assert.ok(contact < b.indexOf('>Opening hours<'));
  });
});

describe('next lands on the thing it asked about', () => {
  test('every Be Found milestone has somewhere to aim at', () => {
    const b = body();
    for (const key of ['image', 'map_pin', 'contact', 'description']) {
      assert.ok(b.includes(`onLayout('${key}')`), `${key} needs an anchor`);
    }
    assert.match(ed(), /hours:\s+focus === 'opening_hours'/, 'and hours still opens its section');
  });

  test('it scrolls to a measured position, never a guessed one', () => {
    const src = ed();
    assert.match(src, /spots\.current\[key\] = e\.nativeEvent\.layout\.y;/);
    assert.match(src, /scroller\.current\?\.scrollTo\(\{ y: Math\.max\(0, e\.nativeEvent\.layout\.y - 16\)/);
    assert.match(src, /<ScrollView ref=\{scroller\}/);
    // No magic numbers standing in for a layout.
    assert.doesNotMatch(src, /scrollTo\(\{ y: [0-9]{2,}/, 'no hard-coded pixel offsets');
  });

  test('it only moves when NEXT asked it to', () => {
    assert.match(ed(), /if \(key === focus\) \{/,
      'opened normally, the screen starts at the top');
  });

  test('nothing persists — the anchors are layout, not state', () => {
    const src = ed();
    // keyboardShouldPersistTaps is an ordinary RN prop, so this asks about
    // storage specifically.
    assert.doesNotMatch(src, /AsyncStorage|SecureStore|useLocalStorage|persistState/i);
    assert.match(src, /const spots = useRef<Record<string, number>>\(\{\}\);/,
      'positions live in a ref for the life of the screen');
  });
});

describe('the Phase 3F structure did not regress', () => {
  test('all three disclosures still collapse by default', () => {
    const b = body();
    for (const k of ['hours', 'offer', 'visitors']) {
      assert.ok(b.includes(`{open.${k} && (<>`), `${k} must stay behind its summary`);
    }
  });

  test('and payments are still not here', () =>
    assert.doesNotMatch(raw(), /Payments & Payouts|use_business_pay/));
});
