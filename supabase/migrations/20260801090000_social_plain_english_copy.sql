-- Copy direction change: social posts are written in plain English — Shetland
-- dialect appears only as the CONTENT being featured (the word of the day
-- itself), never as the caption/voice. Renames the seeded recipe labels and
-- clears any not-yet-approved drafts composed with the old dialect templates
-- so the composer regenerates them with the new copy (deleting frees the
-- (kind, entity_id) dedupe slot).

update public.social_recipes set label = 'Word of the day'      where key = 'wird_of_day';
update public.social_recipes set label = 'What''s On this week' where key = 'whats_on_roundup';

delete from public.social_posts where status = 'draft';
