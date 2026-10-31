/**
 * accept-functions.ts — LOCAL-ONLY host for the submit-funeral-enquiry Edge Function: the REAL handler (supabase/functions/_shared/funeral-enquiry.ts) running in
 * Node, Cloudflare replaced by _mock-turnstile.ts, Supabase = the isolated acceptance backend. Used by accept-gateway.mjs and by the acceptance tests.
 * The environment below is fictional; the service key is the local HS256 token signed with the throwaway local secret.
 */
import { handleFuneralEnquiry, type EnquiryDeps } from '../../functions/_shared/funeral-enquiry.ts';
import { makeFetch } from './_mock-turnstile.ts';
import { assertIsolated } from '../_support/isolation.ts';
import { readFileSync } from 'node:fs';
import * as crypto from 'node:crypto';

const GATEWAY = process.env.ACCEPT_URL ?? 'http://127.0.0.1:54800';
assertIsolated({ SUPABASE_URL: GATEWAY });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const SECRET = 'a-proof-only-secret-that-is-at-least-32-characters-long';
const jwt = (role: string) => { const h = b64({ alg: 'HS256', typ: 'JWT' }), p = b64({ iss: 'accept', role, exp: Math.floor(Date.now() / 1000) + 86400 }); return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`; };

export const LOCAL_ENV: Record<string, string> = {
  TURNSTILE_SECRET_KEY: 'mock-secret-key',
  TURNSTILE_ALLOWED_HOSTNAMES: 'localhost',
  FUNERAL_ENQUIRY_ALLOWED_ORIGINS: 'http://localhost:3011,http://127.0.0.1:3011,http://localhost:3012',
  FUNERAL_ENQUIRY_IP_SALT: 'local-test-salt-not-a-secret-0123456789',
  SUPABASE_URL: GATEWAY,
  SUPABASE_SERVICE_ROLE_KEY: jwt('service_role'),
};
export const localDeps = (over: Partial<Record<string, string | undefined>> = {}): EnquiryDeps => ({ env: (k) => (k in over ? over[k] : LOCAL_ENV[k]), fetch: makeFetch() });
export const handleLocal = (req: Request, over: Partial<Record<string, string | undefined>> = {}) => handleFuneralEnquiry(req, localDeps(over));
void readFileSync;
