-- Rolls back 20270102210000: removes the function only. Hubs that were verified through it stay verified (that is data, not schema); un-verify them deliberately if needed.
drop function if exists public.admin_set_hub_verified(uuid, boolean, text);
