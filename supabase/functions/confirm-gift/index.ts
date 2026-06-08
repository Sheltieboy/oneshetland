import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendEmail } from '../_shared/send-email.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const STRIPE_API_VERSION = '2023-10-16';

/**
 * confirm-gift
 *
 * Called after a successful Stripe payment for a gift. Verifies the PI,
 * replaces the placeholder code on the gift row with a short shareable code
 * (via generate_gift_code()), marks status='sent', and fires the recipient
 * email via the Email Centre.
 *
 * Idempotent — if the gift is already 'sent', skips re-emailing and just
 * returns the current row.
 *
 * Body: { gift_id: string, payment_intent_id: string }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const anonSupabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userError } = await anonSupabase.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorised' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { gift_id, payment_intent_id } = await req.json();
    if (!gift_id || !payment_intent_id) {
      return new Response(JSON.stringify({ error: 'gift_id and payment_intent_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Load gift row
    const { data: gift } = await supabase
      .from('book_gifts')
      .select('id, kind, status, code, business_id, unit_item_id, service_id, purchaser_id, recipient_email, recipient_name, message, price_paid_pence, payment_intent_id, email_sent_at')
      .eq('id', gift_id)
      .single();

    if (!gift) {
      return new Response(JSON.stringify({ error: 'Gift not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (gift.purchaser_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Idempotent: if already sent, return existing data
    if (gift.status === 'sent' || gift.status === 'claimed' || gift.status === 'used') {
      return new Response(
        JSON.stringify({ ok: true, gift_id: gift.id, code: gift.code, already_sent: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Verify the PaymentIntent
    const piRes = await fetch(
      `https://api.stripe.com/v1/payment_intents/${payment_intent_id}`,
      {
        headers: {
          'Authorization':  `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`,
          'Stripe-Version': STRIPE_API_VERSION,
        },
      },
    );
    const pi = await piRes.json();
    if (!piRes.ok) {
      throw new Error(pi.error?.message ?? `Stripe PaymentIntent retrieve failed (HTTP ${piRes.status})`);
    }
    if (pi.status !== 'succeeded') {
      return new Response(JSON.stringify({ error: `Payment not completed (status: ${pi.status}).` }), {
        status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (pi.metadata?.gift_id !== gift.id || pi.metadata?.buyer_id !== user.id) {
      return new Response(JSON.stringify({ error: 'PaymentIntent does not match this gift.' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Generate the short code
    const { data: codeData, error: codeErr } = await supabase.rpc('generate_gift_code');
    if (codeErr || !codeData) {
      console.error('[confirm-gift] generate_gift_code failed', codeErr);
      return new Response(JSON.stringify({ error: 'Could not generate gift code.' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const code: string = codeData as string;

    // Promote gift to 'sent'
    const { error: updErr } = await supabase
      .from('book_gifts')
      .update({
        code,
        status:            'sent',
        payment_intent_id: pi.id,
      })
      .eq('id', gift.id);

    if (updErr) {
      console.error('[confirm-gift] gift update failed', updErr);
      return new Response(JSON.stringify({ error: updErr.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Gather variables for the email
    const [{ data: purchaser }, { data: business }] = await Promise.all([
      supabase.from('profiles').select('full_name').eq('id', user.id).single(),
      supabase.from('local_businesses').select('name').eq('id', gift.business_id).single(),
    ]);

    let itemName = '';
    if (gift.kind === 'unit' && gift.unit_item_id) {
      const { data: it } = await supabase
        .from('book_unit_items')
        .select('name')
        .eq('id', gift.unit_item_id)
        .single();
      itemName = it?.name ?? 'a gift';
    } else if (gift.kind === 'booking' && gift.service_id) {
      const { data: svc } = await supabase
        .from('book_services')
        .select('name')
        .eq('id', gift.service_id)
        .single();
      itemName = svc?.name ?? 'a booking';
    }

    // Render the conditional message block in code (template engine is plain {{var}}).
    const escapedMsg = (gift.message ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const messageHtml = gift.message
      ? `<p style="margin:16px 0 0;font-style:italic;color:#374151;line-height:22px">&ldquo;${escapedMsg}&rdquo;</p>`
      : '';

    const claimUrl = `https://oneshetland.com/g/${code}`;

    // Fire the email — don't block the response on it
    const emailResult = await sendEmail(supabase, {
      templateKey:    'local.gift_received',
      recipientEmail: gift.recipient_email,
      variables: {
        purchaser_name: purchaser?.full_name ?? 'Someone',
        recipient_name: gift.recipient_name ?? 'there',
        business_name:  business?.name ?? 'OneShetland',
        item_name:      itemName,
        message_html:   messageHtml,
        claim_url:      claimUrl,
        code,
      },
      metadata: { gift_id: gift.id, kind: gift.kind },
    });

    if (emailResult.ok && !emailResult.skipped) {
      await supabase
        .from('book_gifts')
        .update({ email_sent_at: new Date().toISOString() })
        .eq('id', gift.id);
    }

    return new Response(
      JSON.stringify({
        ok:           true,
        gift_id:      gift.id,
        code,
        claim_url:    claimUrl,
        email_sent:   emailResult.ok && !emailResult.skipped,
        email_error:  emailResult.ok ? null : emailResult.error,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[confirm-gift]', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
