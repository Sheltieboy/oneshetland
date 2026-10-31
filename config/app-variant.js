/**
 * app-variant — the one place that decides which OneShetland this build is.
 *
 * APP_VARIANT unset (or "production") returns the Expo config EXACTLY as app.json has it. Nothing about the shipped app changes: same bundle
 * id, scheme, universal links, update channel, push entitlement. A test pins that.
 *
 * "preview" and "preview-demo" are a separate, independently installable app ("OneShetland Preview") that can sit beside the production app on
 * one phone without touching it:
 *   · its own iOS bundle id / Android package  → its own App ID, provisioning, keychain, storage and push topic
 *   · its own URL scheme                        → a custom-scheme link can never be claimed by, or open, the other app
 *   · no associated domains / intent filters    → it never takes https://oneshetland.com links away from the production app
 *   · its own EAS Update channel, written into the config here so it does not depend on eas.json's `channel` overriding app.json's header
 *   (Push: prebuild applies the expo-notifications plugin automatically, so the preview App ID WILL carry the Push Notifications capability. It is
 *    unused: a push token is only registered after sign-in, and the demonstration backend refuses all sign-in.)
 * runtimeVersion stays the fingerprint policy; the changed identity changes the fingerprint, so a production OTA update has no matching runtime
 * either (belt and braces: the channel already keeps them apart).
 *
 * Build-time guards (they throw, naming the problem but never printing a value):
 *   preview-demo  must point at a private-network backend, never a hosted Supabase project, and must carry no Stripe key.
 *   preview       reads real data, so it is signed-out/read-only in practice (see the report); it must never carry a live Stripe key.
 */
'use strict';

const PRODUCTION_PROJECT_REF = 'nkrtmakxygkvxuxriiil';

const PREVIEW_IDENTITY = {
  name: 'OneShetland Preview',
  scheme: 'oneshetland-preview',
  bundleIdentifier: 'com.oneshetland.app.preview',
  androidPackage: 'com.oneshetland.app.preview',
};

const VARIANTS = {
  preview: { ...PREVIEW_IDENTITY, channel: 'preview' },
  'preview-demo': { ...PREVIEW_IDENTITY, channel: 'preview-demo', privateNetworkOnly: true },
};

const isPrivateHost = (host) =>
  host === 'localhost' ||
  host.endsWith('.local') ||
  /^127\./.test(host) ||
  /^10\./.test(host) ||
  /^192\.168\./.test(host) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(host);

function assertDemoBackend(env) {
  const raw = env.EXPO_PUBLIC_SUPABASE_URL;
  if (!raw) throw new Error('APP_VARIANT=preview-demo needs EXPO_PUBLIC_SUPABASE_URL set to the private demonstration backend.');
  let u;
  try { u = new URL(raw); } catch { throw new Error('APP_VARIANT=preview-demo: EXPO_PUBLIC_SUPABASE_URL is not a valid URL.'); }
  if (raw.includes(PRODUCTION_PROJECT_REF) || /supabase\.(co|in|net)$/i.test(u.hostname) || !isPrivateHost(u.hostname)) {
    throw new Error('APP_VARIANT=preview-demo refuses a backend that is not on a private network (hosted Supabase and production are never allowed).');
  }
  if (env.EXPO_PUBLIC_APP_VARIANT !== 'preview-demo') {
    throw new Error('APP_VARIANT=preview-demo needs EXPO_PUBLIC_APP_VARIANT=preview-demo (it switches off the sign-in check that would open the production site).');
  }
  if (env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY) {
    throw new Error('APP_VARIANT=preview-demo must not carry a Stripe key (the demonstration build has no payment capability).');
  }
}

function assertNoLiveStripe(env) {
  if ((env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY || '').startsWith('pk_live_')) {
    throw new Error('A preview build must never carry a live Stripe key.');
  }
}

function applyVariant(config, env = process.env) {
  // only a variable that is not set at all means production; a blank or misspelt one is an error, never a silent production-identity build
  const name = env.APP_VARIANT === undefined ? 'production' : env.APP_VARIANT.trim();
  if (name === 'production') return config;
  const v = VARIANTS[name];
  if (!v) throw new Error(`Unknown APP_VARIANT "${name}" (expected production, preview or preview-demo).`);
  if (v.privateNetworkOnly) assertDemoBackend(env);
  assertNoLiveStripe(env);

  const { associatedDomains: _ad, ...ios } = config.ios ?? {};
  const { intentFilters: _if, ...android } = config.android ?? {};
  return {
    ...config,
    name: v.name,
    scheme: v.scheme,
    ios: {
      ...ios,
      bundleIdentifier: v.bundleIdentifier,
      infoPlist: {
        ...(ios.infoPlist ?? {}),
        ...(v.privateNetworkOnly
          ? {
              // the demonstration backend is plain http on the home network (allowed for local-network addresses only; every other host stays https-only)
              NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
              NSLocalNetworkUsageDescription: 'OneShetland Preview connects to a demonstration server on your local network.',
            }
          : {}),
      },
    },
    android: { ...android, package: v.androidPackage },
    updates: {
      ...(config.updates ?? {}),
      requestHeaders: { ...(config.updates?.requestHeaders ?? {}), 'expo-channel-name': v.channel },
    },
    extra: { ...(config.extra ?? {}), appVariant: name },
  };
}

module.exports = { applyVariant, VARIANTS, PRODUCTION_PROJECT_REF };
