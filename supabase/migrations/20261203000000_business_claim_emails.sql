-- ============================================================================
-- Emails for the business-claim journey: received / approved / rejected (to the claimant) and "new claim" (to the admins).
--
-- Until now a claim made on the website told nobody: the claimant got no confirmation or outcome email (the existing outcome notice is a push to
-- the app) and the admins were not alerted. These four templates ride the existing email infrastructure (email_templates -> sendEmail -> Postmark,
-- logged in email_log); the senders are notify-business-claim and notify-claim.
--
-- Wording promises no timescale. ADDITIVE: four rows, ON CONFLICT DO NOTHING. account.business_approved (never wired, and it says "featured") is left alone.
-- ============================================================================
begin;

insert into public.email_templates (key, category, label, description, subject, body_html, variables, postmark_stream) values
('business.claim_received', 'account', 'Business claim received', 'To the person who claimed a listing, when they submit the claim',
 'We''ve got your claim for {{business_name}}',
 '<h2>Thanks, {{name}} — we''ve got your claim</h2><p>We''ve received your claim for <strong>{{business_name}}</strong> on OneShetland. Claiming a listing is free.</p><p>We check every claim by hand to keep the Directory trustworthy, and we''ll email you as soon as there''s an outcome. If we need anything more from you, we''ll ask by email.</p><p>You don''t need to do anything else for now.</p>',
 ARRAY['name','business_name'], 'outbound'),
('business.claim_approved', 'account', 'Business claim approved', 'To the claimant when an admin approves their claim',
 'Your claim for {{business_name}} was approved',
 '<h2>{{business_name}} is yours to manage</h2><p>Hi {{name}}, we''ve approved your claim and your listing now carries the verified badge.</p><p><a href="{{manage_url}}">Open your dashboard</a> to add your story, photos, hours and contact details. Everything on the free plan is yours to use, and you can upgrade later if you want to.</p>',
 ARRAY['name','business_name','manage_url'], 'outbound'),
('business.claim_rejected', 'account', 'Business claim not approved', 'To the claimant when an admin does not approve their claim',
 'An update on your claim for {{business_name}}',
 '<h2>An update on your claim</h2><p>Hi {{name}}, we weren''t able to approve your claim for <strong>{{business_name}}</strong> this time. That can simply mean we couldn''t confirm your connection to the business from what we had.</p><p>If you think we''ve got this wrong, or you can send us something that shows you run the business (a business email address or website, for example), just reply to this email and we''ll look again.</p>',
 ARRAY['name','business_name'], 'outbound'),
('admin.business_claim_received', 'platform', 'New business claim (to admins)', 'To admins when a business claim is submitted',
 'New business claim: {{business_name}}',
 '<h2>New claim to review</h2><p><strong>{{claimant_name}}</strong> ({{claimant_email}}) has claimed <strong>{{business_name}}</strong>.</p><p>Role: {{role}}<br>How they say we can verify them: {{evidence}}</p><p><a href="{{review_url}}">Review the claim</a></p>',
 ARRAY['claimant_name','claimant_email','business_name','role','evidence','review_url'], 'outbound')
on conflict (key) do nothing;

commit;
