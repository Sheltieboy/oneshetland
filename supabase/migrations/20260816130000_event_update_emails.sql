-- ============================================================================
-- Event updates by EMAIL, not just push.
--
-- An organiser could already message every ticket holder, and it landed in the
-- on-site notifications inbox and as a push. Neither reaches the person who
-- matters most: a visitor who bought one ticket, will never open the site
-- again, and does not have the app (which is unpublished, so push_tokens is
-- empty). A cancelled event never reached the people who had paid for it.
--
-- Two templates, because a cancellation is not an update. It needs a different
-- subject line, a plainer apology, and it must say what happens about money —
-- that is the first question anybody asks.
-- ============================================================================

INSERT INTO public.email_templates (key, category, label, description, subject, body_html, variables, postmark_stream) VALUES
(
  'events.update',
  'events',
  'Event update',
  'Sent to every valid ticket holder when an organiser posts an update',
  '{{event_title}} — {{update_title}}',
  '<p>Hi {{recipient_name}},</p>
<p><strong>{{organiser_name}}</strong> has posted an update about an event you have tickets for.</p>
<table cellpadding="0" cellspacing="0" style="margin:24px 0;width:100%">
  <tr><td style="background:#F0F2F5;border-radius:12px;padding:24px">
    <p style="margin:0;color:#6B7280;font-size:12px;text-transform:uppercase;letter-spacing:1.5px;font-weight:700">{{event_title}}</p>
    <p style="margin:8px 0 0;font-size:20px;font-weight:900;color:#0F1C26">{{update_title}}</p>
    <p style="margin:12px 0 0;color:#374151;font-size:15px;line-height:1.6">{{update_body}}</p>
  </td></tr>
</table>
<p style="margin:0 0 4px;color:#6B7280;font-size:14px">When it was: {{event_when}}</p>
<p style="margin:0;color:#6B7280;font-size:14px">Where: {{event_where}}</p>
<p style="text-align:center;margin:28px 0">
  <a href="{{event_url}}" style="background:#12B3D6;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:800;display:inline-block">See the event</a>
</p>
<p style="color:#6B7280;font-size:13px;margin-top:24px">You are getting this because you have a ticket. We only email ticket holders when something about the event itself changes.</p>',
  ARRAY['recipient_name','organiser_name','event_title','update_title','update_body','event_when','event_where','event_url'],
  'outbound'
),
(
  'events.cancelled',
  'events',
  'Event cancelled',
  'Sent to every valid ticket holder when an organiser cancels an event',
  '{{event_title}} has been cancelled',
  '<p>Hi {{recipient_name}},</p>
<p>We are sorry — <strong>{{event_title}}</strong>, which you had tickets for, has been cancelled by the organiser.</p>
<table cellpadding="0" cellspacing="0" style="margin:24px 0;width:100%">
  <tr><td style="background:#FFF2F1;border-left:4px solid #FF3B30;border-radius:8px;padding:20px">
    <p style="margin:0;color:#0F1C26;font-size:15px;line-height:1.6">{{update_body}}</p>
  </td></tr>
</table>
<p style="margin:0 0 4px;color:#6B7280;font-size:14px">It was due to be: {{event_when}}</p>
<p style="margin:0;color:#6B7280;font-size:14px">At: {{event_where}}</p>
<h3 style="margin:28px 0 8px;font-size:16px;color:#0F1C26">What happens about your money</h3>
<p style="margin:0;color:#374151;font-size:15px;line-height:1.6">Refunds are handled by {{organiser_name}}, who received the ticket price. If you have not heard from them within a few days, reply to this email and we will chase it up for you.</p>
<p style="text-align:center;margin:28px 0">
  <a href="{{tickets_url}}" style="background:#032F4C;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:800;display:inline-block">Your tickets</a>
</p>',
  ARRAY['recipient_name','organiser_name','event_title','update_body','event_when','event_where','tickets_url'],
  'outbound'
)
ON CONFLICT (key) DO NOTHING;
