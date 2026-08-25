import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { fulfilShiftBoost } from '../_shared/fulfilment.ts';
import { safeError } from '../_shared/safe-error.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * confirm-boost
 *
 * The fast answer for an employer watching the screen after a successful
 * Stripe payment. Verifies the PaymentIntent, then hands off to the SHARED
 * fulfiller the webhook also uses, so both paths converge on one idempotent
 * operation and a boost lands even if this call never happens.
 *
 * Body: { shift_id: string, payment_intent_id: string }
 * Returns: { ok: true, boosted_until: string | null, already: boolean }
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

    const { shift_id, payment_intent_id } = await req.json();
    if (!shift_id) {
      return new Response(JSON.stringify({ error: 'shift_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (!payment_intent_id) {
      return new Response(JSON.stringify({ error: 'payment_intent_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Cheap existence + ownership answer before spending a Stripe round trip on
    // a shift that is not this employer's. The authoritative ownership check is
    // the PaymentIntent metadata below and fulfil_shift_boost's own row check;
    // this is the one that gives an honest 404/403 instead of a Stripe error.
    const { data: owned } = await supabase
      .from('shifts').select('id, employer_id').eq('id', shift_id).maybeSingle();
    if (!owned) {
      return new Response(JSON.stringify({ error: 'Shift not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (owned.employer_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Verify the boost was actually PAID FOR. Without this, anyone could call
    // this endpoint with a shift_id and get a free 24h feature + a push blast to
    // every matching worker. Retrieve the PaymentIntent from Stripe and require
    // it to have succeeded and to belong to THIS shift + employer.
    const piRes = await fetch(
      `https://api.stripe.com/v1/payment_intents/${payment_intent_id}`,
      { headers: { 'Authorization': `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}`, 'Stripe-Version': '2023-10-16' } },
    );
    const pi = await piRes.json();
    if (!piRes.ok) throw new Error(pi.error?.message ?? `Stripe retrieve failed (HTTP ${piRes.status})`);
    const m = (pi.metadata ?? {}) as Record<string, string>;
    if (pi.status !== 'succeeded' || m.type !== 'shift_boost' || m.shift_id !== shift_id || m.employer_id !== user.id) {
      return new Response(JSON.stringify({ error: 'Payment could not be verified for this boost.' }), {
        status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // From here the webhook and this call do exactly the same thing, because
    // they are the same code. fulfil_shift_boost claims the PaymentIntent and
    // writes boosted_until in ONE transaction: whichever path arrives first
    // grants the boost, the second finds `already` and extends nothing, and a
    // failure rolls the claim back so the other path can still recover it.
    //
    // This function is now only the fast answer for the employer who is
    // watching the screen. It is no longer the only way a paid boost lands.
    const result = await fulfilShiftBoost(supabase, {
      id:       payment_intent_id,
      amount:   (pi.amount as number) ?? 299,
      metadata: m,
      status:   pi.status as string,
    });

    if (!result.granted && !result.note.startsWith('already')) {
      return new Response(JSON.stringify({ error: 'This boost could not be applied.', reason: result.note }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // The employer's screen wants the authoritative expiry, so read it back
    // rather than recomputing a time the database already decided.
    const { data: boosted } = await supabase
      .from('shifts').select('boosted_until').eq('id', shift_id).maybeSingle();

    return new Response(
      JSON.stringify({
        ok: true,
        boosted_until: boosted?.boosted_until ?? null,
        already: !result.granted,
        note: result.note,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (err) {
    console.error('[confirm-boost]', err);
    return new Response(
      JSON.stringify({ error: safeError('confirm-boost', err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
