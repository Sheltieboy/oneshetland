/**
 * mobile-onboarding-wizard.node.test.ts
 *
 * Mandatory account-level onboarding (display name, resident/visitor, area
 * if resident, optional photo) — proven end to end:
 *
 *   - the migration adds a nullable completion column and grandfathers
 *     existing accounts at MIGRATION time, never at their own created_at
 *   - a genuinely new account gets NULL, with no trigger change needed
 *   - app/_layout.tsx routes any authenticated, incomplete-onboarding
 *     session to /onboarding — for every route, not only the auth-group
 *     handoff — while leaving the small set of infrastructure/callback
 *     routes usable, and without looping on itself
 *   - the screen enforces its own required fields and writes the completion
 *     timestamp in the SAME update as the fields it certifies
 *   - a failed save cannot mark completion, and a successful one refreshes
 *     the in-memory profile via the existing refreshProfile() mechanism
 *     BEFORE navigating away — the one thing that would otherwise create a
 *     stale-profile redirect loop
 *   - the intro tour, CAPTCHA/auth flows, the live Stripe urlScheme line and
 *     payment-return.tsx are all untouched by this work
 *
 * SAFETY
 * Source-level assertions only. No Supabase Auth call, no database write, no
 * signup, no sign-in, no OTA. Nothing here can create a user or mutate
 * production. Supabase CAPTCHA enforcement is unaffected by this file either
 * way — it asserts source shape, not live behaviour.
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
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--|\*).*$/gm, '');

const migration     = read('supabase/migrations/20261014000000_profile_onboarding_completed.sql');
const layout         = code(read('app/_layout.tsx'));
const onboarding     = code(read('app/onboarding.tsx'));
const introScreen    = code(read('app/intro.tsx'));
const paymentReturn  = read('app/payment-return.tsx'); // exact bytes — must be untouched
const authContext    = code(read('context/AuthContext.tsx'));
const mobileSignIn   = code(read('app/(auth)/sign-in.tsx'));
const profileType    = code(read('types/database.ts'));

/* ── 1, 2, 3. Migration ───────────────────────────────────────────────────── */

describe('the migration adds a nullable completion column, grandfathered at migration time', () => {
  test('the column is added with no NOT NULL constraint and no forcing default', () => {
    assert.match(migration, /add column onboarding_completed_at timestamptz null/);
    assert.doesNotMatch(migration, /onboarding_completed_at[^;]*default (?!null)/i);
  });

  test('existing rows are backfilled with now(), never with created_at', () => {
    const start = migration.indexOf('update public.profiles');
    const backfill = migration.slice(start, migration.indexOf(';', start) + 1);
    assert.match(backfill, /set onboarding_completed_at = now\(\)/);
    assert.doesNotMatch(backfill, /created_at/);
  });

  test('the backfill only touches rows that are still null — never overwrites a real value', () => {
    assert.match(migration, /where onboarding_completed_at is null/);
  });

  test('column add and backfill are the same migration file — one transaction, no window for a new signup to land in between', () => {
    const addIdx = migration.indexOf('add column onboarding_completed_at');
    const backfillIdx = migration.indexOf('update public.profiles');
    assert.ok(addIdx !== -1 && backfillIdx !== -1 && addIdx < backfillIdx);
  });
});

/* ── New accounts default to NULL — no trigger change needed ─────────────── */

describe('a genuinely new account receives NULL, with zero trigger changes', () => {
  test('no migration touches handle_new_user() to set this column', () => {
    // The only place onboarding_completed_at may legitimately be written is
    // the wizard's own update call (checked below) — never the signup trigger.
    const triggerFiles = [
      read('supabase/migrations/20260623000000_baseline_remote_schema.sql'),
    ];
    for (const src of triggerFiles) {
      const fnStart = src.indexOf('CREATE FUNCTION public.handle_new_user');
      if (fnStart === -1) continue;
      const fnBody = src.slice(fnStart, src.indexOf('$$;', fnStart));
      assert.doesNotMatch(fnBody, /onboarding_completed_at/);
    }
  });

  test('the trigger only ever sets id, role and full_name — every other column, including the new one, is left to its default', () => {
    const src = read('supabase/migrations/20260623000000_baseline_remote_schema.sql');
    const fnStart = src.indexOf('CREATE FUNCTION public.handle_new_user');
    const fnBody = src.slice(fnStart, src.indexOf('$$;', fnStart));
    assert.match(fnBody, /INSERT INTO public\.profiles \(id, role, full_name\)/);
  });
});

/* ── 4, 5, 6, 7, 8. Routing gate ───────────────────────────────────────────── */

