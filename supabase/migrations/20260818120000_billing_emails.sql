-- ============================================================================
-- Tell a business, in writing, when its plan changes.
--
-- Nothing was sent when somebody upgraded. The only subscription messages were
-- a push on failure and a push on ending — and push reaches nobody today, since
-- the app is unpublished and push_tokens is empty. So a business could pay for
-- Pro and hear nothing at all from OneShetland.
--
-- Two templates, because starting and stopping are different conversations. The
-- first confirms what they now have and when it renews; the second says plainly
-- what has stopped working, and does not sulk about it.
-- ============================================================================

INSERT INTO public.email_templates (key, category, label, description, subject, body_html, variables, postmark_stream) VALUES
(
  'billing.plan_active',
  'billing',
  'Plan started or changed',
  'Sent to the business owner when a subscription starts, upgrades or downgrades',
  '{{business_name}} is now on {{plan_name}}',
  '<p>Hi {{owner_name}},</p>
<p><strong>{{business_name}}</strong> is now on <strong>{{plan_name}}</strong>.</p>
<table cellpadding="0" cellspacing="0" style="margin:24px 0;width:100%">
  <tr><td style="background:#F0F2F5;border-radius:12px;padding:24px">
    <table cellpadding="0" cellspacing="0" style="width:100%">
      <tr>
        <td style="color:#6B7280;font-size:14px;padding-bottom:6px">Plan</td>
        <td style="color:#0F1C26;font-size:14px;font-weight:700;text-align:right;padding-bottom:6px">{{plan_name}}</td>
      </tr>
      <tr>
        <td style="color:#6B7280;font-size:14px;padding-bottom:6px">Price</td>
        <td style="color:#0F1C26;font-size:14px;font-weight:700;text-align:right;padding-bottom:6px">{{plan_price}}</td>
      </tr>
      <tr>
        <td style="color:#6B7280;font-size:14px">Renews</td>
        <td style="color:#0F1C26;font-size:14px;font-weight:700;text-align:right">{{renews_on}}</td>
      </tr>
    </table>
  </td></tr>
</table>
<p style="color:#374151;font-size:15px;line-height:1.6">{{plan_blurb}}</p>
<p style="text-align:center;margin:28px 0">
  <a href="{{manage_url}}" style="background:#7c3aed;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:800;display:inline-block">Open your dashboard</a>
</p>
<p style="color:#6B7280;font-size:13px">You can change or cancel your plan at any time from Plan, payments &amp; payouts. There is no notice period — you keep what you have paid for until the end of the month you have already paid.</p>',
  ARRAY['owner_name','business_name','plan_name','plan_price','renews_on','plan_blurb','manage_url'],
  'outbound'
),
(
  'billing.plan_ended',
  'billing',
  'Plan ended',
  'Sent to the business owner when a subscription ends or lapses',
  '{{business_name}} is back on the free plan',
  '<p>Hi {{owner_name}},</p>
<p><strong>{{business_name}}</strong> is back on the free plan{{ended_reason}}.</p>
<p style="color:#374151;font-size:15px;line-height:1.6">Your listing stays exactly where it is — name, photos, description, opening hours, contacts and map are all free and always will be, and you can still post jobs and sell event tickets.</p>
<table cellpadding="0" cellspacing="0" style="margin:24px 0;width:100%">
  <tr><td style="background:#FFF8EC;border-left:4px solid #FF9500;border-radius:8px;padding:20px">
    <p style="margin:0;color:#0F1C26;font-size:15px;line-height:1.6"><strong>What has stopped:</strong> {{lost_features}}</p>
  </td></tr>
</table>
<p style="text-align:center;margin:28px 0">
  <a href="{{manage_url}}" style="background:#032F4C;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:800;display:inline-block">See plans</a>
</p>
<p style="color:#6B7280;font-size:13px">Nothing has been deleted. Start again whenever it suits and it all comes straight back.</p>',
  ARRAY['owner_name','business_name','ended_reason','lost_features','manage_url'],
  'outbound'
)
ON CONFLICT (key) DO NOTHING;
