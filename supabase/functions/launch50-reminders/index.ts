import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireCronSecret } from '../_shared/cron-auth.ts';
import { sendEmail } from '../_shared/send-email.ts';

/**
 * launch50-reminders — run daily by the scheduler. Emails each ACTIVE Launch 50 member once, about 30 days before their founding price
 * ends, so the return to the standard price is never a surprise. Skips anyone already cancelling. The reminder is stamped ONLY after the
 * email was accepted; a failure is retried the next day and is never reported as sent. Does nothing until there are active members.
 */
const FOUNDING: Record<string, { label: string; founding: string; standard: string }> = {
  pro: { label: 'Pro', founding: '£9', standard: '£12' },
  premium: { label: 'Premium', founding: '£22', standard: '£29' },
};

serve(async (req) => {
  const denied = requireCronSecret(req, {});
  if (denied) return denied;
  const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
  let sent = 0; let failed = 0;
  const { data: due } = await svc.rpc('launch50_due_reminders');
  for (const r of (due ?? []) as { business_id: string; owner_id: string; tier: string; discount_ends_at: string; business_name: string }[]) {
    try {
      const { data: u } = await svc.auth.admin.getUserById(r.owner_id);
      const to = u?.user?.email;
      const f = FOUNDING[r.tier];
      if (!to || !f) continue;
      const res = await sendEmail(svc, {
        templateKey: 'launch50.price_returns', recipientEmail: to, recipientId: r.owner_id,
        variables: {
          business_name: r.business_name, tier_label: f.label, founding_price: f.founding, standard_price: f.standard,
          ends_on: new Date(r.discount_ends_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }),
          billing_url: `https://oneshetland.com/business/${r.business_id}/manage/billing`,
        },
        metadata: { kind: 'launch50_price_returns', business_id: r.business_id },
      });
      if (res.ok && !res.skipped) { await svc.rpc('launch50_mark_reminded', { p_business: r.business_id }); sent++; } else failed++;
    } catch (e) { failed++; console.error('[launch50-reminders]', e); }
  }
  return new Response(JSON.stringify({ ok: true, sent, failed }), { headers: { 'Content-Type': 'application/json' } });
});