describe('app/_layout.tsx routes an incomplete-onboarding session to /onboarding', () => {
  test('the gate checks profile.onboarding_completed_at, not session alone', () => {
    assert.match(layout, /if \(profile && !profile\.onboarding_completed_at && !onOnboardingScreen && !isInfrastructureRoute\) \{/);
  });

  test('it runs before the auth-group destination logic, so it applies to every authenticated route — not only the sign-in → tabs handoff', () => {
    const gateIdx = layout.indexOf('if (profile && !profile.onboarding_completed_at');
    const authGroupDestIdx = layout.indexOf("if (inAuthGroup || (segments as string[])[0] === 'index'");
    assert.ok(gateIdx !== -1 && authGroupDestIdx !== -1 && gateIdx < authGroupDestIdx,
      'the onboarding gate must be evaluated before the narrower auth-group redirect, not instead of it');
  });

  test('it is not scoped to any particular segment/group — no inAuthGroup/inCustomerGroup/etc. guard wraps it', () => {
    const gateIdx = layout.indexOf('if (profile && !profile.onboarding_completed_at');
    const block = layout.slice(layout.lastIndexOf('\n\n', gateIdx), gateIdx);
    assert.doesNotMatch(block, /if \(in(Auth|Customer|Driver|Admin)Group/);
  });

  test('onboarding cannot redirect itself — the gate excludes its own segment', () => {
    assert.match(layout, /const onOnboardingScreen = \(segments as string\[\]\)\[0\] === 'onboarding';/);
  });

  test('infrastructure/callback routes are exempt: auth confirm, Turnstile callback, payment-return', () => {
    const block = layout.slice(layout.indexOf('const isInfrastructureRoute'), layout.indexOf('if (profile && !profile.onboarding_completed_at'));
    assert.match(block, /=== 'auth'/);
    assert.match(block, /=== 'turnstile-callback'/);
    assert.match(block, /=== 'payment-return'/);
  });

  test('ordinary content deep-link segments (t, nfc, g) are NOT in the infrastructure exemption — they are gated too', () => {
    const block = layout.slice(layout.indexOf('const isInfrastructureRoute'), layout.indexOf('if (profile && !profile.onboarding_completed_at'));
    assert.doesNotMatch(block, /segments as string\[\]\)\[0\] === 't'/);
    assert.doesNotMatch(block, /segments as string\[\]\)\[0\] === 'nfc'/);
    assert.doesNotMatch(block, /segments as string\[\]\)\[0\] === 'g'/);
  });

  test('the intended destination is preserved via the same sanitizeNext/next mechanism sign-in already uses', () => {
    const gateBlock = layout.slice(layout.indexOf('if (profile && !profile.onboarding_completed_at'), layout.indexOf('if (profile && !profile.onboarding_completed_at') + 400);
    assert.match(gateBlock, /const dest = sanitizeNext\(pathname\);/);
    assert.match(gateBlock, /`\/onboarding\?next=\$\{encodeURIComponent\(dest\)\}`/);
  });

  test('onboarding is registered as a real Stack screen', () => {
    assert.match(layout, /<Stack\.Screen name="onboarding" \/>/);
  });

  test('the routing effect re-runs when pathname or profile change', () => {
    const depsLine = layout.match(/\}, \[session, profile,[^\]]*\]\);/)?.[0] ?? '';
    assert.match(depsLine, /\bpathname\b/);
    assert.match(depsLine, /\bprofile\b/);
  });
});

/* ── The wizard screen's own required-field enforcement ───────────────────── */

