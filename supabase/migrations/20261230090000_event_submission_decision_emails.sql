-- Contributor emails when staff decide on a community event submission (approved / changes requested / rejected).
-- Add-only: one stamp column and three email templates. Nothing here sends anything; the website calls the notify-event-submission function
-- AFTER a staff review succeeds. decision_email_for records which decision (reviewed_at) was emailed, so one decision is emailed once and
-- decisions made before this migration are never emailed (they have no stamp but the function refuses anything reviewed over 15 minutes ago).

alter table public.event_submissions add column if not exists decision_email_for timestamptz;

insert into public.email_templates (key, category, label, description, enabled, subject, body_html, variables, requires_optin, postmark_stream)
values
('events.submission_approved', 'events', 'Event submission approved', 'Sent to the contributor once, right after staff approve their event.', true,
 'Your event is live: {{event_title}}',
 '<h2>Congratulations, your event is live</h2><p>{{event_title}} has been approved and is now on OneShetland.</p><p><a href="{{event_url}}">See your event</a></p><p>To check its dates, ask for a change or report a cancellation, open <a href="{{my_events_url}}">My events &amp; submissions</a>.</p>',
 array['event_title','event_url','my_events_url'], false, 'outbound'),
('events.submission_changes', 'events', 'Event submission: changes requested', 'Sent to the contributor once, right after staff ask for changes.', true,
 'Changes needed for your event: {{event_title}}',
 '<h2>A few changes are needed</h2><p>Thank you for sending {{event_title}}. It is not on OneShetland yet, because a change is needed first:</p><p><em>{{review_reason}}</em></p><p><a href="{{submissions_url}}">Open My events &amp; submissions</a> to see your submission.</p>',
 array['event_title','review_reason','submissions_url'], false, 'outbound'),
('events.submission_rejected', 'events', 'Event submission not accepted', 'Sent to the contributor once, right after staff decline their event.', true,
 'Update on your event: {{event_title}}',
 '<h2>Thank you for sending your event</h2><p>OneShetland is not able to list {{event_title}} this time.</p><p><strong>Reason:</strong> <em>{{review_reason}}</em></p><p>You are welcome to send another event whenever you like from <a href="{{submissions_url}}">My events &amp; submissions</a>.</p>',
 array['event_title','review_reason','submissions_url'], false, 'outbound')
on conflict (key) do nothing;
