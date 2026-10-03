-- should_notify(user, module, urgent) answers "has THIS user muted this module / are they in quiet hours?".
-- It is SECURITY DEFINER and takes the user id as an argument, and it was executable by anon and
-- authenticated — so anyone holding the public anon key could ask it about any user id and learn how
-- that person has set their notification preferences.
--
-- Only the edge functions that send notifications call it (send-push.ts and reminder-runner), and they
-- use the service role. Nothing in the apps, the web, any SQL function or any trigger calls it.
-- The inbox RPCs (unread_notification_count, mark_notifications_read) are different: they read
-- auth.uid() and stay open to signed-in users.

revoke execute on function public.should_notify(uuid, text, boolean) from public, anon, authenticated;
grant  execute on function public.should_notify(uuid, text, boolean) to service_role;
