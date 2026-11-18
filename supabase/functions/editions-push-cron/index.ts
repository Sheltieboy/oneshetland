import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendUserPush } from '../_shared/send-push.ts';
import { safeEqual } from '../_shared/editions-commerce-core.ts';
import { organiserMessage } from '../_shared/edition-push-text.ts';
import { safeError } from '../_shared/safe-error.ts';

/**
 * editions-push-cron — NOT DEPLOYED, NOT SCHEDULED. Sends the queued Editions ORGANISER pushes (review decisions: approved, changes requested, rejected; package activation) to the people
 * the email queue already chose, through the existing sender (preferences, quiet hours, fail-closed, notification_log). Service-role bearer required, like editions-email-cron.
 *
 * The database decides what is due (edition_push_next): nothing while Editions is switched off, nothing older than a day, nothing for someone no longer on the team, each row claimed once.
 * Module 'business' ("My business: approvals"); not urgent, so quiet hours hold a push back (it is not retried: email is the reliable channel). The text carries no price, buying, package or
 * promotion wording and no personal data; the Edition title is read from the database. The tap opens the app (the Edition may not be public yet); the item sits in the notification centre.
 */
serve(async (req) => {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  try {
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!key || !bearer || !safeEqual(bearer, key)) return json({ error: 'Unauthorised' }, 401);

    const svc = createServiceClient();
    const { data: rows, error } = await svc.rpc('edition_push_next', { p_limit: 25 });
    if (error) return json({ error: 'queue unavailable' }, 503);

    let sent = 0, held = 0, failed = 0;
    for (const r of (rows ?? []) as { id: number; kind: string; user_id: string; edition_id: string }[]) {
      try {
        const { data: ed } = await svc.from('editions').select('title').eq('id', r.edition_id).maybeSingle();
        const msg = organiserMessage(r.kind, (ed as { title?: string } | null)?.title ?? '');
        if (!msg) { await svc.rpc('edition_push_mark', { p_id: r.id, p_outcome: 'skipped_unknown_kind' }); continue; }
        const res = await sendUserPush(svc, { userId: r.user_id, module: 'business', categoryId: msg.categoryId, urgent: false, title: msg.title, body: msg.body, data: msg.data });
        await svc.rpc('edition_push_mark', { p_id: r.id, p_outcome: res.reason });
        if (res.status === 'sent') sent++; else if (res.status === 'error') failed++; else held++;
      } catch (e) {
        console.error('[editions-push-cron] row failed', r.id, e instanceof Error ? e.message : String(e));
        await svc.rpc('edition_push_mark', { p_id: r.id, p_outcome: 'error' });
        failed++;
      }
    }
    return json({ ok: true, sent, held, failed });
  } catch (err) {
    console.error('[editions-push-cron]', err);
    return json({ error: safeError('editions-push-cron', err) }, 500);
  }
});
