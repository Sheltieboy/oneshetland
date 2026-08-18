-- ============================================================================
-- Say what actually changed, and what it cost today.
--
-- The plan email stated the new plan, its price and the renewal date. It never
-- said what you moved FROM, and never mentioned the amount that had just left
-- your account — so a downgrade read exactly like an upgrade, and a £14.87
-- prorated charge appeared nowhere.
--
-- The confirmation dialog on screen already itemises this. The email is the bit
-- people keep, and it was the weaker of the two.
-- ============================================================================

update public.email_templates
set subject = '{{business_name}}: {{change_summary}}',
    body_html = '<p>Hi {{owner_name}},</p>
<p><strong>{{business_name}}</strong> {{change_sentence}}</p>
<table cellpadding="0" cellspacing="0" style="margin:24px 0;width:100%">
  <tr><td style="background:#F0F2F5;border-radius:12px;padding:24px">
    <table cellpadding="0" cellspacing="0" style="width:100%">
      <tr>
        <td style="color:#6B7280;font-size:14px;padding-bottom:6px">Plan</td>
        <td style="color:#0F1C26;font-size:14px;font-weight:700;text-align:right;padding-bottom:6px">{{plan_name}}</td>
      </tr>
      <tr>
        <td style="color:#6B7280;font-size:14px;padding-bottom:6px">Price from {{renews_on}}</td>
        <td style="color:#0F1C26;font-size:14px;font-weight:700;text-align:right;padding-bottom:6px">{{plan_price}}</td>
      </tr>
      {{today_row_html}}
    </table>
  </td></tr>
</table>
<p style="color:#374151;font-size:15px;line-height:1.6">{{plan_blurb}}</p>
<p style="text-align:center;margin:28px 0">
  <a href="{{manage_url}}" style="background:#7c3aed;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:800;display:inline-block">Open your dashboard</a>
</p>
<p style="color:#6B7280;font-size:13px;line-height:1.6">Changing plan partway through a month is prorated — you only pay the difference for the days left, and the full price starts on the renewal date. Cancel or change again any time from Plan, payments &amp; payouts; there is no notice period.</p>',
    variables = ARRAY['owner_name','business_name','change_summary','change_sentence','plan_name','plan_price','renews_on','today_row_html','plan_blurb','manage_url']
where key = 'billing.plan_active';
