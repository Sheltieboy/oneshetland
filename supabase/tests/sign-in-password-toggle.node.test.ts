/**
 * sign-in-password-toggle.node.test.ts
 *
 * The sign-in screen's show/hide-password control. A usability change only: the
 * password value, the CAPTCHA flow and the Supabase call must be exactly as they
 * were. These tests EXECUTE the real source (the real togglePasswordVisibility
 * and handleSignIn bodies, the real passwordVisibility helper) against fakes —
 * see _support/load-source.ts — and pin the rest by source shape.
 *
 * NOT covered here, and not coverable under node: how it looks and feels on a
 * device (icon placement, keyboard staying up, AutoFill interplay). That needs a
 * physical check.
 *
 * SAFETY: no network, no Supabase, no Turnstile.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { passwordVisibility } from '../../lib/password-visibility.ts';
import { createAuthStageLogger } from '../../lib/auth-stage.ts';
import { extractFunction, extractConst, instantiate, readRepo } from './_support/load-source.ts';

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const SIGN_IN_SRC = readRepo('app/(auth)/sign-in.tsx');
const INPUT_SRC = readRepo('components/ui/Input.tsx');

const SECRET = 'Sp4ced  Pass-W0rd!';

/** A minimal useState cell: the real handler's setState(updater) is applied for real. */
function stateCell<T>(initial: T) {
  const cell = { value: initial, sets: 0 };
  const set = (next: T | ((prev: T) => T)) => {
    cell.sets++;
    cell.value = typeof next === 'function' ? (next as (p: T) => T)(cell.value) : next;
  };
  return { cell, set };
}

/** The REAL togglePasswordVisibility, with only the reveal state (and tripwires) in scope. */
function makeToggle(initial = false) {
  const reveal = stateCell(initial);
  const touched = { setPassword: 0, setEmail: 0 };
  const scope = {
    setShowPassword: reveal.set,
    // Tripwires: if the real handler ever writes the credentials, these record it.
    setPassword: () => { touched.setPassword++; },
    setEmail: () => { touched.setEmail++; },
    password: SECRET,
  };
  const press = instantiate<() => void>(extractFunction(SIGN_IN_SRC, 'function togglePasswordVisibility'), scope);
  return { press, reveal: reveal.cell, touched };
}

/** The REAL handleSignIn body, with CAPTCHA and Supabase faked. */
function makeSignIn(password: string, email = '  Person@Example.com ') {
  const calls: string[][] = [];
  const errors: (string | null)[] = [];
  const loading: boolean[] = [];
  const stages: [string, unknown][] = [];
  const submitting = { current: false };
  const run = instantiate<() => Promise<void>>(extractFunction(SIGN_IN_SRC, 'async function handleSignIn'), {
    isSupabaseConfigured: true,
    email,
    password,
    setError: (e: string | null) => errors.push(e),
    setLoading: (v: boolean) => loading.push(v),
    submitting,
    alert: () => {},
    TIMEOUT_ALERT: extractConst(SIGN_IN_SRC, 'TIMEOUT_ALERT'),
    logAuthStage: (s: string, d?: unknown) => stages.push([s, d]),
    getTurnstileToken: async () => ({ ok: true, token: 'CAPTCHA-TOKEN' }),
    signIn: async (e: string, p: string, t: string) => { calls.push([e, p, t]); return { error: null }; },
  });
  return { run, calls, errors, loading, stages };
}

