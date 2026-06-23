-- ── 030_gift_received_email.sql ──────────────────────────────────────────────
--
-- Seeds the email template fired when someone gifts a Book unit or booking
-- to a recipient. The recipient gets a branded email with a claim link
-- (oneshetland.com/g/<code>) and the short code as a fallback.
--
-- {{message_html}} is pre-rendered in the edge function — either the
-- italic block containing the personal note, or an empty string. The
-- shared send-email helper only supports plain {{variable}} substitution,
-- not conditionals, so we keep the conditional logic in the function.

INSERT INTO public.email_templates (key, category, label, description, subject, body_html, variables, postmark_stream) VALUES
(
  'local.gift_received',
  'local',
  'Gift received',
  'Recipient gets the gift email with claim link + short code',
  '{{purchaser_name}} sent you a gift on OneShetland',
  '<p>Hi {{recipient_name}},</p>
<p><strong>{{purchaser_name}}</strong> just sent you a gift through OneShetland.</p>
<table cellpadding="0" cellspacing="0" style="margin:24px 0;width:100%">
  <tr><td style="background:#F0F2F5;border-radius:12px;padding:24px;text-align:center">
    <p style="margin:0;color:#6B7280;font-size:12px;text-transform:uppercase;letter-spacing:1.5px;font-weight:700">From {{business_name}}</p>
    <p style="margin:8px 0 0;font-size:22px;font-weight:900;color:#0F1C26">{{item_name}}</p>
    {{message_html}}
  </td></tr>
</table>
<p style="text-align:center;margin:24px 0">
  <a href="{{claim_url}}" style="background:#12B3D6;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:800;display:inline-block">Claim your gift</a>
</p>
<p style="color:#6B7280;font-size:14px">Or open the OneShetland app and enter this code:</p>
<p style="text-align:center;margin:8px 0 24px"><strong style="font-family:Menlo,Consolas,monospace;background:#F0F2F5;padding:8px 16px;border-radius:6px;font-size:18px;letter-spacing:2px;color:#032F4C">{{code}}</strong></p>
<p style="color:#6B7280;font-size:13px;margin-top:24px">Your gift is held in your account once claimed. Open OneShetland to use it whenever you like.</p>',
  ARRAY['purchaser_name','recipient_name','business_name','item_name','message_html','claim_url','code'],
  'outbound'
)
ON CONFLICT (key) DO NOTHING;
