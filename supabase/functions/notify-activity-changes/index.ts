import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createServiceClient, sendUserPushBulk } from '../_shared/send-push.ts';
import { requireCronSecret } from '../_shared/cron-auth.ts';
import { safeError } from '../_shared/safe-error.ts';
import { runActivityNotices, type Deps, type NoticeRow } from '../_shared/activity-notices.ts';

/**
 * notify-activity-changes — the sender for Regular Activities followers.
 *
 * Scheduler-only (x-cron-secret, fails closed). It reads the private outbox the database fills, collapses it, and sends at most one
 * message per activity per run to that activity's followers through the EXISTING push path (preferences and quiet hours honoured; the
 * in-app inbox row is written for every attempt). It sends no email and no reminders. NOT DEPLOYED, and not scheduled: a person decides
 * when, after the first real test. See _shared/activity-notices.ts for the rules.
 */
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' };

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const denied = requireCronSecret(req, corsHeaders);
    if (denied) return denied;

    const svc = createServiceClient();
    const deps: Deps = {
      now: () => new Date(),
      loadPending: async (limit) => {
        const { data, error } = await svc.from('activity_change_notices').select('*').is('processed_at', null).order('created_at').limit(limit);
        if (error) throw error;
        return (data ?? []) as NoticeRow[];
      },
      loadLastStates: async (keys) => {
        const m = new Map<string, string>();
        if (!keys.length) return m;
        const { data } = await svc.from('activity_notice_state').select('session_key, last_state_hash').in('session_key', keys);
        for (const r of data ?? []) m.set(r.session_key as string, r.last_state_hash as string);
        return m;
      },
      loadActivity: async (id) => {
        const { data } = await svc.from('regular_activities').select('id, title, slug, status, admin_paused, calendar_approved, organiser_hub_id').eq('id', id).maybeSingle();
        if (!data) return null;
        const hubOk = !data.organiser_hub_id || data.calendar_approved === true;
        return { id: data.id, title: data.title, slug: data.slug, is_public: data.status === 'published' && !data.admin_paused && hubOk };
      },
      loadFollowers: async (activityId, limit) => {
        const { data } = await svc.from('activity_follows').select('user_id').eq('activity_id', activityId).limit(limit);
        return (data ?? []).map((r) => r.user_id as string);
      },
      push: (userIds, msg) => sendUserPushBulk(svc, userIds, { module: 'events', categoryId: 'activities.change', title: msg.title, body: msg.body, data: msg.data, urgent: true }),
      markProcessed: async (ids) => { await svc.from('activity_change_notices').update({ processed_at: new Date().toISOString() }).in('id', ids); },
      saveStates: async (rows) => { await svc.from('activity_notice_state').upsert(rows.map((r) => ({ ...r, last_sent_at: new Date().toISOString() })), { onConflict: 'session_key' }); },
    };
    const summary = await runActivityNotices(deps);
    return new Response(JSON.stringify(summary), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('[notify-activity-changes]', err);
    return new Response(JSON.stringify({ error: safeError('notify-activity-changes', err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
