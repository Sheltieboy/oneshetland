import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * stripe-webhook
 *
 * Handles incoming Stripe webhook events.
 * Set this URL in Stripe Dashboard → Developers → Webhooks:
 * https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/stripe-webhook
 *
 * Required env vars:
 *   STRIPE_WEBHOOK_SECRET  — from Stripe Dashboard → Webhooks → signing secret
 *   STRIPE_SECRET_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 */
serve(async (req) => {
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? '';

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const body = await req.text();
  const signature = req.headers.get('stripe-signature') ?? '';

  // Verify the webhook signature to ensure it's genuinely from Stripe
  // Deno doesn't have crypto.subtle.timingSafeEqual so we do a manual HMAC check
  let event: Record<string, unknown>;
  try {
    event = await verifyStripeSignature(body, signature, webhookSecret);
  } catch (err) {
    console.error('[stripe-webhook] Signature verification failed:', err);
    return new Response('Webhook signature invalid', { status: 400 });
  }

  const eventType = event.type as string;
  const eventData = (event.data as Record<string, unknown>)?.object as Record<string, unknown>;

  console.log(`[stripe-webhook] Received: ${eventType}`);

  try {
    switch (eventType) {

      // ── Payment confirmed ────────────────────────────────────────────
      case 'payment_intent.succeeded': {
        const requestId = (eventData.metadata as Record<string, string>)?.request_id;
        if (requestId) {
          await supabase
            .from('delivery_requests')
            .update({ payment_status: 'captured' })
            .eq('payment_intent_id', eventData.id as string);
        }
        break;
      }

      // ── Payment failed ───────────────────────────────────────────────
      case 'payment_intent.payment_failed': {
        const requestId = (eventData.metadata as Record<string, string>)?.request_id;
        if (requestId) {
          await supabase
            .from('delivery_requests')
            .update({ payment_status: 'failed' })
            .eq('payment_intent_id', eventData.id as string);

          // TODO: notify customer their payment failed
        }
        break;
      }

      // ── Driver Connect account updated ───────────────────────────────
      // Stripe sends this when a driver completes/updates their onboarding
      case 'account.updated': {
        const accountId = eventData.id as string;
        const payoutsEnabled = eventData.payouts_enabled as boolean;
        const chargesEnabled = eventData.charges_enabled as boolean;
        const detailsSubmitted = eventData.details_submitted as boolean;

        await supabase
          .from('driver_profiles')
          .update({
            stripe_onboarding_complete: detailsSubmitted,
            stripe_payouts_enabled: payoutsEnabled,
            stripe_charges_enabled: chargesEnabled,
          })
          .eq('stripe_account_id', accountId);

        break;
      }

      // ── Payout to driver succeeded ───────────────────────────────────
      case 'transfer.created': {
        // Future: log driver earnings, send push notification
        console.log('[stripe-webhook] Transfer created:', eventData.id);
        break;
      }

      default:
        console.log(`[stripe-webhook] Unhandled event type: ${eventType}`);
    }
  } catch (err) {
    console.error(`[stripe-webhook] Error handling ${eventType}:`, err);
    return new Response('Webhook handler error', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

// ── Stripe signature verification ──────────────────────────────────────────
async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
): Promise<Record<string, unknown>> {
  if (!secret) {
    // Skip verification in development if no secret set
    return JSON.parse(payload);
  }

  const parts = header.split(',');
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
  const signature = parts.find((p) => p.startsWith('v1='))?.slice(3);

  if (!timestamp || !signature) throw new Error('Invalid signature header');

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (expected !== signature) throw new Error('Signature mismatch');

  return JSON.parse(payload);
}
