import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * validate-event-ticket
 *
 * Called by the business QR scanner. Validates a ticket token or backup code,
 * marks valid tickets as used, and returns a structured result.
 *
 * Authorization: must be the business owner of the event OR an admin.
 * The underlying DB function (validate_and_checkin_ticket) enforces this too.
 *
 * Body: { event_id: string, raw_token?: string, backup_code?: string }
 * One of raw_token or backup_code is required.
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return new Response(JSON.stringify({ error: 'Unauthorised' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const anonSupabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userError } = await anonSupabase.auth.getUser();
    if (userError || !user) return new Response(JSON.stringify({ error: 'Unauthorised' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const { event_id, raw_token, backup_code } = await req.json();
    if (!event_id || (!raw_token && !backup_code)) {
      return new Response(JSON.stringify({ error: 'event_id and (raw_token or backup_code) required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Verify the scanner is allowed to scan this event (server-side, before the RPC).
    const { data: owns } = await supabase
      .from('events')
      .select('organiser_business_id, organiser_hub_id, organiser_user_id')
      .eq('id', event_id)
      .single();

    if (!owns) return new Response(JSON.stringify({ error: 'Event not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    let authorised = await supabase.from('profiles').select('role').eq('id', user.id).single()
      .then(r => r.data?.role === 'admin');
    if (!authorised && owns.organiser_user_id === user.id) authorised = true;
    if (!authorised && owns.organiser_business_id) {
      const { data: biz } = await supabase.from('local_businesses').select('owner_id').eq('id', owns.organiser_business_id).single();
      authorised = biz?.owner_id === user.id;
    }
    if (!authorised && owns.organiser_hub_id) {
      const { data: isHubAdmin } = await supabase.rpc('is_hub_admin', { p_hub: owns.organiser_hub_id, p_user: user.id });
      authorised = !!isHubAdmin;
    }
    if (!authorised) {
      return new Response(JSON.stringify({ error: 'You are not authorised to scan tickets for this event' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    let result: any;

    if (raw_token) {
      const { data, error } = await supabase.rpc('validate_and_checkin_ticket', {
        p_raw_token:  raw_token,
        p_event_id:   event_id,
        p_scanner_id: user.id,
      });
      if (error) throw new Error(error.message);
      result = data;
    } else {
      const { data, error } = await supabase.rpc('validate_backup_code', {
        p_backup_code: backup_code,
        p_event_id:    event_id,
        p_scanner_id:  user.id,
      });
      if (error) throw new Error(error.message);
      result = data;
    }

    // Enrich result with ticket type name if valid/already_used
    if (result?.ticket_type_id) {
      const { data: tt } = await supabase.from('event_ticket_types').select('name').eq('id', result.ticket_type_id).single();
      if (tt) result.ticket_type_name = tt.name;
    }

    return new Response(JSON.stringify(result), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('[validate-event-ticket]', err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
