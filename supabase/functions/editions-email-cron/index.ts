import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { safeEqual } from '../_shared/editions-commerce-core.ts';
import { renderEditionEmail } from '../_shared/editions-email-templates.ts';

/**
 * editions-email-cron — sends the queued Editions transactional emails. NOT DEPLOYED, NOT SCHEDULED. Service-role bearer required.
 * Postmark transactional stream ('outbound'), open and link tracking OFF, one message per outbox row, result recorded per row (a failure is retried up to 5 times by the database).
 * The recipient address exists only inside this function's memory for the moment of sending; the outbox never stores it. Also queues hand-renewal reminders first.
 */
serve(async (req) => {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
  if (!bearer || !safeEqual(bearer, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')) return json({ error: 'Unauthorised' }, 401);
  const token = Deno.env.get('POSTMARK_SERVER_TOKEN') ?? '', from = Deno.env.get('EDITIONS_EMAIL_FROM') ?? '', origin = Deno.env.get('SITE_ORIGIN') ?? 'https://oneshetland.com';
  if (!token || !from) return json({ error: 'Email is not configured' }, 503);
  const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
  await svc.rpc('edition_membership_enqueue_reminders');
  const { data: rows, error } = await svc.rpc('edition_email_next', { p_limit: 25 });
  if (error) return json({ error: 'queue unavailable' }, 500);
  let sent = 0, failed = 0, skipped = 0;
  for (const r of rows ?? []) {
    const m = renderEditionEmail(r, origin);
    if (!m) { await svc.rpc('edition_email_mark', { p_id: r.id, p_ok: true }); skipped++; continue; }
    try {
      const res = await fetch('https://api.postmarkapp.com/email', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': token },
        body: JSON.stringify({ From: from, To: r.email, Subject: m.subject, TextBody: m.text, HtmlBody: m.html, MessageStream: 'outbound', TrackOpens: false, TrackLinks: 'None', Metadata: { kind: String(r.kind), outbox_id: String(r.id) } }) });
      if (res.ok) { await svc.rpc('edition_email_mark', { p_id: r.id, p_ok: true }); sent++; } else { await svc.rpc('edition_email_mark', { p_id: r.id, p_ok: false, p_error: `HTTP ${res.status}` }); failed++; }
    } catch { await svc.rpc('edition_email_mark', { p_id: r.id, p_ok: false, p_error: 'no answer from the mail provider' }); failed++; }
  }
  return json({ ok: true, sent, failed, skipped });
});