describe('the show/hide password control', () => {
  test('1. the password is hidden initially — by state, by helper, and on the field', () => {
    assert.match(code(SIGN_IN_SRC), /const \[showPassword, setShowPassword\] = useState\(false\);/);
    assert.equal(passwordVisibility(false).secureTextEntry, true);
    // The field is masked from the state — never a hard-coded `secureTextEntry`, never `false`.
    assert.match(code(SIGN_IN_SRC), /secureTextEntry=\{pw\.secureTextEntry\}/);
    assert.doesNotMatch(code(SIGN_IN_SRC).replace('secureTextEntry={pw.secureTextEntry}', ''), /secureTextEntry/);
    assert.equal(makeToggle().reveal.value, false);
  });

  test('2. tapping the eye reveals the password', () => {
    const { press, reveal } = makeToggle();
    press();
    assert.equal(reveal.value, true);
    assert.equal(passwordVisibility(reveal.value).secureTextEntry, false, 'the field is now unmasked');
  });

  test('3. tapping again hides it, and it keeps alternating', () => {
    const { press, reveal } = makeToggle();
    press();
    press();
    assert.equal(reveal.value, false);
    assert.equal(passwordVisibility(reveal.value).secureTextEntry, true);
    for (let i = 0; i < 6; i++) press();
    assert.equal(reveal.value, false, 'even number of presses → hidden');
    press();
    assert.equal(reveal.value, true);
  });

  test('4. the password value is untouched by toggling — the handler never reads or writes it', () => {
    const { press, touched } = makeToggle();
    for (let i = 0; i < 5; i++) press();
    assert.deepEqual(touched, { setPassword: 0, setEmail: 0 });
    // And structurally: the handler's only state write is the reveal flag.
    const body = code(extractFunction(SIGN_IN_SRC, 'function togglePasswordVisibility'));
    assert.equal(body.replace(/togglePasswordVisibility|setShowPassword|showPassword/g, '').match(/password|email/i), null);
    assert.equal((code(SIGN_IN_SRC).match(/setShowPassword\(/g) ?? []).length, 1, 'nothing else ever changes the reveal state');
  });

  test('5. the accessibility label and icon follow the state', () => {
    assert.equal(passwordVisibility(false).accessibilityLabel, 'Show password');
    assert.equal(passwordVisibility(true).accessibilityLabel, 'Hide password');
    assert.equal(passwordVisibility(false).icon, 'eye');
    assert.equal(passwordVisibility(true).icon, 'eye-slash');
    const { press, reveal } = makeToggle();
    assert.equal(passwordVisibility(reveal.value).accessibilityLabel, 'Show password');
    press();
    assert.equal(passwordVisibility(reveal.value).accessibilityLabel, 'Hide password');
    press();
    assert.equal(passwordVisibility(reveal.value).accessibilityLabel, 'Show password');
    // The control actually uses them, as a button, with the existing icon library.
    const src = code(SIGN_IN_SRC);
    assert.match(src, /accessibilityRole="button"/);
    assert.match(src, /accessibilityLabel=\{pw\.accessibilityLabel\}/);
    assert.match(src, /<FontAwesome5 name=\{pw\.icon\}/);
    assert.match(src, /import \{ FontAwesome5 \} from '@expo\/vector-icons';/);
  });

  test('5b. the touch target is comfortable (>= 44pt), full field height, and sits inside the field on the right', () => {
    const style = /passwordToggle:\s*\{([^}]*)\}/.exec(SIGN_IN_SRC)?.[1] ?? '';
    const width = Number(/width:\s*(\d+)/.exec(style)?.[1]);
    assert.ok(width >= 44, `width ${width}`);
    assert.match(style, /height:\s*'100%'/);
    assert.match(code(SIGN_IN_SRC), /onPress=\{togglePasswordVisibility\}[\s\S]*?hitSlop=/);
    // Input renders it in an absolute right-hand slot over the field, and reserves room for it.
    assert.match(INPUT_SRC, /rightSlot:\s*\{[^}]*position: 'absolute'[^}]*right: 0/);
    assert.match(INPUT_SRC, /inputWithRight:\s*\{[^}]*paddingRight: (\d+)/);
    assert.ok(Number(/inputWithRight:\s*\{[^}]*paddingRight: (\d+)/.exec(INPUT_SRC)?.[1]) >= width);
  });

  test('6. sign-in receives exactly the same password, whatever the reveal state', async () => {
    const { press } = makeToggle();
    const s = makeSignIn(SECRET);
    await s.run();       // hidden
    press();
    await s.run();       // revealed
    press();
    await s.run();       // hidden again
    assert.equal(s.calls.length, 3);
    for (const [email, password, token] of s.calls) {
      assert.equal(password, SECRET, 'verbatim — not trimmed, not re-cased, not altered');
      assert.equal(email, 'person@example.com', 'the email is normalised exactly as before');
      assert.equal(token, 'CAPTCHA-TOKEN');
    }
    assert.deepEqual(s.loading, [true, false, true, false, true, false]);
  });

  test('6b. the sign-in handler does not depend on the reveal state at all, and still needs a CAPTCHA token', () => {
    const handler = code(extractFunction(SIGN_IN_SRC, 'async function handleSignIn'));
    assert.doesNotMatch(handler, /showPassword|pw\b|passwordVisibility/);
    assert.ok(handler.indexOf('await getTurnstileToken()') < handler.indexOf('await signIn('));
    assert.match(handler, /if \(!turnstile\.ok\)/);
  });

  test('7. no password contents are logged — console, diagnostics or analytics — while toggling and signing in', async () => {
    const consoleOut: string[] = [];
    const lines: string[] = [];
    const tracked: unknown[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    console.log = console.warn = console.error = console.info = ((...a: unknown[]) =>
      consoleOut.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))) as never;
    try {
      const { press } = makeToggle();
      const s = makeSignIn(SECRET);
      const real = createAuthStageLogger({ log: (l) => lines.push(l), track: (n, p) => tracked.push([n, p]) });
      press(); await s.run(); press(); await s.run();
      // Whatever the screen tried to record, pass it through the REAL redactor too.
      for (const [stage, detail] of s.stages) real(stage as never, detail as never);
    } finally { Object.assign(console, orig); }
    const everything = JSON.stringify([consoleOut, lines, tracked]);
    assert.ok(!everything.includes(SECRET));
    assert.ok(!everything.includes('CAPTCHA-TOKEN'));
    // Source level: the toggle and its wiring never log, and the screen never calls track().
    const src = code(SIGN_IN_SRC);
    const toggle = code(extractFunction(SIGN_IN_SRC, 'function togglePasswordVisibility'));
    assert.doesNotMatch(toggle, /console\.|logAuthStage|track\(/);
    assert.doesNotMatch(src, /\btrack\(/);
    assert.doesNotMatch(src, /console\.[a-z]+\([^)]*\bpassword\b/);
  });

  test('the reveal state is never persisted, never auto-set, and resets on every mount', () => {
    const src = code(SIGN_IN_SRC);
    assert.doesNotMatch(src, /AsyncStorage|SecureStore|localStorage|MMKV|sessionStorage/);
    assert.doesNotMatch(src, /useEffect|useLayoutEffect/, 'no effect exists that could reveal it');
    assert.match(src, /useState\(false\)/);
    // Two mounts of a component whose state starts false both start hidden, whatever happened before.
    const first = makeToggle();
    first.press();
    assert.equal(first.reveal.value, true);
    const second = makeToggle();
    assert.equal(second.reveal.value, false, 'a fresh mount starts hidden');
    assert.equal(passwordVisibility(second.reveal.value).secureTextEntry, true);
  });

  test('focus and AutoFill are left alone: no blur/dismiss, same field props, same tap-persisting scroll view', () => {
    const src = code(SIGN_IN_SRC);
    const toggle = code(extractFunction(SIGN_IN_SRC, 'function togglePasswordVisibility'));
    assert.doesNotMatch(toggle, /Keyboard|blur|focus|dismiss/i);
    // The password field keeps its AutoFill hint, submit behaviour and single TextInput.
    const field = /label="Password"[\s\S]*?rightElement=/.exec(src)?.[0] ?? '';
    assert.match(field, /autoComplete="password"/);
    assert.match(field, /returnKeyType="done"/);
    assert.match(field, /onSubmitEditing=\{handleSignIn\}/);
    assert.match(field, /value=\{password\}/);
    assert.match(field, /onChangeText=\{setPassword\}/);
    // A tap on the eye must not dismiss the keyboard: the ScrollView persists "handled" taps.
    assert.match(src, /keyboardShouldPersistTaps="handled"/);
    // Input builds one TextInput and places it in the same tree either way — not a second, remounted field.
    assert.equal((code(INPUT_SRC).match(/<TextInput/g) ?? []).length, 1);
    assert.match(code(INPUT_SRC), /\) : field\}/, 'without a right element, the field renders exactly as before');
  });

  test('the change is scoped: only the sign-in password field takes the new slot, and the email field is untouched', () => {
    assert.equal((code(SIGN_IN_SRC).match(/rightElement=/g) ?? []).length, 1);
    const email = /label="Email address"[\s\S]*?\/>/.exec(code(SIGN_IN_SRC))?.[0] ?? '';
    assert.doesNotMatch(email, /rightElement|secureTextEntry/);
  });
});
