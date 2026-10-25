/**
 * fetch-v2-photo-deps.ts — the production wiring for fetch-v2-photos.ts (Deno only). Tests inject their own.
 * Service-role database client, the private fetch-photos bucket (no client policy at all) and the shared rate limiter.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { enforceRateLimit, userSubject } from './rate-limit.ts';
import { corsHeaders } from './fetch-v2-payment-deps.ts';
import type { PhotoDeps } from './fetch-v2-photos.ts';

export function photoDeps(scope: string): PhotoDeps {
  const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
  const bucket = () => svc.storage.from('fetch-photos');
  return {
    rpc: async (fn, args) => { const { data, error } = await svc.rpc(fn, args); return { data, error }; },
    storage: {
      signedUpload: async (path) => {
        const { data, error } = await bucket().createSignedUploadUrl(path);
        if (error || !data) throw new Error('signed upload failed');
        return { url: data.signedUrl, token: data.token };
      },
      read: async (path) => {
        const { data, error } = await bucket().download(path);
        if (error || !data) return null;
        return new Uint8Array(await data.arrayBuffer());
      },
      write: async (path, bytes, mime) => {
        const { error } = await bucket().upload(path, bytes, { contentType: mime, upsert: true });
        if (error) throw new Error('storage write failed');
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
