import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { connectAccountParams, formBody } from '../_shared/editions-commerce-core.ts';

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const STRIPE = 'https://api.stripe.com/v1';

/**
 * edition-connect-onboard — an organiser OWNER connects (or resumes connecting) the Stripe Express account that receives their revenue. NOT DEPLOYED.
 * Separate from create-connect-account (Fetch drivers): different account metadata (kind = edition_organiser) and a different table (edition_payout_accounts),
 * so nothing about driver payouts or hub payouts is read or changed.  Body: { organiser_id, return_url }   Returns { url } or { already_complete: true }.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const asUser = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);
    const { organiser_id, return_url } = await req.json().catch(() => ({}));
    if (typeof organiser_id !== 'string' || typeof return_url !== 'string' || !/^https:\/\/([a-z0-9-]+\.)*oneshetland\.com\//.test(return_url)) return json({ error: 'Bad request' }, 400);
    // owner only, checked by the database as the user
    const { data: role } = await asUser.rpc('edition_org_role', { p_org: organiser_id });
    if (role !== 'owner') return json({ error: 'Only an organiser owner can connect payouts' }, 403);
    const { data: org } = await asUser.from('edition_organisers').select('id, name, status').eq('id', organiser_id).maybeSingle();
    if (!org || org.status !== 'verified') return json({ error: 'Your organiser profile must be verified first' }, 409);

    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) return json({ error: 'Payments are not configured' }, 503);
    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const call = async (path: string, params: Record<string, string> | null, key?: string) => {
      const r = await fetch(`${STRIPE}${path}`, { method: params ? 'POST' : 'GET', headers: { Authorization: `Bearer ${stripeKey}`, 'Stripe-Version': '2023-10-16', ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: params ? formBody(params) : undefined });
      const j = await r.json(); if (!r.ok) throw new Error(j.error?.message ?? String(r.status)); return j;
    };
    let { data: acctId } = await svc.rpc('edition_payout_account_for', { p_org: organiser_id });
    if (!acctId) {
      const a = await call('/accounts', connectAccountParams({ organiser_id, email: user.email ?? '', name: org.name }), `ed-connect-${organiser_id}`);
      acctId = a.id;
    }
    const live = await call(`/accounts/${acctId}`, null);
    await svc.rpc('edition_payout_account_sync', { p_org: organiser_id, p_account: acctId, p_details: !!live.details_submitted, p_charges: !!live.charges_enabled, p_payouts: !!live.payouts_enabled, p_requirements: live.requirements?.currently_due ?? [] });
    if (live.charges_enabled && live.payouts_enabled) return json({ already_complete: true });
    const link = await call('/account_links', { account: String(acctId), refresh_url: return_url, return_url, type: 'account_onboarding' });
    return json({ url: link.url });
  } catch (err) {
    console.error('[edition-connect-onboard]', (err as Error).message);
    return json({ error: 'Could not start payout setup' }, 500);
  }
});
