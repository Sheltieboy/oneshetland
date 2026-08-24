/**
 * verify-gift-recipient — prove you control the address a gift was sent to.
 *
 * WHY THIS EXISTS
 *
 * A gift addressed to john.work@gmail.com must be claimable by John's existing
 * OneShetland account at john@hotmail.com, without a second account. So the
 * email proves control of the DESTINATION; the signed-in account decides
 * OWNERSHIP. This route is the bridge between the two.
 *
 * WHY THE ISSUE STEP LIVES HERE RATHER THAN IN AN RPC THE CLIENT CAN CALL
 *
 * issue_gift_recipient_challenge() returns the PLAINTEXT code, because
 * something has to put it in an email. It is granted to service_role only —
 * a client able to call it could simply read the secret it is meant to be
 * tested on. This function holds the service credential, derives the user from
 * a VERIFIED JWT (never from the request body), and forwards nothing sensitive
 * back to the caller.
 *
 * Confirming is the opposite shape: the caller already has the code from their
 * inbox, and confirm_gift_recipient_verification() binds the result to
 * auth.uid(). That one is called straight from the client.
 *
 * DELIBERATELY ABSENT: anything that reveals whether recipient_email belongs to
 * an existing OneShetland account. The response is identical either way.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendEmail } from '../_shared/send-email.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

/** Postgres RAISE messages we are happy to hand back verbatim. */
const SAFE_ERRORS = new Set([
  'auth_required', 'gift_not_found', 'gift_not_paid', 'gift_cancelled',
  'gift_expired', 'gift_already_claimed', 'gift_has_no_recipient_email',
]);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);

    // Identity comes from the token, never from the body.
    const asCaller = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await asCaller.auth.getUser();
    if (userErr || !user) return json({ error: 'Unauthorised' }, 401);

    const body = await req.json().catch(() => ({}));
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!code) return json({ error: 'gift_not_found' }, 400);

    // Each challenge sends mail to somebody who did not ask for it.
    const limited = await enforceRateLimit(
      'verify-gift-recipient', userSubject(user.id),
      ['gift_verify_send', 'gift_verify_any', 'email_send'], corsHeaders,
    );
    if ('denied' in limited) return limited.denied;

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { data, error } = await svc.rpc('issue_gift_recipient_challenge', {
      p_code: code,
      p_user: user.id,
    });
    if (error) {
      const msg = (error.message ?? '').replace(/^.*?:\s*/, '').trim();
      if (SAFE_ERRORS.has(msg)) return json({ error: msg }, 400);
      console.error('[verify-gift-recipient] issue failed', error);
      return json({ error: 'Could not start verification.' }, 500);
    }

    const challenge = data as {
      token: string; recipient_email: string; masked_email: string;
      gift_id: string; expires_at: string;
    };

    // What the gift is, only so the email reads like something a human sent.
    let itemClause = '';
    let recipientName: string | null = null;
    try {
      const { data: g } = await svc
        .from('book_gifts')
        .select('recipient_name, kind, service:book_services(name), unit_item:book_unit_items(name)')
        .eq('id', challenge.gift_id).maybeSingle();
      const row = g as Record<string, unknown> | null;
      const name = row?.kind === 'unit'
        ? (row?.unit_item as { name?: string } | null)?.name
        : (row?.service as { name?: string } | null)?.name;
      if (name) itemClause = ` — ${name}`;
      recipientName = (row?.recipient_name as string | null) ?? null;
    } catch { /* the code matters, the flourish does not */ }

    const sent = await sendEmail(svc, {
      templateKey: 'local.gift_verify_recipient',
      recipientEmail: challenge.recipient_email,
      variables: {
        token: challenge.token,
        recipient_name_suffix: recipientName ? ` ${recipientName}` : '',
        item_clause: itemClause,
      },
    });
    if (!sent.ok && !sent.skipped) {
      console.error('[verify-gift-recipient] email failed', sent.error);
      return json({ error: 'Could not send the verification email.' }, 502);
    }

    // The token is NOT in this response. Only the shape of where it went.
    return json({
      ok: true,
      masked_email: challenge.masked_email,
      expires_at: challenge.expires_at,
    });
  } catch (e) {
    console.error('[verify-gift-recipient] unhandled', e);
    return json({ error: 'Could not start verification.' }, 500);
  }
});
