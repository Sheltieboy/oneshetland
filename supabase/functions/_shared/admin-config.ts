/**
 * admin-config.ts — shared helper for edge functions to read from
 * the admin_config table (admin-editable, non-secret config).
 *
 * Use this for values that change occasionally and should be tweakable
 * by the app owner without a redeploy — e.g. Stripe price IDs, default
 * fee amounts, feature flags. True secrets (API keys) belong in env vars.
 *
 * Usage:
 *   import { getConfig } from '../_shared/admin-config.ts';
 *   const priceId = await getConfig(svc, 'stripe.price.local_pro');
 *   const priceId = await getConfig(svc, 'stripe.price.local_pro', Deno.env.get('STRIPE_PRICE_LOCAL_PRO'));
 *
 * If the key isn't set (empty string or no row), returns the fallback
 * (which is `null` by default).
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Fetch a single config value. Empty-string values are treated as "not set"
 * so a row can exist (so it shows up in the admin UI) without breaking
 * env-var fallbacks before the admin fills it in.
 */
export async function getConfig(
  supabase: SupabaseClient,
  key: string,
  fallback: string | null = null,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('admin_config')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) {
    console.error(`[admin-config] read failed for ${key}:`, error);
    return fallback;
  }
  const value = (data?.value ?? '').trim();
  return value ? value : fallback;
}

/**
 * Bulk fetch: returns a Map of key→value for all requested keys. Empty-string
 * values are NOT replaced with fallbacks here — caller decides.
 */
export async function getConfigBulk(
  supabase: SupabaseClient,
  keys: string[],
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('admin_config')
    .select('key, value')
    .in('key', keys);
  if (error) {
    console.error('[admin-config] bulk read failed:', error);
    return new Map();
  }
  return new Map((data ?? []).map(r => [r.key as string, (r.value as string)?.trim() ?? '']));
}
