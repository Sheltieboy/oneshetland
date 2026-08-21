import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendEmail } from '../_shared/send-email.ts';
import { enforceRateLimit, GLOBAL_SUBJECT } from '../_shared/rate-limit.ts';

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

    /**
     * Throttle. This endpoint is unauthenticated by necessity — you cannot be
     * signed in to reset a password — and nothing limited how fast it could be
     * called. Anyone could drive reset mail at any address as fast as they could
     * post: an inbox full of them for the person on the receiving end, and spam
     * complaints against the sending domain the rest of the product's email
     * depends on.
     *
     * email_log already records every send, so it is the counter — no new table,
     * and it counts what actually went out rather than what was attempted.
     *
     * Counted per address, which is the harm being prevented (bombing one
     * person). Over the limit still returns ok: this endpoint must never reveal
     * anything about an address, including whether it has been asked for
     * recently.
     */
    /**
     * A whole-endpoint ceiling on top of the per-address one below.
     *
     * The per-address throttle stops one person being bombed. It does nothing
     * about the other shape: spraying one request each at thousands of different
     * addresses, which costs an attacker nothing and burns the sending domain's
     * reputation that every other transactional email depends on.
     *
     * Over the ceiling this returns ok() like every other refusal here, so it
     * still reveals nothing about any address, and it is logged loudly.
     */
    const globalLimit = await enforceRateLimit('request-password-reset', GLOBAL_SUBJECT, ['password_reset_global'], corsHeaders);
    if ('denied' in globalLimit) {
      console.warn('[request-password-reset] endpoint ceiling reached — reset mail suppressed this window');
      return ok();
    }

    const RESET_LIMIT = 3;
    const RESET_WINDOW_MIN = 60;
    const since = new Date(Date.now() - RESET_WINDOW_MIN * 60_000).toISOString();
    const { count: recentSends } = await svc
      .from('email_log')
      .select('id', { count: 'exact', head: true })
      .eq('recipient_email', cleanEmail)
      .eq('template_key', 'account.password_reset')
      .gte('sent_at', since);
    if ((recentSends ?? 0) >= RESET_LIMIT) {
      console.warn(`[request-password-reset] throttled — ${recentSends} sends to this address in the last ${RESET_WINDOW_MIN}m`);
      return ok();
    }

    // Generate the recovery link without sending Supabase's own email.
    const { data, error } = await svc.auth.admin.generateLink({
      type: 'recovery',
      email: cleanEmail,
      options: redirect_to ? { redirectTo: redirect_to } : undefined,
    });

    // No such user (or any other issue) → return ok anyway to avoid leaking
    // which emails are registered.
    if (error || !data?.properties) return ok();

    /**
     * Send the TOKEN HASH, not the action_link.
     *
     * action_link points at Supabase's /auth/v1/verify, which consumes the
     * token and bounces the browser on with `?code=`. That code is a PKCE
     * authorization code, and @supabase/ssr hard-codes flowType: 'pkce' — so
     * the website tried to exchange it for a session using a code VERIFIER
     * that was never created, because this link was generated here on the
     * server and the user's browser was never part of it. The exchange failed
     * every time and the page reported it as "this link has expired", on the
     * very first click.
     *
     * token_hash + verifyOtp has no verifier and no redirect hop: the page
     * hands the hash straight back to Supabase and gets a session.
     */
    const hashedToken = data.properties.hashed_token;
    const base = redirect_to || data.properties.redirect_to;
    if (!hashedToken || !base) return ok();

    const target = new URL(base);
    target.searchParams.set('token_hash', hashedToken);
    target.searchParams.set('type', 'recovery');
    const resetUrl = target.toString();

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
