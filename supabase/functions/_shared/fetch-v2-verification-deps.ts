/**
 * fetch-v2-verification-deps.ts — the production wiring for fetch-v2-verification.ts (Deno only). Tests inject their own.
 *
 * Service-role database client, the private fetch-driver-verification bucket (signed uploads, short-lived signed links, removal —
 * the bucket has no client policy at all) and the shared rate limiter.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { enforceRateLimit, userSubject } from './rate-limit.ts';
import { corsHeaders } from './fetch-v2-payment-deps.ts';
import type { VerificationDeps } from './fetch-v2-verification.ts';

const BUCKET = 'fetch-driver-verification';

export function verificationDeps(scope: string): VerificationDeps {
  const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
  const bucket = () => svc.storage.from(BUCKET);
  return {
    rpc: async (fn, args) => { const { data, error } = await svc.rpc(fn, args); return { data, error }; },
    storage: {
      signedUpload: async (path) => {
        const { data, error } = await bucket().createSignedUploadUrl(path);
        if (error || !data) throw new Error('signed upload failed');
        return { url: data.signedUrl, token: data.token };
      },
      inspect: async (path) => {
        const { data, error } = await bucket().download(path);
        if (error || !data) return null;
        return { size: data.size, head: new Uint8Array(await data.slice(0, 16).arrayBuffer()) };
      },
      signedUrl: async (path, ttl) => {
        const { data, error } = await bucket().createSignedUrl(path, ttl);
        if (error || !data) throw new Error('signed link failed');
        return data.signedUrl;
      },
      remove: async (path) => {
        const { error } = await bucket().remove([path]);
        if (error) throw new Error('storage removal failed');
      },
    },
    limit: async (userId, actions) => !('denied' in await enforceRateLimit(scope, userSubject(userId), actions, corsHeaders)),
  };
}
