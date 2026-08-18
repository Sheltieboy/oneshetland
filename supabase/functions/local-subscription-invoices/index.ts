import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * local-subscription-invoices
 *
 * Lists a business's subscription invoices so the billing screen can show them
 * without sending anybody to Stripe's portal.
 *
 * We do NOT copy invoices into our own database. Stripe is the record of what
 * was charged, and a stale local mirror of somebody's billing history is a
 * worse thing to own than a live API call. The PDF link is Stripe's own hosted
 * URL — signed, expiring, and always matching what the card statement says.
 *
 * Body: { business_id: string, limit?: number }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);

    const anon = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const svc = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const { business_id, limit = 12 } = await req.json();
    if (!business_id) return json({ error: 'business_id required' }, 400);

    const { data: business } = await svc
      .from('local_businesses')
      .select('id, owner_id, stripe_customer_id')
      .eq('id', business_id)
      .single();

    if (!business || business.owner_id !== user.id) return json({ error: 'Forbidden' }, 403);
    if (!business.stripe_customer_id) return json({ invoices: [] });

    const params = new URLSearchParams({
      customer: business.stripe_customer_id,
      limit: String(Math.min(Number(limit) || 12, 50)),
    });
    const res = await fetch(`https://api.stripe.com/v1/invoices?${params}`, {
      headers: { Authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY') ?? ''}` },
    });
    const body = await res.json();
    if (!res.ok) {
      console.error('[local-subscription-invoices]', body.error?.message);
      return json({ error: 'Could not load your invoices just now.' }, 502);
    }

    // Only what the screen needs. Deliberately not passing Stripe's whole object
    // through to the browser — it carries far more about the customer than a
    // billing list should.
    const invoices = (body.data ?? [])
      // Draft invoices aren't a bill yet and would only confuse.
      .filter((i: Record<string, unknown>) => i.status !== 'draft')
      .map((i: Record<string, unknown>) => ({
        id:          i.id,
        number:      i.number ?? null,
        created:     typeof i.created === 'number' ? new Date((i.created as number) * 1000).toISOString() : null,
        amountPence: (i.amount_paid as number) ?? (i.amount_due as number) ?? 0,
        currency:    i.currency ?? 'gbp',
        status:      i.status ?? 'unknown',
        pdfUrl:      i.invoice_pdf ?? null,
        hostedUrl:   i.hosted_invoice_url ?? null,
      }));

    return json({ invoices });
  } catch (err) {
    console.error('[local-subscription-invoices]', err);
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
