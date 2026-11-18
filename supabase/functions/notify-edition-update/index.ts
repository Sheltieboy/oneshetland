import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendUserPushBulk } from '../_shared/send-push.ts';
import { requireCaller } from '../_shared/require-caller.ts';
import { safeError } from '../_shared/safe-error.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { isUuid } from '../_shared/notify-decision.ts';
import { authoriseEditionUpdateNotify } from '../_shared/edition-update-notify-auth.ts';
import { followerUpdateMessage } from '../_shared/edition-push-text.ts';

/**
 * notify-edition-update — NOT DEPLOYED. When an organiser posts an update on a PUBLISHED, public Edition, tell the people who saved it (push + notification centre; no email).
 *
 * Invoked by the website straight after it saves the update (the same pattern as notify-event-update), with the signed-in organiser's own session:
 *   POST /functions/v1/notify-edition-update   Authorization: Bearer <the organiser's access token>   { "update_id": "<edition_updates.id>" }
 * It is not a database trigger because an update can be saved as a draft or scheduled, and "posted" is a decision the organiser makes; the website knows the moment, a trigger does not.
 *
 * What it trusts: nothing from the request except the update id. Who may call is decided by the database from that row (edition-update-notify-auth.ts); what is sent (Edition title, update
 * title, slug) is read from the database; who receives it is the saved-by list. ONE SEND PER UPDATE: edition_update_notify_claim records the update as handled before anything is sent, so a
 * double click, a retry or a second caller sends nothing more (a crash after the claim loses a best-effort push, it never doubles one). The claim also refuses an Edition that is not public
 * right now (which includes "Editions switched off"), an update not yet published, an update older than two days, and a fourth notified update for one Edition in a day.
 *
 * Delivery goes through sendUserPush: the member's notification preferences (module 'events') and quiet hours are honoured, a failed preference check sends nothing, and every attempt is
 * written to notification_log, which is the notification centre. Not urgent: it never bypasses quiet hours. Rate limited like the other fan-outs.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const CHUNK = 50;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const gate = await requireCaller(req, corsHeaders);
    if ('denied' in gate) return gate.denied;
    const caller = gate.caller;

    if (!caller.isServiceRole) {
      const limited = await enforceRateLimit('notify-edition-update', userSubject(caller.userId), ['notify_fanout', 'notify_any'], corsHeaders);
      if ('denied' in limited) return limited.denied;
    }

    let update_id: unknown;
    try { ({ update_id } = await req.json()); } catch { return json({ error: 'update_id required' }, 400); }
    if (!isUuid(update_id)) return json({ error: 'update_id required' }, 400);
    const svc = createServiceClient();

    const decision = await authoriseEditionUpdateNotify(svc, caller, { updateId: update_id });
    if (!decision.ok) return json({ error: decision.error }, decision.status);

    // The once-only claim. If the database cannot answer, nothing is sent.
    const { data: claim, error: claimError } = await svc.rpc('edition_update_notify_claim', { p_update: update_id, p_actor: caller.isServiceRole ? null : caller.userId });
    if (claimError || !claim || typeof (claim as { status?: unknown }).status !== 'string') return json({ error: 'Service unavailable' }, 503);
    const c = claim as { status: string; edition_id?: string; edition_slug?: string; edition_title?: string; update_title?: string; recipients?: string[] };
    if (c.status === 'not_found') return json({ error: 'update not found' }, 404);
    if (c.status !== 'claimed') return json({ ok: true, notified: 0, skipped: c.status });

    const ids = [...new Set((c.recipients ?? []).filter(isUuid))];
    const msg = followerUpdateMessage(
      { edition_id: c.edition_id ?? '', edition_slug: c.edition_slug ?? '', edition_title: c.edition_title ?? '', update_title: c.update_title ?? '' },
      update_id,
    );

    let sent = 0, skipped = 0, errored = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const r = await sendUserPushBulk(svc, ids.slice(i, i + CHUNK), {
        module: 'events', categoryId: msg.categoryId, urgent: false, title: msg.title, body: msg.body, data: msg.data,
      });
      sent += r.sent; skipped += r.skipped; errored += r.errored;
    }
    await svc.rpc('edition_update_notify_complete', { p_update: update_id, p_sent: sent, p_skipped: skipped, p_errored: errored });

    return json({ ok: true, notified: sent, skipped, errored });
  } catch (err) {
    console.error('[notify-edition-update]', err);
    return json({ error: safeError('notify-edition-update', err) }, 500);
  }
});
