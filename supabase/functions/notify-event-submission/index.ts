import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendEmail } from '../_shared/send-email.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { SITE_URL, emailAllowed, isTestJob } from '../_shared/trade-email.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const RECENT_MS = 15 * 60 * 1000;

/**
 * notify-event-submission
 *
 * Emails the contributor about a staff decision on their community event submission: approved, changes requested or rejected.
 * Called by the admin screen AFTER the review function succeeded. Everything is re-verified here, so the call itself grants nothing:
 *   - the caller must be OneShetland staff AND the person who recorded the decision (reviewed_by);
 *   - the decision must be recent (15 minutes), so an old decision can never be emailed by calling this later;
 *   - one email per decision: decision_email_for is claimed (= reviewed_at) BEFORE sending and released if the send fails, so retries
 *     cannot double-send and a failure is never reported as sent;
 *   - nobody is emailed when the account is deleted/banned/has no address, when they opted out of email, when the submission is a staff
 *     member's own (testing), or when the title marks it as a test;
 *   - the email carries only the title, the public/management links and the reason written FOR the member. Never the reviewer, never audit data.
 * Body: { submission_id: string }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);
    const { data: isStaff } = await anon.rpc('attribution_staff');
    if (isStaff !== true) return json({ error: 'Forbidden' }, 403);

    const limited = await enforceRateLimit('notify-event-submission', userSubject(user.id), ['notify_direct', 'notify_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const { submission_id } = await req.json().catch(() => ({}));
    if (!submission_id || typeof submission_id !== 'string') return json({ error: 'submission_id is required' }, 400);

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const { data: s } = await svc.from('event_submissions')
      .select('id, submitter_id, status, title, review_reason, reviewed_at, reviewed_by, event_id, decision_email_for')
      .eq('id', submission_id).single();
    if (!s) return json({ ok: true, emailed: 0, reason: 'not_found' });
    if (!['approved', 'rejected', 'changes_requested'].includes(s.status)) return json({ ok: true, emailed: 0, reason: 'not_decided' });
    if (!s.reviewed_at || Date.now() - Date.parse(s.reviewed_at) > RECENT_MS) return json({ ok: true, emailed: 0, reason: 'not_recent' });
    if (s.reviewed_by !== user.id) return json({ error: 'Forbidden' }, 403);
    if (s.submitter_id === s.reviewed_by) return json({ ok: true, emailed: 0, reason: 'own_submission' });
    if (isTestJob(s.title)) return json({ ok: true, emailed: 0, reason: 'test_event' });
    if (s.decision_email_for && Date.parse(s.decision_email_for) === Date.parse(s.reviewed_at)) return json({ ok: true, emailed: 0, reason: 'already_sent' });
    if (s.status === 'approved' && !s.event_id) return json({ ok: true, emailed: 0, reason: 'no_event' });
    if (s.status !== 'approved' && !(s.review_reason ?? '').trim()) return json({ ok: true, emailed: 0, reason: 'no_reason' });

    // Privacy: deleted/banned accounts and opt-outs get nothing.
    const { data: u } = await svc.auth.admin.getUserById(s.submitter_id);
    const au = u?.user as { email?: string; deleted_at?: string | null; banned_until?: string | null } | null;
    const to = au?.email;
    if (!au || au.deleted_at || (au.banned_until && Date.parse(au.banned_until) > Date.now()) || !to) return json({ ok: true, emailed: 0, reason: 'recipient_unavailable' });
    const { data: prof } = await svc.from('profiles').select('deleted_at').eq('id', s.submitter_id).maybeSingle();
    if (prof?.deleted_at) return json({ ok: true, emailed: 0, reason: 'recipient_unavailable' });
    const { data: prefs } = await svc.from('notification_preferences').select('enabled, business_enabled').eq('user_id', s.submitter_id).maybeSingle();
    if (!emailAllowed(prefs, 'resident')) return json({ ok: true, emailed: 0, reason: 'opted_out' });

    // Claim this decision, then send; release the claim if the send does not succeed.
    const { data: claimed } = await svc.from('event_submissions').update({ decision_email_for: s.reviewed_at }).eq('id', s.id).select('id');
    if (!claimed || claimed.length === 0) return json({ ok: true, emailed: 0, reason: 'already_sent' });
    const variables: Record<string, string> = { event_title: s.title };
    let templateKey: string;
    if (s.status === 'approved') {
      templateKey = 'events.submission_approved';
      variables.event_url = `${SITE_URL}/whats-on/${s.event_id}`;
      variables.my_events_url = `${SITE_URL}/account/event-submissions/event/${s.event_id}`;
    } else {
      templateKey = s.status === 'changes_requested' ? 'events.submission_changes' : 'events.submission_rejected';
      variables.review_reason = (s.review_reason as string).trim();
      variables.submissions_url = `${SITE_URL}/account/event-submissions`;
    }
    try {
      const res = await sendEmail(svc, { templateKey, recipientEmail: to, recipientId: s.submitter_id, variables, metadata: { kind: 'event_submission_decision', submission_id: s.id, decision: s.status } });
      if (res.ok && !res.skipped) return json({ ok: true, emailed: 1 });
      await svc.from('event_submissions').update({ decision_email_for: s.decision_email_for ?? null }).eq('id', s.id);
      return json({ ok: true, emailed: 0, reason: res.skipped ? 'template_disabled' : 'send_failed' });
    } catch (e) {
      console.error('[notify-event-submission] send failed', e);
      await svc.from('event_submissions').update({ decision_email_for: s.decision_email_for ?? null }).eq('id', s.id);
      return json({ ok: true, emailed: 0, reason: 'send_failed' });
    }
  } catch (err) {
    console.error('[notify-event-submission]', err);
    return json({ ok: false }, 200);
  }
});
