-- Spik: approving a community suggestion now PUBLISHES it to the live dictionary
-- word (applying the suggested value to the relevant field) and records the
-- submitter as the word's contributor — instead of the old "copy into WordPress"
-- workflow. Admin-only, SECURITY DEFINER, with a whitelist of editable fields.

create or replace function public.approve_spik_suggestion(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.spik_suggestions%rowtype;
  allowed text[] := array[
    'word','alternate_spelling','pronunciation','short_meaning','spik_meaning',
    'example_sentence','part_of_speech','category','usage_level','era','tone',
    'origin','notes','speaker_area'
  ];
begin
  if not public.is_admin() then
    raise exception 'Not authorised';
  end if;

  select * into s from public.spik_suggestions where id = p_id;
  if not found then raise exception 'Suggestion not found'; end if;
  if s.word_id is null then raise exception 'Suggestion has no target word to publish to'; end if;
  if not (s.field_name = any(allowed)) then
    raise exception 'Field "%" is not publishable', s.field_name;
  end if;

  -- Apply the suggested value to the live word + record who suggested it.
  execute format(
    'update public.spik_dictionary
        set %I = $1, contributor_name = $2, contributor_show = $3, updated_at = now()
      where id = $4',
    s.field_name
  ) using s.suggested_value, s.submitter_name, coalesce(s.show_name, false), s.word_id;

  update public.spik_suggestions
     set status = 'approved', reviewed_at = now()
   where id = p_id;
end;
$$;

grant execute on function public.approve_spik_suggestion(uuid) to authenticated;
