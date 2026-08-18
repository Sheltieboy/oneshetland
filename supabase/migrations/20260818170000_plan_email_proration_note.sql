-- ============================================================================
-- Say that the first payment is prorated.
--
-- The plan email showed "Price £29/month" and nothing else, so somebody who had
-- just been charged £14.87 mid-cycle saw a number that didn't match anything on
-- their statement. The confirmation dialog knew the real figure and the email
-- didn't, which is the wrong way round — the email is the bit people keep.
--
-- The webhook fires on customer.subscription.updated and doesn't carry the
-- proration invoice, so it cannot state today's exact amount without a second
-- Stripe call on a path that must not fail. It can be honest about WHY the
-- numbers differ, which is what actually causes the confusion.
-- ============================================================================

update public.email_templates
set body_html = replace(
      body_html,
      '<p style="color:#374151;font-size:15px;line-height:1.6">{{plan_blurb}}</p>',
      '<p style="color:#374151;font-size:15px;line-height:1.6">{{plan_blurb}}</p>
<p style="color:#6B7280;font-size:13px;line-height:1.6;margin-top:18px">If you changed plan partway through a month, your first payment will be smaller than the price above — we only charge the difference for the days left, and the full price starts on the renewal date. Your card statement is the exact figure.</p>'
    )
where key = 'billing.plan_active'
  and body_html not like '%only charge the difference for the days left%';
