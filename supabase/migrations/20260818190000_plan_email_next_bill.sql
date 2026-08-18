-- ============================================================================
-- Two corrections to the plan email.
--
-- 1. {{change_sentence}} carries <strong> tags but doesn't end in _html, so
--    send-email escaped it and the reader got "<strong>Pro</strong>" printed at
--    them. Second time today I've made this mistake.
--
-- 2. "Charged today" was simply wrong. Plan changes use
--    proration_behavior: 'create_prorations', which puts the adjustment on the
--    NEXT invoice rather than taking money immediately. Nothing is charged on
--    the day you switch, so the email looked for an invoice that was never
--    created — and would have been lying if it had found one.
--
--    What a business actually wants to know is what the next bill will be, and
--    that it already accounts for the change.
-- ============================================================================

update public.email_templates
set body_html = '<p>Hi {{owner_name}},</p>
<p><strong>{{business_name}}</strong> {{change_sentence_html}}</p>
<table cellpadding="0" cellspacing="0" style="margin:24px 0;width:100%">
  <tr><td style="background:#F0F2F5;border-radius:12px;padding:24px">
    <table cellpadding="0" cellspacing="0" style="width:100%">
      <tr>
        <td style="color:#6B7280;font-size:14px;padding-bottom:6px">Plan</td>
        <td style="color:#0F1C26;font-size:14px;font-weight:700;text-align:right;padding-bottom:6px">{{plan_name}}</td>
      </tr>
      <tr>
        <td style="color:#6B7280;font-size:14px;padding-bottom:6px">Ongoing price</td>
        <td style="color:#0F1C26;font-size:14px;font-weight:700;text-align:right;padding-bottom:6px">{{plan_price}}</td>
      </tr>
      {{next_bill_row_html}}
    </table>
  </td></tr>
</table>
<p style="color:#374151;font-size:15px;line-height:1.6">{{plan_blurb}}</p>
<p style="text-align:center;margin:28px 0">
  <a href="{{manage_url}}" style="background:#7c3aed;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:800;display:inline-block">Open your dashboard</a>
</p>
<p style="color:#6B7280;font-size:13px;line-height:1.6">Nothing was charged today. Changing plan partway through a month is prorated, so your next bill is adjusted for the days you spent on each plan. Cancel or change again any time from Plan, payments &amp; payouts; there is no notice period.</p>',
    variables = ARRAY['owner_name','business_name','change_summary','change_sentence_html','plan_name','plan_price','renews_on','next_bill_row_html','plan_blurb','manage_url']
where key = 'billing.plan_active';
