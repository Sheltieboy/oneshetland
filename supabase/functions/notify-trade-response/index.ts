import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendUserPush } from '../_shared/send-push.ts';
import { sendEmail } from '../_shared/send-email.ts';
import { enforceRateLimit, userSubject } from '../_shared/rate-limit.ts';
import { SITE_URL, emailAllowed, isTestJob } from '../_shared/trade-email.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * notify-trade-response
 *
 * Closes the loop on Get it done, by push AND email, both sent AFTER the database change has happened:
 *   kind 'interested'  -> the RESIDENT hears that a named business is interested. Caller must own the matched business.
 *   kind 'shared'      -> the TRADE hears the resident chose to share their details. Caller must be the brief's author.
 * Nothing carries a contact detail: the resident's number is only ever read inside the trade's signed-in dashboard, after the resident shared it.
 * Each channel has its own once-only stamp (push: interest_notified_at / share_notified_at; email: interest_email_at / share_email_at). The email
 * stamp is claimed before sending and released if the send fails, so a failure is never reported as a delivery and a retry cannot double-send.
 * Seed/test jobs notify nobody. dry_run:true authorises the same way and reports what WOULD happen, sending and stamping nothing.
 *
 * Body: { match_id: string, kind: 'interested' | 'shared', dry_run?: boolean }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Unauthorised' }, 401);
    const anon = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await anon.auth.getUser();
    if (!user) return json({ error: 'Unauthorised' }, 401);

    const limited = await enforceRateLimit('notify-trade-response', userSubject(user.id), ['notify_direct', 'notify_any'], corsHeaders);
    if ('denied' in limited) return limited.denied;

    const { match_id, kind, dry_run } = await req.json().catch(() => ({}));
    if (!match_id || (kind !== 'interested' && kind !== 'shared')) return json({ error: 'match_id and kind are required' }, 400);

    const svc = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

    const { data: m } = await svc
      .from('trade_brief_matches')
      .select('id, status, brief_id, business_id, contact_shared_at, interest_notified_at, share_notified_at, interest_email_at, share_email_at, local_businesses(owner_id, name), trade_briefs(author_id, title, location_text)')
      .eq('id', match_id)
      .single();
    if (!m) return json({ ok: true, sent: 0, emailed: 0 });
    const one = <T,>(v: unknown) => (Array.isArray(v) ? v[0] : v) as T | null;
    const biz = one<{ owner_id: string | null; name: string }>(m.local_businesses);
    const brief = one<{ author_id: string; title: string; location_text: string }>(m.trade_briefs);
    if (!biz || !brief) return json({ ok: true, sent: 0, emailed: 0 });
    if (isTestJob(brief.title)) return json({ ok: true, sent: 0, emailed: 0, reason: 'test_job' });

    // Who is told, by which template, and what proves the event really happened.
    const interested = kind === 'interested';
    if (interested) {
      if (biz.owner_id !== user.id) return json({ error: 'Forbidden' }, 403);                // only the business that answered
      if (m.status !== 'interested') return json({ ok: true, sent: 0, emailed: 0, reason: 'not_interested' });
    } else {
      if (brief.author_id !== user.id) return json({ error: 'Forbidden' }, 403);             // only the resident
      if (!m.contact_shared_at) return json({ ok: true, sent: 0, emailed: 0, reason: 'not_shared' });
      if (!biz.owner_id) return json({ ok: true, sent: 0, emailed: 0, reason: 'no_owner' });
    }
    const recipientId = interested ? brief.author_id : (biz.owner_id as string);
    const pushDone = interested ? m.interest_notified_at : m.share_notified_at;
    const emailDone = interested ? m.interest_email_at : m.share_email_at;
    const pushCol = interested ? 'interest_notified_at' : 'share_notified_at';
    const emailCol = interested ? 'interest_email_at' : 'share_email_at';
    if (dry_run) return json({ ok: true, dry_run: true, would_notify: interested ? 'resident' : 'trade', push_pending: !pushDone, email_pending: !emailDone, sent: 0, emailed: 0 });

    // ── push (unchanged behaviour) ──
    let sent = 0; let pushReason: string | undefined;
    if (!pushDone) {
      const r = interested
        ? await sendUserPush(svc, {
            userId: recipientId, module: 'community', categoryId: 'community.trade_reply',
            title: 'A trade is interested in your job',
            body: `${biz.name} can help with: ${brief.title}. Open My jobs to decide whether to share your details.`,
            data: { kind: 'trade_interested', briefId: m.brief_id, matchId: m.id },
          })
        : await sendUserPush(svc, {
            userId: recipientId, module: 'business', categoryId: 'business.lead',
            title: 'A customer shared their details',
            body: `${brief.title} · ${brief.location_text}. Open the lead to contact them.`,
            data: { kind: 'trade_lead_shared', briefId: m.brief_id, matchId: m.id, businessId: m.business_id },
          });
      pushReason = r.reason;
      if (r.status === 'sent') { sent = 1; await svc.from('trade_brief_matches').update({ [pushCol]: new Date().toISOString() }).eq('id', m.id); }
    }

    // ── email (independent: a trade or resident with no app still hears) ──
    let emailed = 0; let emailReason: string | undefined;
    if (!emailDone) {
      try {
        const { data: prefs } = await svc.from('notification_preferences').select('enabled, business_enabled').eq('user_id', recipientId).maybeSingle();
        const { data: u } = await svc.auth.admin.getUserById(recipientId);
        const to = u?.user?.email;
        if (!emailAllowed(prefs, interested ? 'resident' : 'business')) emailReason = 'opted_out';
        else if (!to) emailReason = 'no_address';
        else {
          const { data: claimed } = await svc.from('trade_brief_matches').update({ [emailCol]: new Date().toISOString() }).eq('id', m.id).is(emailCol, null).select('id');
          if (!claimed || claimed.length === 0) emailReason = 'already_sent';
          else {
            const res = await sendEmail(svc, interested
              ? { templateKey: 'trade.interest_received', recipientEmail: to, recipientId, variables: { business_name: biz.name, job_title: brief.title, my_jobs_url: `${SITE_URL}/get-it-done/mine` }, metadata: { kind: 'trade_interested', match_id: m.id } }
              : { templateKey: 'trade.details_shared', recipientEmail: to, recipientId, variables: { business_name: biz.name, job_title: brief.title, leads_url: `${SITE_URL}/business/${m.business_id}/manage/leads` }, metadata: { kind: 'trade_details_shared', match_id: m.id } });
            if (res.ok && !res.skipped) { emailed = 1; emailReason = 'accepted'; }
            else { emailReason = res.skipped ? 'template_disabled' : 'send_failed'; await svc.from('trade_brief_matches').update({ [emailCol]: null }).eq('id', m.id); }   // not delivered: never claim it was
          }
        }
      } catch (e) {
        emailReason = 'send_failed';
        console.error('[notify-trade-response] email failed', e);
        await svc.from('trade_brief_matches').update({ [emailCol]: null }).eq('id', m.id);
      }
    } else emailReason = 'already_sent';

    return json({ ok: true, sent, emailed, reason: pushReason, push_reason: pushReason, email_reason: emailReason });
  } catch (err) {
    console.error('[notify-trade-response]', err);
    return json({ ok: false }, 200);       // never fail loudly: the reply/share has already been recorded
  }
});
