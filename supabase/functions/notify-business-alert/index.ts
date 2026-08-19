import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createServiceClient, sendUserPushBulk } from '../_shared/send-push.ts';

/**
 * notify-business-alert
 *
 * A business's urgent alert (e.g. "closed today — weather") is a paid add-on
 * that previously only inserted a row and never pushed. This delivers it to the
 * business's customers — currently those who hold a loyalty card with the
 * business (the opted-in audience we have; widen this if a follow/favourite
 * model is added later).
 *
 * Body: { alert_id: string }
 * Module 'notices' (urgent alerts live alongside community notices).
 * emergency / disruption bypass quiet hours.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    // The caller must own the business this announces. Without it any signed-in
    // user could re-fire the fan-out at a business's entire customer base, as
    // often as they liked — the content is legitimate, the repetition is the
    // abuse. Both callers invoke this as the owner immediately after creating
    // the row, so nothing legitimate is turned away.
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);
    const { alert_id } = await req.json();
    if (!alert_id) return json({ error: 'alert_id required' }, 400);
    const svc = createServiceClient();

    const { data: alert } = await svc
      .from('partner_alerts')
      .select('business_id, business_name, message, type, is_active')
      .eq('id', alert_id).maybeSingle();
    if (!alert) return json({ error: 'alert not found' }, 404);
    // Only the business owner may fire this fan-out.
    const { data: ownerRow } = await svc
      .from('local_businesses').select('owner_id').eq('id', alert.business_id).maybeSingle();
    if (!ownerRow || ownerRow.owner_id !== user.id) return json({ error: 'Forbidden' }, 403);

    if (!alert.is_active) return json({ ok: true, notified: 0, skipped: 'not active yet' });

    // Customers = loyalty-card holders for this business.
    const { data: cards } = await svc
      .from('local_loyalty_cards').select('user_id').eq('business_id', alert.business_id);
    const ids = [...new Set((cards ?? []).map(c => c.user_id).filter(Boolean) as string[])];
    if (ids.length === 0) return json({ ok: true, notified: 0 });

    const urgent = alert.type === 'emergency' || alert.type === 'disruption';
    const { sent } = await sendUserPushBulk(svc, ids, {
      module:     'notices',
      categoryId: 'notices.business_alert',
      urgent,
      title:      `${alert.business_name ?? 'A local business'}${urgent ? ' ⚠️' : ''}`,
      body:       alert.message,
      data:       { business_id: alert.business_id },
    });
    return json({ ok: true, notified: sent });
  } catch (err) {
    console.error('[notify-business-alert]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});
