import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendEmail } from '../_shared/send-email.ts';
import { safeError } from '../_shared/safe-error.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * send-email
 *
 * General-purpose email sender. Called by other edge functions or directly
 * from the admin test-send button.
 *
 * Body: {
 *   template_key:    string       — e.g. 'fetch.delivered'
 *   recipient_email: string
 *   recipient_id?:   string       — Supabase user UUID (for log)
 *   variables?:      Record<string, string>
 *   metadata?:       Record<string, unknown>
 * }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    /**
     * ADMIN ONLY over HTTP.
     *
     * This endpoint takes a template key, a recipient and the template's
     * variables straight from the body, and it had no caller check — so any
     * signed-in user could put OneShetland-branded mail, with content they
     * chose, into any inbox. Templates carry links, so that is a phishing
     * primitive as well as a way to burn the sending domain's reputation.
     *
     * The only HTTP caller is the admin email-templates "send test" button.
     * Every other sender (5 edge functions) imports _shared/send-email.ts
     * directly and never comes through here, so nothing else is affected.
     */
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const anon = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await anon.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const { data: me } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (me?.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Forbidden — admins only' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const body = await req.json();
    const { template_key, recipient_email, recipient_id, variables, metadata } = body;

    if (!template_key || !recipient_email) {
      return new Response(
        JSON.stringify({ error: 'template_key and recipient_email are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const result = await sendEmail(supabase, {
      templateKey:    template_key,
      recipientEmail: recipient_email,
      recipientId:    recipient_id ?? null,
      variables:      variables ?? {},
      metadata:       metadata   ?? {},
    });

    return new Response(
      JSON.stringify(result),
      { status: result.ok ? 200 : 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[send-email function]', err);
    return new Response(
      JSON.stringify({ error: safeError('send-email', err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
