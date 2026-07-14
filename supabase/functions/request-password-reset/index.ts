import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendEmail } from '../_shared/send-email.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * request-password-reset
 *
 * Sends a BRANDED OneShetland password-reset email (via Postmark / the shared
 * send-email helper) instead of Supabase Auth's default unbranded email.
 *
 * It generates the recovery link server-side with the service role
 * (admin.generateLink) — which does NOT trigger Supabase's own email — then
 * delivers it through the `auth.password_reset` email template.
 *
 * Deploy with JWT verification OFF (the user is signed out when resetting):
 *   supabase functions deploy request-password-reset --no-verify-jwt
 *
 * Body: { email: string, redirect_to?: string }
 * Always returns { ok: true } (never reveals whether an account exists).
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const ok = () => new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

  try {
    const { email, redirect_to } = await req.json().catch(() => ({}));
    if (!email || typeof email !== 'string') {
      return new Response(JSON.stringify({ error: 'email is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const cleanEmail = email.trim().toLowerCase();

    // Generate the recovery link without sending Supabase's own email.
    const { data, error } = await svc.auth.admin.generateLink({
      type: 'recovery',
      email: cleanEmail,
      options: redirect_to ? { redirectTo: redirect_to } : undefined,
    });

    // No such user (or any other issue) → return ok anyway to avoid leaking
    // which emails are registered.
    const resetUrl = data?.properties?.action_link;
    if (error || !resetUrl) return ok();

    await sendEmail(svc, {
      templateKey: 'account.password_reset',
      recipientEmail: cleanEmail,
      variables: { reset_url: resetUrl },
      metadata: { flow: 'password_reset' },
    });

    return ok();
  } catch (err) {
    console.error('[request-password-reset]', err);
    return ok(); // never surface details to an unauthenticated caller
  }
});
