-- Rolls back 20270102190000: drops the read-only chooser function. Links already created through it are ordinary edition_links and stay.
drop function if exists public.edition_hub_own_items(uuid);
