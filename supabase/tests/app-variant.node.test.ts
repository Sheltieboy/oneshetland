/**
 * app-variant.node.test.ts
 *
 * OneShetland Preview must be an independently installable app that cannot disturb, or be mistaken for, the production app. These tests pin:
 *   1. PRODUCTION IS UNCHANGED  — with no APP_VARIANT the resolved config is app.json, byte for byte, and the identifiers the shipped app depends on
 *      (bundle id, scheme, universal links, update channel) are the golden values below.
 *   2. PREVIEW IS ISOLATED      — its own bundle id / package / scheme / name / update channel, and it never claims oneshetland.com links.
 *   3. THE GUARDS FAIL LOUDLY   — the demonstration build refuses any non-private backend and any Stripe key; no preview carries a live Stripe key.
 *   4. EAS PROFILES MATCH       — each preview profile sets the variant it is meant to, production is untouched, and the demonstration profile
 *      pulls no server-side variables (environment "development" is empty) so nothing production can leak in.
 * Nothing here touches a network, a database or an Apple/EAS account.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadModule } from './_support/load-source.ts';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const { applyVariant, VARIANTS, PRODUCTION_PROJECT_REF } = require(path.join(root, 'config/app-variant.js'));
const appJson = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8')).expo;
const eas = JSON.parse(readFileSync(path.join(root, 'eas.json'), 'utf8'));

const DEMO_ENV = { APP_VARIANT: 'preview-demo', EXPO_PUBLIC_APP_VARIANT: 'preview-demo', EXPO_PUBLIC_SUPABASE_URL: 'http://Darrens-MacBook-Pro.local:54790' };
const live = (o: Record<string, string> = {}) => applyVariant(appJson, { APP_VARIANT: 'preview', ...o });
const demo = (o: Record<string, string> = {}) => applyVariant(appJson, { ...DEMO_ENV, ...o });

test('production: no APP_VARIANT returns app.json untouched', () => {
  assert.equal(applyVariant(appJson, {}), appJson);
  assert.equal(applyVariant(appJson, { APP_VARIANT: 'production' }), appJson);
});

test('production: golden identifiers the shipped app depends on', () => {
  assert.equal(appJson.name, 'OneShetland');
  assert.equal(appJson.ios.bundleIdentifier, 'com.oneshetland.app');
  assert.equal(appJson.android.package, 'com.oneshetland.app');
  assert.equal(appJson.scheme, 'oneshetland-fetch');
  assert.deepEqual(appJson.ios.associatedDomains, ['applinks:oneshetland.com']);
  assert.equal(appJson.updates.requestHeaders['expo-channel-name'], 'production');
  assert.equal(appJson.runtimeVersion.policy, 'fingerprint');
  assert.equal(appJson.extra.eas.projectId, '505d7724-8b86-493d-973e-45c44011157f');
});

test('production: app.config.js with no variant adds nothing but the optional Android Maps key', () => {
  const factory = require(path.join(root, 'app.config.js'));
  const saved = { ...process.env };
  for (const k of ['APP_VARIANT', 'EXPO_PUBLIC_GOOGLE_MAPS_KEY', 'EXPO_PUBLIC_GOOGLE_PLACES_KEY']) delete process.env[k];
  try {
    const out = factory({ config: appJson });
    assert.deepEqual(out, { ...appJson, android: { ...appJson.android, config: {} } });
    process.env.EXPO_PUBLIC_GOOGLE_PLACES_KEY = 'x';
    assert.deepEqual(factory({ config: appJson }).android.config, { googleMaps: { apiKey: 'x' } });
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('an EAS Android build without a Maps key refuses to build; every other build is unaffected', () => {
  const factory = require(path.join(root, 'app.config.js'));
  const saved = { ...process.env };
  for (const k of ['APP_VARIANT', 'EXPO_PUBLIC_GOOGLE_MAPS_KEY', 'EXPO_PUBLIC_GOOGLE_PLACES_KEY', 'EAS_BUILD_PLATFORM']) delete process.env[k];
  try {
    process.env.EAS_BUILD_PLATFORM = 'android';
    assert.throws(() => factory({ config: appJson }), /need EXPO_PUBLIC_GOOGLE_MAPS_KEY/);
    process.env.EXPO_PUBLIC_GOOGLE_PLACES_KEY = 'x'; // the documented fallback satisfies it
    assert.doesNotThrow(() => factory({ config: appJson }));
    delete process.env.EXPO_PUBLIC_GOOGLE_PLACES_KEY;
    process.env.EAS_BUILD_PLATFORM = 'ios';
    assert.doesNotThrow(() => factory({ config: appJson }));
    delete process.env.EAS_BUILD_PLATFORM; // local run / config-only command
    assert.doesNotThrow(() => factory({ config: appJson }));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

for (const [label, build] of [['preview', live], ['preview-demo', demo]] as const) {
  test(`${label}: its own identity, never the production one`, () => {
    const c = build();
    assert.equal(c.name, 'OneShetland Preview');
    assert.equal(c.ios.bundleIdentifier, 'com.oneshetland.app.preview');
    assert.equal(c.android.package, 'com.oneshetland.app.preview');
    assert.equal(c.scheme, 'oneshetland-preview');
    assert.notEqual(c.ios.bundleIdentifier, appJson.ios.bundleIdentifier);
    assert.notEqual(c.android.package, appJson.android.package);
    assert.notEqual(c.scheme, appJson.scheme);
    assert.equal(c.extra.appVariant, label);
  });

  test(`${label}: never claims production universal links or app links`, () => {
    const c = build();
    assert.equal(c.ios.associatedDomains, undefined);
    assert.equal(c.android.intentFilters, undefined);
  });

  test(`${label}: update channel is written into the config and is not production`, () => {
    const c = build();
    assert.equal(c.updates.requestHeaders['expo-channel-name'], label);
    assert.notEqual(c.updates.requestHeaders['expo-channel-name'], 'production');
    assert.equal(c.updates.url, appJson.updates.url); // same EAS project; the channel (and the runtime fingerprint) keep the streams apart
  });

  test(`${label}: unrelated config is carried over unchanged`, () => {
    const c = build();
    assert.deepEqual(c.splash, appJson.splash);
    assert.deepEqual(c.runtimeVersion, appJson.runtimeVersion);
    assert.deepEqual(c.ios.privacyManifests, appJson.ios.privacyManifests);
    assert.equal(c.ios.infoPlist.NSCameraUsageDescription, appJson.ios.infoPlist.NSCameraUsageDescription);
    assert.deepEqual(c.plugins, appJson.plugins);
    assert.equal(c.extra.eas.projectId, appJson.extra.eas.projectId);
  });
}

test('the two preview variants have different update channels', () => {
  assert.notEqual(VARIANTS.preview.channel, VARIANTS['preview-demo'].channel);
});

test('only the demonstration build opens up local-network http', () => {
  assert.deepEqual(demo().ios.infoPlist.NSAppTransportSecurity, { NSAllowsLocalNetworking: true });
  assert.ok(demo().ios.infoPlist.NSLocalNetworkUsageDescription);
  assert.equal(live().ios.infoPlist.NSAppTransportSecurity, undefined);
  assert.equal(appJson.ios.infoPlist.NSAppTransportSecurity, undefined);
});

test('guard: the demonstration build accepts private-network backends only', () => {
  for (const ok of ['http://Darrens-MacBook-Pro.local:54790', 'http://192.168.0.245:54790', 'http://10.1.2.3:1', 'http://172.20.0.5:1', 'http://localhost:54790', 'http://127.0.0.1:54790']) {
    assert.doesNotThrow(() => demo({ EXPO_PUBLIC_SUPABASE_URL: ok }), ok);
  }
  for (const bad of [
    `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
    'https://example.supabase.co',
    'https://api.oneshetland.com',
    'http://8.8.8.8:54790',
    'http://172.32.0.1:1',
    `http://192.168.0.2:1/${PRODUCTION_PROJECT_REF}`,
    'not a url',
  ]) {
    assert.throws(() => demo({ EXPO_PUBLIC_SUPABASE_URL: bad }), /preview-demo/, bad);
  }
  assert.throws(() => applyVariant(appJson, { APP_VARIANT: 'preview-demo' }), /needs EXPO_PUBLIC_SUPABASE_URL/);
});

test('guard: the demonstration build has no payment capability and no Stripe key', () => {
  assert.throws(() => demo({ EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_x' }), /Stripe/);
  assert.throws(() => demo({ EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_x' }), /Stripe/);
});

test('guard: no preview may carry a live Stripe key; a test key is allowed on the real-data preview', () => {
  assert.throws(() => live({ EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_x' }), /live Stripe/);
  assert.doesNotThrow(() => live({ EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_x' }));
});

test('guard: errors never echo the offending value', () => {
  for (const [fn, secret] of [
    [() => demo({ EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_TOPSECRET' }), 'pk_live_TOPSECRET'],
    [() => live({ EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_TOPSECRET' }), 'pk_live_TOPSECRET'],
    [() => demo({ EXPO_PUBLIC_SUPABASE_URL: 'https://leaky.example.com/TOPSECRET' }), 'TOPSECRET'],
  ] as const) {
    try { fn(); assert.fail('should have thrown'); } catch (e: any) { assert.ok(!String(e.message).includes(secret)); }
  }
});

test('an unknown or blank variant is an error, not a silent production build', () => {
  assert.throws(() => applyVariant(appJson, { APP_VARIANT: '' }), /Unknown APP_VARIANT/);
  assert.throws(() => applyVariant(appJson, { APP_VARIANT: '  ' }), /Unknown APP_VARIANT/);
  assert.throws(() => applyVariant(appJson, { APP_VARIANT: 'preveiw' }), /Unknown APP_VARIANT/);
});

test('eas.json: production profile is the store profile and carries no variant', () => {
  const p = eas.build.production;
  assert.equal(p.channel, 'production');
  assert.equal(p.environment, 'production');
  assert.equal(p.autoIncrement, true);
  assert.equal(p.env, undefined);
  assert.deepEqual(eas.submit, { production: {} }); // no preview profile can be submitted
});

test('eas.json: each preview profile sets its variant and the matching channel', () => {
  for (const name of ['preview', 'preview-demo']) {
    const p = eas.build[name];
    assert.equal(p.env.APP_VARIANT, name);
    assert.equal(p.channel, VARIANTS[name].channel);
    assert.equal(p.distribution, 'internal');
    assert.notEqual(p.channel, 'production');
    assert.notEqual(p.environment, 'production');
    assert.equal(p.autoIncrement, undefined);
  }
});

test('eas.json: the demonstration profile pulls no server-side variables and points only at a private backend', () => {
  const p = eas.build['preview-demo'];
  assert.equal(p.environment, 'development'); // the EAS "development" environment holds no variables (checked by name, 31 Oct)
  assert.ok(!p.developmentClient);
  const keys = Object.keys(p.env).sort();
  assert.deepEqual(keys, ['APP_VARIANT', 'EXPO_PUBLIC_APP_VARIANT', 'EXPO_PUBLIC_SUPABASE_ANON_KEY', 'EXPO_PUBLIC_SUPABASE_URL']);
  assert.doesNotThrow(() => applyVariant(appJson, { ...p.env }));
  assert.ok(!/^eyJ/.test(p.env.EXPO_PUBLIC_SUPABASE_ANON_KEY), 'no real JWT is committed; the demo proxy supplies the anonymous role itself');
});

test('eas.json: the real-data preview profile is the isolated one, not the production identity', () => {
  assert.equal(eas.build.preview.env.APP_VARIANT, 'preview');
  assert.equal(eas.build.preview.environment, 'preview');
});

test('guard: the demonstration build must also switch off the production-site sign-in check', () => {
  const { EXPO_PUBLIC_APP_VARIANT: _omit, ...without } = DEMO_ENV;
  assert.throws(() => applyVariant(appJson, without), /EXPO_PUBLIC_APP_VARIANT/);
  assert.throws(() => applyVariant(appJson, { ...DEMO_ENV, EXPO_PUBLIC_APP_VARIANT: 'preview' }), /EXPO_PUBLIC_APP_VARIANT/);
});

test('demonstration build: the sign-in check refuses before opening the production site or using its scheme', async () => {
  const native = { opens: 0 };
  const logs: string[] = [];
  const mod = loadModule('lib/turnstile.ts', {
    'react-native': { Platform: { OS: 'ios' }, Keyboard: {}, AppState: { currentState: 'active' } },
    'expo-web-browser': { openAuthSessionAsync: () => { native.opens++; return Promise.resolve({ type: 'cancel' }); }, dismissAuthSession() {} },
    './with-deadline': { withDeadline: (p: Promise<unknown>) => p, TIMED_OUT: Symbol('t') },
    './auth-diagnostics': { logAuthStage: (s: string) => { logs.push(s); } },
  });
  const saved = process.env.EXPO_PUBLIC_APP_VARIANT;
  process.env.EXPO_PUBLIC_APP_VARIANT = 'preview-demo';
  try {
    assert.deepEqual(await mod.getTurnstileToken(), { ok: false, reason: 'unavailable' });
    assert.equal(native.opens, 0);
    assert.deepEqual(logs, []);
  } finally {
    if (saved === undefined) delete process.env.EXPO_PUBLIC_APP_VARIANT; else process.env.EXPO_PUBLIC_APP_VARIANT = saved;
  }
});

test('production source: the demo switch is the first statement and is keyed only on the demonstration variant', () => {
  const src = readFileSync(path.join(root, 'lib/turnstile.ts'), 'utf8');
  const body = src.slice(src.indexOf('export async function getTurnstileToken'));
  const first = body.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//'))[1].trim();
  assert.equal(first, "if (process.env.EXPO_PUBLIC_APP_VARIANT === 'preview-demo') return { ok: false, reason: 'unavailable' };");
  assert.equal((src.match(/EXPO_PUBLIC_APP_VARIANT/g) ?? []).length, 2); // the one comment mention and the one check; nothing else in the module
});
