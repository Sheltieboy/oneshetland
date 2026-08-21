import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeError } from '../_shared/safe-error.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * become-driver
 *
 * Submits a Fetch driver application. Driver is a CAPABILITY, not an identity:
 * it lives entirely in driver_profiles.driver_status, NOT profiles.role. The
 * user keeps their normal role (e.g. 'customer') and additionally gains the
 * Driver area once approved. We deliberately do NOT touch profiles.role — that
 * used to make 'driver' an overriding identity that took over navigation.
 *
 * Runs server-side so the driver_profiles upsert isn't subject to client RLS
 * edge-cases and stays consistent with admin approval. Sets driver_status =
 * 'pending' (run-creation stays gated until an admin approves).
 *
 * Body: { vehicle_type: string, vehicle_reg: string, statement?: string }
 * Returns: { ok: true, driver_status }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const { vehicle_type, vehicle_reg, statement } = await req.json();
    if (!vehicle_type?.trim() || !vehicle_reg?.trim()) {
      return json({ error: 'Vehicle type and registration are required.' }, 400);
    }

    // Don't let an already-approved driver be knocked back to pending.
    const { data: existing } = await svc.from('driver_profiles').select('driver_status').eq('id', user.id).maybeSingle();
    const nextStatus = existing?.driver_status === 'approved' ? 'approved' : 'pending';

    const { error: dpErr } = await svc.from('driver_profiles').upsert({
      id:            user.id,
      driver_status: nextStatus,
      vehicle_type:  String(vehicle_type).trim(),
      vehicle_reg:   String(vehicle_reg).trim().toUpperCase(),
      notes:         statement ? String(statement).trim().slice(0, 1000) : null,
    });
    if (dpErr) throw dpErr;

    // NOTE: profiles.role is intentionally left untouched. Driver-ness is a
    // capability (driver_profiles.driver_status), not a role. The user remains
    // a normal customer who additionally has access to the Driver area.

    return json({ ok: true, driver_status: nextStatus });
  } catch (err) {
    console.error('[become-driver]', err);
    return json({ error: safeError('become-driver', err) }, 500);
  }
});
