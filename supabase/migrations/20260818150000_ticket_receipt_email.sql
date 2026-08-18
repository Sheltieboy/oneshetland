-- ============================================================================
-- Confirm a ticket purchase in writing.
--
-- Buying sent a push and nothing else, and push reaches nobody today — the app
-- is unpublished, so push_tokens is empty. Somebody paid for tickets and got
-- silence, which is the one moment a stranger most needs reassurance that their
-- money did something.
--
-- The email carries the door codes, so it works as the ticket itself for anyone
-- who never opens the site again — which, for a visitor buying one ticket to one
-- event, is most of them.
-- ============================================================================

INSERT INTO public.email_templates (key, category, label, description, subject, body_html, variables, postmark_stream) VALUES
(
  'events.tickets_confirmed',
  'events',
  'Tickets confirmed',
  'Sent to the buyer when payment for event tickets succeeds',
  'Your tickets for {{event_title}}',
  '<p>Hi {{buyer_name}},</p>
<p>That''s your {{ticket_count}} booked for <strong>{{event_title}}</strong>.</p>
<table cellpadding="0" cellspacing="0" style="margin:24px 0;width:100%">
  <tr><td style="background:#F0F2F5;border-radius:12px;padding:24px">
    <p style="margin:0;color:#6B7280;font-size:12px;text-transform:uppercase;letter-spacing:1.5px;font-weight:700">When</p>
    <p style="margin:4px 0 0;font-size:18px;font-weight:900;color:#0F1C26">{{event_when}}</p>
    <p style="margin:14px 0 0;color:#6B7280;font-size:12px;text-transform:uppercase;letter-spacing:1.5px;font-weight:700">Where</p>
    <p style="margin:4px 0 0;font-size:16px;font-weight:700;color:#0F1C26">{{event_where}}</p>
  </td></tr>
</table>
<h3 style="margin:28px 0 8px;font-size:16px;color:#0F1C26">Show this at the door</h3>
<p style="margin:0 0 12px;color:#374151;font-size:15px">Either the code below, or the QR in your account — whichever is easier on the night.</p>
<p style="text-align:center;margin:0 0 24px">{{ticket_codes}}</p>
<table cellpadding="0" cellspacing="0" style="margin:24px 0;width:100%">
  <tr><td style="background:#F0F2F5;border-radius:12px;padding:16px 24px">
    <table cellpadding="0" cellspacing="0" style="width:100%">
      <tr><td style="color:#6B7280;font-size:14px">Tickets</td><td style="color:#0F1C26;font-size:14px;font-weight:700;text-align:right">{{tickets_total}}</td></tr>
      <tr><td style="color:#6B7280;font-size:14px;padding-top:4px">Booking fee</td><td style="color:#0F1C26;font-size:14px;font-weight:700;text-align:right;padding-top:4px">{{booking_fee}}</td></tr>
      <tr><td style="color:#0F1C26;font-size:15px;font-weight:800;padding-top:8px;border-top:1px solid #D9D2C7">Paid</td><td style="color:#0F1C26;font-size:15px;font-weight:900;text-align:right;padding-top:8px;border-top:1px solid #D9D2C7">{{total_paid}}</td></tr>
    </table>
  </td></tr>
</table>
<p style="text-align:center;margin:28px 0">
  <a href="{{tickets_url}}" style="background:#d4921a;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:800;display:inline-block">See your tickets</a>
</p>
<p style="color:#6B7280;font-size:13px">Organised by {{organiser_name}}. If the event changes or is cancelled we will email you — you do not need to check back.</p>',
  ARRAY['buyer_name','event_title','event_when','event_where','ticket_count','ticket_codes','tickets_total','booking_fee','total_paid','tickets_url','organiser_name'],
  'outbound'
)
ON CONFLICT (key) DO NOTHING;