describe('app/onboarding.tsx enforces the required fields client-side', () => {
  test('display name is required before Complete setup can be pressed', () => {
    assert.match(onboarding, /displayName\.trim\(\)\.length > 0/);
    assert.match(onboarding, /if \(!displayName\.trim\(\)\) \{/);
  });

  test('audience (resident/visitor) is required', () => {
    assert.match(onboarding, /audience !== null/);
    assert.match(onboarding, /if \(!audience\) \{/);
  });

  test('area is required only when resident is selected — not for visiting', () => {
    assert.match(onboarding, /const needsArea = audience === 'resident';/);
    assert.match(onboarding, /\(!needsArea \|\| area\.length > 0\)/);
    assert.match(onboarding, /if \(needsArea && !area\) \{/);
  });

  test('the submit button is disabled until the required fields are satisfied', () => {
    assert.match(onboarding, /disabled=\{!canSave \|\| uploadingAvatar\}/);
  });

  test('avatar is provably optional — completion never checks avatarUrl', () => {
    const validation = onboarding.slice(
      onboarding.indexOf('const handleComplete'),
      onboarding.indexOf('savingRef.current = true'),
    );
    assert.doesNotMatch(validation, /avatarUrl/);
  });

  test('no excluded field is anywhere in this screen: payment card, Stripe payouts, games handle, phone, business/hub setup', () => {
    assert.doesNotMatch(onboarding, /has_payment_method|stripe_account_id|stripe_onboarding_complete|CardSetup|ConnectPayouts/i);
    assert.doesNotMatch(onboarding, /games_handle/);
    assert.doesNotMatch(onboarding, /\bphone\b/);
    assert.doesNotMatch(onboarding, /business|hub/i);
  });

  test('there is no skip / finish-later control', () => {
    assert.doesNotMatch(onboarding, /[Ss]kip|[Ff]inish later/);
  });
});

/* ── One update, completion written with the fields it certifies ─────────── */

describe('the completion write is atomic with the fields it certifies', () => {
  test('a single .update() call carries display_name, avatar_url, audience, location_area and onboarding_completed_at together', () => {
    const updateStart = onboarding.indexOf('.update({');
    const eqStart = onboarding.indexOf(".eq('id', profile.id)", updateStart);
    const call = onboarding.slice(updateStart, eqStart);
    assert.match(call, /display_name:\s*displayName\.trim\(\)/);
    assert.match(call, /avatar_url:\s*avatarUrl \|\| null/);
    assert.match(call, /audience,/);
    assert.match(call, /location_area:\s*needsArea \? area : null/);
    assert.match(call, /onboarding_completed_at:\s*new Date\(\)\.toISOString\(\)/);
  });

  test('a failed save does not refresh the profile, does not navigate, and surfaces an error', () => {
    const i = onboarding.indexOf('if (error) {');
    const block = onboarding.slice(i, i + 220);
    assert.match(block, /alert\(\{ title: 'Could not save'/);
    assert.doesNotMatch(block, /refreshProfile\(\)/);
    assert.doesNotMatch(block, /router\.replace/);
    assert.match(block, /return;/);
  });
});

/* ── Client-state refresh BEFORE navigation — the redirect-loop guard ────── */

describe('successful completion refreshes in-memory profile before leaving the screen', () => {
  test('refreshProfile() is awaited, and it runs before router.replace, not after', () => {
    assert.match(onboarding, /await refreshProfile\(\);/);
    const refreshIdx = onboarding.indexOf('await refreshProfile();');
    const navigateIdx = onboarding.indexOf("router.replace((sanitizeNext(next)");
    assert.ok(refreshIdx !== -1 && navigateIdx !== -1 && refreshIdx < navigateIdx,
      'the in-memory profile must be refreshed before this screen navigates away, or app/_layout.tsx would still see it as incomplete and redirect straight back');
  });

  test('it reuses the existing AuthContext mechanism — no second/independent profile store is introduced', () => {
    // Same one useAuth() call for everything this screen needs from context,
    // signOut included (see the Sign out describe block below) — never a
    // second, separately-fetched profile.
    assert.match(onboarding, /const \{ profile, refreshProfile, signOut \} = useAuth\(\);/);
    assert.doesNotMatch(onboarding, /useState.*profile.*Profile\b/); // no local profile state shadowing context
  });

  test('refreshProfile() itself re-fetches from the database and updates context state — proven at its definition', () => {
    assert.match(authContext, /async function refreshProfile\(\) \{/);
    assert.match(authContext, /await fetchProfile\(session\.user\.id\);/);
    // fetchProfile does a real select('*') and setProfile(data) — the same
    // path every other screen (e.g. edit-profile.tsx) already trusts.
    assert.match(authContext, /\.select\('\*'\)/);
    assert.match(authContext, /setProfile\(data as Profile\)/);
  });
});

/* ── Regression: everything this task must not touch ──────────────────────── */

describe('the intro tour is untouched — a separate, device-scoped feature', () => {
  test('intro.tsx still gates on AsyncStorage, not any account/profile field', () => {
    assert.match(introScreen, /INTRO_SEEN_KEY = 'intro_seen_v1'/);
    assert.doesNotMatch(introScreen, /onboarding_completed_at/);
  });

  test('the intro gate in app/_layout.tsx is unchanged in shape — still keyed on AsyncStorage, still excludes its own segment', () => {
    assert.match(layout, /AsyncStorage\.getItem\(INTRO_SEEN_KEY\)\.then\(v => \{\s*if \(v !== '1'\) router\.replace\('\/intro'\);/);
  });
});

describe('CAPTCHA/auth flows are untouched', () => {
  test('AuthContext.signIn still requires and forwards captchaToken', () => {
    assert.match(authContext, /async function signIn\(email: string, password: string, captchaToken: string\)/);
    assert.match(authContext, /options: \{ captchaToken \}/);
  });

  test('the mobile sign-in screen still obtains a Turnstile token before calling signIn()', () => {
    assert.match(mobileSignIn, /await getTurnstileToken\(\)/);
    assert.match(mobileSignIn, /if \(!turnstile\.ok\) \{/);
  });
});

describe('the live Stripe urlScheme line and payment-return.tsx are untouched', () => {
  test('urlScheme="oneshetland-fetch" is still present on StripeProvider', () => {
    assert.match(layout, /urlScheme="oneshetland-fetch"/);
  });

  test('payment-return.tsx does no confirmation/financial work — unchanged, pure navigation', () => {
    assert.doesNotMatch(paymentReturn, /supabase\.|fetch\(|invoke\(/);
    assert.match(paymentReturn, /router\.canGoBack\(\)/);
    assert.match(paymentReturn, /router\.replace\('\/\(tabs\)'\)/);
  });
});

/* ── Profile type carries the new field ────────────────────────────────────── */

describe('the Profile type includes the new column', () => {
  test('onboarding_completed_at is typed as string | null', () => {
    assert.match(profileType, /onboarding_completed_at:\s*string \| null;/);
  });
});

/* ── Onboarding is mandatory, but never a trap: a real sign-out exists ───── */

describe('app/onboarding.tsx exposes a Sign out escape hatch', () => {
  test('it destructures signOut from the same AuthContext every other screen uses — no separate mechanism', () => {
    assert.match(onboarding, /const \{ profile, refreshProfile, signOut \} = useAuth\(\);/);
  });

  test('handleSignOut calls the canonical signOut() directly — no reimplemented logout logic', () => {
    const i = onboarding.indexOf('const handleSignOut');
    const body = onboarding.slice(i, onboarding.indexOf('const handleComplete', i));
    assert.match(body, /onPress: signOut \}/);
    // Not a bespoke call — no supabase.auth.signOut() or clearPushToken here;
    // that's all inside AuthContext.signOut() already.
    assert.doesNotMatch(body, /supabase\.auth\.signOut/);
    assert.doesNotMatch(body, /clearPushToken/);
  });

  test('signing out performs no profile write of any kind — no update, no onboarding_completed_at, no other field', () => {
    const i = onboarding.indexOf('const handleSignOut');
    const j = onboarding.indexOf('const handleComplete', i);
    const body = onboarding.slice(i, j);
    assert.doesNotMatch(body, /\.from\('profiles'\)/);
    assert.doesNotMatch(body, /\.update\(/);
    assert.doesNotMatch(body, /onboarding_completed_at/);
  });

  test('the Sign out control is rendered, styled as a secondary action beneath Complete setup', () => {
    const completeIdx = onboarding.indexOf('label="Complete setup"');
    const signOutIdx = onboarding.indexOf('onPress={handleSignOut}');
    assert.ok(completeIdx !== -1 && signOutIdx !== -1 && completeIdx < signOutIdx,
      'Sign out must appear after, not before, Complete setup');
    assert.match(onboarding, /<Text style={styles\.signOutText}>Sign out<\/Text>/);
  });

  test('no Skip / Finish later / Continue-without-setup control was added alongside it', () => {
    assert.doesNotMatch(onboarding, /[Ss]kip|[Ff]inish later|[Cc]ontinue without/);
  });

  test('the mandatory gate itself is unchanged — same condition, same exemptions, still redirects INTO onboarding exactly as before', () => {
    assert.match(layout, /if \(profile && !profile\.onboarding_completed_at && !onOnboardingScreen && !isInfrastructureRoute\) \{/);
    assert.match(layout, /router\.replace\(\(dest \? `\/onboarding\?next=\$\{encodeURIComponent\(dest\)\}` : '\/onboarding'\) as never\);/);
  });

  test('completing onboarding is unchanged — same required fields, same single update, same completion timestamp', () => {
    assert.match(onboarding, /if \(!displayName\.trim\(\)\) \{/);
    assert.match(onboarding, /if \(!audience\) \{/);
    assert.match(onboarding, /onboarding_completed_at:\s*new Date\(\)\.toISOString\(\)/);
  });

  test('a signed-out session on /onboarding is bounced to the open app, the same way every other protected route already is', () => {
    // onOnboardingScreen is folded into inProtected — a signed-out user
    // landing on /onboarding (e.g. right after tapping Sign out) is bounced
    // to /(tabs) by the SAME !session branch that already handles every
    // other protected route, not a separate mechanism.
    const inProtectedLine = layout.match(/const inProtected = [^;]+;/)?.[0] ?? '';
    assert.match(inProtectedLine, /\bonOnboardingScreen\b/);
    const sessionBlock = layout.slice(layout.indexOf('if (!session) {'), layout.indexOf('if (!session) {') + 200);
    assert.match(sessionBlock, /if \(inProtected\) \{\s*router\.replace\('\/\(tabs\)'\);/);
  });

  test('onOnboardingScreen is declared exactly once and shared — not duplicated between the two checks', () => {
    const occurrences = onboarding_layout_count(layout);
    assert.equal(occurrences, 1);
  });
});

function onboarding_layout_count(src: string): number {
  return (src.match(/const onOnboardingScreen = /g) ?? []).length;
}
