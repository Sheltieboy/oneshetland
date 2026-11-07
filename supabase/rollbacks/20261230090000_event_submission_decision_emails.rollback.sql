delete from public.email_templates where key in ('events.submission_approved','events.submission_changes','events.submission_rejected');
-- the decision_email_for column is kept (harmless).
