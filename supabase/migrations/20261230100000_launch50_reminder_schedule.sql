-- Daily schedule for the Launch 50 price-returns reminder (the function emails each ACTIVE member once, about 30 days before their founding
-- price ends, and does nothing while there are no active members). Same pattern as reminder-runner: pg_net call with the shared secret read from Vault.
select cron.schedule(
  'launch50-reminders',
  '0 9 * * *',
  $job$
    select net.http_post(
      url     := 'https://nkrtmakxygkvxuxriiil.supabase.co/functions/v1/launch50-reminders',
      headers := jsonb_build_object(
                   'Content-Type',   'application/json',
                   'x-cron-secret',  (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
      body    := '{}'::jsonb,
      timeout_milliseconds := 20000
    );
  $job$
);
