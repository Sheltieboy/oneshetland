/**
 * google-wallet-pass-function.node.test.ts
 *
 * Google's save page answered "Something went wrong. Try again or contact the pass issuer."
 * Two defects in the signed Save-to-Wallet JWT caused it, both confirmed against Google's API:
 *   1. the issuer id was one zero short (18 digits, so "Issuer not found" — every class and object
 *      id lived under an issuer that does not exist);
 *   2. the inline loyalty class had no programLogo, which Google refuses to create.
 *
 * This runs the REAL edge function handler against fakes (Supabase client, env) with a throwaway
 * RSA key generated here. Nothing touches Google, production or any real key material.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { loadModule, readRepo } from './_support/load-source.ts';

const ISSUER = '3388000000023174515';
const USER_ID = '8a1b2c3d-1111-2222-3333-444455556666';
const MEMBER_CODE = 'OS-ABC123';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const SA_EMAIL = 'oneshetland-wallet@oneshetland-499215.iam.gserviceaccount.com';

let env: Record<string, string | undefined>;
let handler: (req: Request) => Promise<Response>;
let authedUser: { id: string } | null;
let profile: Record<string, string | null> | null;
let rpcError: unknown;

const fakeClient = () => ({
  auth: { getUser: async () => ({ data: { user: authedUser } }) },
  rpc: async (_fn: string, _args: unknown) => ({ data: rpcError ? null : MEMBER_CODE, error: rpcError }),
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile }) }) }) }),
});

function load() {
  (globalThis as any).Deno = { env: { get: (k: string) => env[k] } };
  loadModule('supabase/functions/google-wallet-pass/index.ts', {
    'https://deno.land/std@0.168.0/http/server.ts': { serve: (h: any) => { handler = h; } },
    'https://esm.sh/@supabase/supabase-js@2': { createClient: fakeClient },
    '../_shared/safe-error.ts': { safeError: (_n: string, e: any) => String(e?.message ?? e) },
  });
}

const call = (headers: Record<string, string> = { Authorization: 'Bearer user-jwt' }, qs = '') =>
  handler(new Request(`https://x.supabase.co/functions/v1/google-wallet-pass${qs}`, { method: 'POST', headers }));

const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function mint() {
  const res = await call();
  const body = await res.json();
  const jwt = String(body.saveUrl).replace('https://pay.google.com/gp/v/save/', '');
  const [h, p, s] = jwt.split('.');
  return {
    res, body, jwt, h, p, s,
    header: JSON.parse(b64(h).toString()),
    claims: JSON.parse(b64(p).toString()),
  };
}

beforeEach(() => {
  env = {
    SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc',
    GOOGLE_WALLET_SA_JSON: JSON.stringify({ client_email: SA_EMAIL, private_key: PRIVATE_PEM, private_key_id: 'kid-1' }),
  };
  authedUser = { id: USER_ID };
  profile = { display_name: 'Test Member', full_name: null };
  rpcError = null;
  load();
});

describe('issuer and class ids', () => {
  test('the issuer id is the real 19-digit Google issuer id', async () => {
    const src = readRepo('supabase/functions/google-wallet-pass/index.ts');
    assert.match(src, /const ISSUER_ID = '3388000000023174515';/);
    assert.equal(ISSUER.length, 19);
    const { claims } = await mint();
    const [cls] = claims.payload.loyaltyClasses;
    assert.equal(cls.id, `${ISSUER}.member`);
  });

  test('no stale 18-digit issuer id survives anywhere in the function', () => {
    const src = readRepo('supabase/functions/google-wallet-pass/index.ts');
    assert.doesNotMatch(src, /338800000023174515(?!\d)/);
  });

  test('the object references the class inline — never a class that is not in the same JWT', async () => {
    const { claims } = await mint();
    const [cls] = claims.payload.loyaltyClasses;
    const [obj] = claims.payload.loyaltyObjects;
    assert.ok(cls && obj);
    assert.equal(obj.classId, cls.id);
    assert.ok(obj.id.startsWith(`${ISSUER}.`));
    assert.equal(obj.id, `${ISSUER}.member_${USER_ID.replace(/[^a-zA-Z0-9]/g, '')}`);
  });
});

describe('class and object construction', () => {
  test('the class carries every field Google requires, including a public https program logo', async () => {
    const { claims } = await mint();
    const [cls] = claims.payload.loyaltyClasses;
    assert.equal(cls.issuerName, 'OneShetland');
    assert.equal(cls.programName, 'Shop Local Shetland');
    assert.equal(cls.reviewStatus, 'UNDER_REVIEW');
    assert.match(cls.programLogo?.sourceUri?.uri ?? '', /^https:\/\/oneshetland\.com\/brand\/[\w.-]+\.png$/);
    assert.ok(cls.programLogo.contentDescription?.defaultValue?.value);
  });

  test('the object is the member card: ACTIVE, QR carrying the member code, name, account id', async () => {
    const { claims } = await mint();
    const [obj] = claims.payload.loyaltyObjects;
    assert.equal(obj.state, 'ACTIVE');
    assert.equal(obj.accountName, 'Test Member');
    assert.equal(obj.accountId, MEMBER_CODE);
    assert.deepEqual(obj.barcode, { type: 'QR_CODE', value: MEMBER_CODE, alternateText: MEMBER_CODE });
  });

  test('a member with no profile name still gets a card', async () => {
    profile = null;
    const { claims } = await mint();
    assert.equal(claims.payload.loyaltyObjects[0].accountName, 'OneShetland member');
  });

  test('a missing member code is refused rather than minting a card with an empty QR', async () => {
    rpcError = { message: 'boom' };
    const res = await call();
    assert.equal(res.status, 500);
    assert.equal((await res.json()).saveUrl, undefined);
  });
});

describe('JWT claims and signature', () => {
  test('claims are a savetowallet JWT from the service account, with the site origins', async () => {
    const { claims, header } = await mint();
    assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
    assert.equal(claims.iss, SA_EMAIL);
    assert.equal(claims.aud, 'google');
    assert.equal(claims.typ, 'savetowallet');
    assert.ok(Math.abs(claims.iat - Date.now() / 1000) < 60);
    assert.deepEqual(claims.origins, ['https://oneshetland.com', 'https://www.oneshetland.com']);
    assert.deepEqual(Object.keys(claims.payload).sort(), ['loyaltyClasses', 'loyaltyObjects']);
  });

  test('the signature verifies against the key pair (RS256 over header.payload)', async () => {
    const { h, p, s } = await mint();
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${p}`);
    assert.equal(v.verify(PUBLIC_PEM, b64(s)), true);
  });
});

describe('nothing private reaches the client', () => {
  test('the JWT and response contain no key material or credential fields', async () => {
    const { res, body, jwt, claims } = await mint();
    const everything = JSON.stringify(body) + JSON.stringify(claims) + jwt;
    assert.doesNotMatch(everything, /PRIVATE KEY/);
    assert.ok(!everything.includes(PRIVATE_PEM.replace(/\s+/g, '').slice(40, 120)));
    assert.doesNotMatch(everything, /private_key|client_secret|service_role|SUPABASE_|Bearer /i);
    assert.doesNotMatch(JSON.stringify(Object.fromEntries(res.headers)), /PRIVATE KEY/);
    assert.deepEqual(Object.keys(body), ['saveUrl']);
  });

  test('the payload holds only intended public pass data', async () => {
    const { claims } = await mint();
    const allowedObj = ['id', 'classId', 'state', 'accountName', 'accountId', 'barcode', 'textModulesData', 'hexBackgroundColor'];
    const allowedCls = ['id', 'issuerName', 'programName', 'reviewStatus', 'hexBackgroundColor', 'programLogo'];
    assert.deepEqual(Object.keys(claims.payload.loyaltyObjects[0]).sort(), [...allowedObj].sort());
    assert.deepEqual(Object.keys(claims.payload.loyaltyClasses[0]).sort(), [...allowedCls].sort());
    // The user's uuid appears only inside the opaque object id; no email or auth token travels.
    assert.doesNotMatch(JSON.stringify(claims), /@(?!oneshetland-499215)/);
  });

  test('a failure never echoes the key or the secret', async () => {
    env.GOOGLE_WALLET_SA_JSON = JSON.stringify({ client_email: SA_EMAIL, private_key: 'not a key' });
    const res = await call();
    const text = await res.text();
    assert.equal(res.status, 500);
    assert.doesNotMatch(text, /not a key|PRIVATE KEY/);
    assert.equal(JSON.parse(text).error, 'Could not create pass');
  });

  test('an unset secret is a clear 500, not a half-built link', async () => {
    delete env.GOOGLE_WALLET_SA_JSON;
    const res = await call();
    assert.equal(res.status, 500);
    assert.equal((await res.json()).saveUrl, undefined);
  });
});

describe('the save URL and access', () => {
  test('the link is on pay.google.com/gp/v/save and passes the web client allow-list', async () => {
    const { body } = await mint();
    assert.match(body.saveUrl, /^https:\/\/pay\.google\.com\/gp\/v\/save\/[A-Za-z0-9._-]+$/);
    const web = readRepo('../oneshetland-web/lib/google-wallet-client.ts');
    assert.ok(web.includes('https:\\/\\/pay\\.google\\.com\\/gp\\/v\\/save\\/'));
  });

  test('no Authorization header, or an unknown user, is a 401 and mints nothing', async () => {
    let res = await call({});
    assert.equal(res.status, 401);
    authedUser = null;
    res = await call();
    assert.equal(res.status, 401);
    assert.equal((await res.json()).saveUrl, undefined);
  });

  test('the function stays JWT-verified at the gateway', () => {
    let cfg = '';
    try { cfg = readRepo('supabase/config.toml'); } catch { /* no config in repo */ }
    assert.doesNotMatch(cfg, /\[functions\.google-wallet-pass\][^\[]*verify_jwt\s*=\s*false/);
  });
});
