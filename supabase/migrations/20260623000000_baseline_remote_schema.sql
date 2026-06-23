--
-- PostgreSQL database dump
--

\restrict KKGIjwdlA8I5QVvRKzQV78KqOpzMh0xzyEVvFTCytipYLFSIgHGMiIj5pu8E1SO

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: vessel_edit_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vessel_edit_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vessel_id uuid NOT NULL,
    target_table text NOT NULL,
    target_row_id uuid,
    target_column text,
    action text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    current_value text,
    summary text NOT NULL,
    note text,
    proposed_by uuid,
    status text DEFAULT 'open'::text NOT NULL,
    confirm_count integer DEFAULT 0 NOT NULL,
    dispute_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_at timestamp with time zone,
    resolved_at timestamp with time zone,
    CONSTRAINT vessel_edit_proposals_action_check CHECK ((action = ANY (ARRAY['edit'::text, 'add'::text, 'remove'::text]))),
    CONSTRAINT vessel_edit_proposals_status_check CHECK ((status = ANY (ARRAY['open'::text, 'applied'::text, 'rejected'::text, 'superseded'::text]))),
    CONSTRAINT vessel_edit_proposals_target_table_check CHECK ((target_table = ANY (ARRAY['vessels'::text, 'vessel_names'::text, 'registrations'::text, 'ownership_periods'::text, 'owners'::text, 'measurements'::text])))
);


--
-- Name: _apply_vessel_edit(public.vessel_edit_proposals); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._apply_vessel_edit(p public.vessel_edit_proposals) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_cast     text;
  v_conf_col text;
  v_owner_id uuid;
  v_val      text;
begin
  if p.action = 'edit' then
    v_cast := public.vessel_edit_col_cast(p.target_table, p.target_column);
    if v_cast is null then
      raise exception 'column % is not editable on %', p.target_column, p.target_table;
    end if;
    v_val := nullif(p.payload->>'value', '');

    if p.target_table = 'vessels' then
      execute format('update public.vessels set %I = $1::%s, updated_at = now() where id = $2',
                     p.target_column, v_cast)
        using v_val, p.vessel_id;
    else
      execute format('update public.%I set %I = $1::%s where id = $2',
                     p.target_table, p.target_column, v_cast)
        using v_val, p.target_row_id;
    end if;

    -- An applied edit reads as community-confirmed.
    v_conf_col := public.vessel_edit_conf_col(p.target_table);
    if v_conf_col is not null then
      if p.target_table = 'vessels' then
        execute format('update public.vessels set %I = ''confirmed'' where id = $1', v_conf_col)
          using p.vessel_id;
      else
        execute format('update public.%I set %I = ''confirmed'' where id = $1', p.target_table, v_conf_col)
          using p.target_row_id;
      end if;
    end if;

  elsif p.action = 'add' then
    if p.target_table = 'vessel_names' then
      insert into public.vessel_names (vessel_id, name, normalised_name, date_text, confidence)
      values (p.vessel_id, p.payload->>'name',
              lower(trim(coalesce(p.payload->>'name',''))),
              nullif(p.payload->>'date_text',''), 'confirmed');

    elsif p.target_table = 'registrations' then
      insert into public.registrations (vessel_id, registration, date_text, confidence)
      values (p.vessel_id, p.payload->>'registration',
              nullif(p.payload->>'date_text',''), 'confirmed');

    elsif p.target_table = 'measurements' then
      insert into public.measurements (vessel_id, tonnage_text, length_m, notes)
      values (p.vessel_id,
              nullif(p.payload->>'tonnage_text',''),
              nullif(p.payload->>'length_m','')::numeric,
              nullif(p.payload->>'notes',''));

    elsif p.target_table = 'ownership_periods' then
      -- find-or-create the owner by normalised name, then attach the period
      insert into public.owners (name, normalised_name)
      values (p.payload->>'owner', lower(trim(coalesce(p.payload->>'owner',''))))
      on conflict (normalised_name) do update set name = excluded.name
      returning id into v_owner_id;

      insert into public.ownership_periods (vessel_id, owner_id, date_text, confidence)
      values (p.vessel_id, v_owner_id, nullif(p.payload->>'date_text',''), 'confirmed');
    end if;

  elsif p.action = 'remove' then
    execute format('delete from public.%I where id = $1', p.target_table)
      using p.target_row_id;
  end if;

  -- Audit trail — shows up in "Her story" / "How we know".
  insert into public.vessel_events (vessel_id, event_type, event_year, description, confidence)
  values (p.vessel_id, 'community_edit', extract(year from now())::int, p.summary, 'confirmed');
end;
$_$;


--
-- Name: memory_image_pins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_image_pins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    media_id uuid NOT NULL,
    author_id uuid NOT NULL,
    x numeric(5,4) NOT NULL,
    y numeric(5,4) NOT NULL,
    prompt text NOT NULL,
    resolved boolean DEFAULT false NOT NULL,
    resolved_answer text,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    accepted_suggestion_id uuid,
    CONSTRAINT memory_image_pins_x_check CHECK (((x >= (0)::numeric) AND (x <= (1)::numeric))),
    CONSTRAINT memory_image_pins_y_check CHECK (((y >= (0)::numeric) AND (y <= (1)::numeric)))
);


--
-- Name: accept_image_pin_suggestion(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accept_image_pin_suggestion(suggestion_id uuid) RETURNS public.memory_image_pins
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_pin_id      UUID;
  v_answer      TEXT;
  v_suggester   UUID;
  v_author      UUID;
  v_pin         public.memory_image_pins;
BEGIN
  -- Look up the suggestion + parent memory in one go.
  SELECT s.pin_id, s.answer, s.suggester_id, m.author_id
    INTO v_pin_id, v_answer, v_suggester, v_author
    FROM public.memory_image_pin_suggestions s
    JOIN public.memory_image_pins p ON p.id = s.pin_id
    JOIN public.memory_media mm     ON mm.id = p.media_id
    JOIN public.memories m          ON m.id  = mm.memory_id
   WHERE s.id = suggestion_id;

  IF v_pin_id IS NULL THEN
    RAISE EXCEPTION 'Suggestion not found';
  END IF;

  -- Only the memory author can accept.
  IF v_author <> auth.uid() AND NOT EXISTS (
    SELECT 1 FROM public.profiles pr WHERE pr.id = auth.uid() AND pr.role IN ('admin','moderator')
  ) THEN
    RAISE EXCEPTION 'Only the memory author can accept a suggestion';
  END IF;

  -- Flip the accepted flag and demote any sibling acceptances on the same pin.
  UPDATE public.memory_image_pin_suggestions
     SET is_accepted = (id = suggestion_id),
         accepted_at = CASE WHEN id = suggestion_id THEN NOW() ELSE NULL END
   WHERE pin_id = v_pin_id;

  -- Stamp the pin.
  UPDATE public.memory_image_pins
     SET resolved              = TRUE,
         resolved_answer       = v_answer,
         resolved_by           = v_suggester,
         resolved_at           = NOW(),
         accepted_suggestion_id = suggestion_id
   WHERE id = v_pin_id
   RETURNING * INTO v_pin;

  RETURN v_pin;
END;
$$;


--
-- Name: activate_hub_membership(uuid, uuid, uuid, text, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.activate_hub_membership(p_hub uuid, p_user uuid, p_type uuid, p_period text, p_payment_pence integer, p_pi text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_existing   public.hub_members%rowtype;
  v_base       timestamptz;
  v_paid_until timestamptz;
  v_member_no  text;
begin
  select * into v_existing from public.hub_members
    where hub_id = p_hub and user_id = p_user
    for update;

  -- Expiry date
  if p_period = 'once' then
    v_paid_until := null;                                  -- lifetime
  else
    v_base := greatest(now(), coalesce(v_existing.paid_until, now()));
    v_paid_until := case p_period
      when 'year'  then v_base + interval '1 year'
      when 'month' then v_base + interval '1 month'
      else null
    end;
  end if;

  -- Member number: keep existing, else next sequential numeric for this hub.
  if v_existing.member_no is not null then
    v_member_no := v_existing.member_no;
  else
    select (coalesce(max(member_no::int), 0) + 1)::text
      into v_member_no
      from public.hub_members
      where hub_id = p_hub and member_no ~ '^[0-9]+$';
  end if;

  -- Create the row if new (status set by the join trigger here), then force the
  -- final paid state in a follow-up UPDATE the trigger can't touch.
  insert into public.hub_members
    (hub_id, user_id, role, status, membership_type_id, paid_until, last_payment_pence, stripe_payment_intent_id, member_no)
  values
    (p_hub, p_user, 'member', 'active', p_type, v_paid_until, p_payment_pence, p_pi, v_member_no)
  on conflict (hub_id, user_id) do nothing;

  update public.hub_members set
    status                   = 'active',
    membership_type_id       = p_type,
    paid_until               = v_paid_until,
    last_payment_pence       = p_payment_pence,
    stripe_payment_intent_id = p_pi,
    member_no                = coalesce(member_no, v_member_no)
  where hub_id = p_hub and user_id = p_user;

  return jsonb_build_object('member_no', v_member_no, 'paid_until', v_paid_until);
end;
$_$;


--
-- Name: admin_config_touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_config_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;


--
-- Name: approve_business_claim(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.approve_business_claim(p_claim_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_is_admin boolean;
  v_claim    public.business_claims%rowtype;
begin
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
    into v_is_admin;
  if not v_is_admin then
    raise exception 'Only admins can approve claims';
  end if;

  select * into v_claim from public.business_claims where id = p_claim_id for update;
  if not found then raise exception 'Claim not found'; end if;
  if v_claim.status <> 'pending' then raise exception 'Claim already %', v_claim.status; end if;

  update public.business_claims
    set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid()
    where id = p_claim_id;

  update public.local_businesses
    set owner_id    = v_claim.user_id,
        is_claimed  = true,
        is_verified = true,
        claimed_at  = now(),
        verified_at = now()
    where id = v_claim.business_id;

  -- Reject any other pending claims on the same business.
  update public.business_claims
    set status = 'rejected', reviewed_at = now(), reviewed_by = auth.uid(),
        admin_note = coalesce(admin_note, '') || ' [auto-rejected: another claim approved]'
    where business_id = v_claim.business_id and status = 'pending' and id <> p_claim_id;
end;
$$;


--
-- Name: claim_gift(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_gift(p_code text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_gift      public.book_gifts%ROWTYPE;
  v_item      public.book_unit_items%ROWTYPE;
  v_purchase  public.book_unit_purchases%ROWTYPE;
  v_user_id   UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;

  SELECT * INTO v_gift FROM public.book_gifts WHERE code = p_code FOR UPDATE;

  IF NOT FOUND                                        THEN RAISE EXCEPTION 'gift_not_found';      END IF;
  IF v_gift.status = 'pending_payment'                THEN RAISE EXCEPTION 'gift_not_paid';       END IF;
  IF v_gift.status = 'cancelled'                      THEN RAISE EXCEPTION 'gift_cancelled';      END IF;
  IF v_gift.expires_at IS NOT NULL
       AND v_gift.expires_at < NOW()                  THEN RAISE EXCEPTION 'gift_expired';        END IF;
  IF v_gift.claimed_by_user_id IS NOT NULL
       AND v_gift.claimed_by_user_id <> v_user_id     THEN RAISE EXCEPTION 'gift_already_claimed';END IF;

  -- First-time claim → mark claimed
  IF v_gift.claimed_by_user_id IS NULL THEN
    UPDATE public.book_gifts
       SET claimed_at = NOW(),
           claimed_by_user_id = v_user_id,
           status = 'claimed'
     WHERE id = v_gift.id
    RETURNING * INTO v_gift;
  END IF;

  -- Unit gifts spawn a purchase immediately (idempotent)
  IF v_gift.kind = 'unit' THEN
    SELECT * INTO v_purchase
      FROM public.book_unit_purchases
     WHERE gift_id = v_gift.id;

    IF NOT FOUND THEN
      SELECT * INTO v_item FROM public.book_unit_items WHERE id = v_gift.unit_item_id;

      INSERT INTO public.book_unit_purchases (
        item_id, business_id, owner_id, paid_amount_pence,
        uses_remaining, gift_id, expires_at
      ) VALUES (
        v_item.id, v_item.business_id, v_user_id, v_gift.price_paid_pence,
        v_item.uses_per_purchase, v_gift.id,
        CASE WHEN v_item.valid_days IS NOT NULL
             THEN NOW() + (v_item.valid_days || ' days')::interval
        END
      )
      RETURNING * INTO v_purchase;

      UPDATE public.book_gifts
         SET used_at = NOW(), status = 'used'
       WHERE id = v_gift.id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'gift_id',          v_gift.id,
    'kind',             v_gift.kind,
    'business_id',      v_gift.business_id,
    'unit_item_id',     v_gift.unit_item_id,
    'service_id',       v_gift.service_id,
    'unit_purchase_id', v_purchase.id,
    'claimed_at',       v_gift.claimed_at,
    'used_at',          v_gift.used_at
  );
END;
$$;


--
-- Name: compliance_log_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compliance_log_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION
    'compliance_log records are immutable — they cannot be modified or deleted. '
    'This table is a legal audit trail. Record id: %', OLD.id;
END;
$$;


--
-- Name: cruise_barometer(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cruise_barometer(total_pax integer, ships integer) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select case
    when coalesce(ships,0) >= 3 or coalesce(total_pax,0) >= 5000 then 'peak'
    when coalesce(total_pax,0) >= 2500                            then 'very_busy'
    when coalesce(total_pax,0) >= 800                             then 'busy'
    else 'quiet'
  end
$$;


--
-- Name: cruise_touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cruise_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end $$;


--
-- Name: cruise_visit_derive(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cruise_visit_derive() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.arrival_at is not null then
    new.visit_date := (new.arrival_at at time zone 'Europe/London')::date;
    new.is_weekend := extract(isodow from new.visit_date) in (6,7);
  end if;
  new.is_tender := coalesce(new.berth_area_group = 'Anchor', new.is_tender);
  new.updated_at := now();
  return new;
end $$;


--
-- Name: fetch_memory_pins(numeric, numeric, numeric, numeric, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fetch_memory_pins(min_lat numeric, max_lat numeric, min_lng numeric, max_lng numeric, result_limit integer DEFAULT 500) RETURNS TABLE(id uuid, lat numeric, lng numeric, place_name text, title text, era text, tags text[], media_count integer, comment_count integer, reaction_count integer, child_count integer, hero_url text, hero_kind text, created_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT
    m.id, m.lat, m.lng, m.place_name, m.title, m.era, m.tags,
    m.media_count, m.comment_count, m.reaction_count, m.child_count,
    (SELECT mm.url
       FROM public.memory_media mm
       WHERE mm.memory_id = m.id
       ORDER BY (mm.kind = 'photo') DESC, mm.display_order
       LIMIT 1)  AS hero_url,
    (SELECT mm.kind
       FROM public.memory_media mm
       WHERE mm.memory_id = m.id
       ORDER BY (mm.kind = 'photo') DESC, mm.display_order
       LIMIT 1)  AS hero_kind,
    m.created_at
  FROM public.memories m
  WHERE m.parent_id IS NULL
    AND NOT m.is_hidden
    AND m.lat BETWEEN min_lat AND max_lat
    AND m.lng BETWEEN min_lng AND max_lng
    AND (
      m.visibility = 'public'
      OR (m.visibility = 'community' AND auth.uid() IS NOT NULL)
      OR m.author_id = auth.uid()
    )
  ORDER BY m.created_at DESC
  LIMIT result_limit;
$$;


--
-- Name: generate_business_slug(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_business_slug(p_name text, p_id uuid DEFAULT NULL::uuid) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  base_slug text;
  candidate text;
  suffix    int := 0;
BEGIN
  base_slug := lower(
    regexp_replace(
      regexp_replace(trim(p_name), '[^a-zA-Z0-9\s]', '', 'g'),
      '\s+', '-', 'g'
    )
  );
  base_slug := left(base_slug, 60);
  candidate := base_slug;
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM local_businesses
      WHERE slug = candidate AND (p_id IS NULL OR id != p_id)
    ) THEN
      RETURN candidate;
    END IF;
    suffix    := suffix + 1;
    candidate := base_slug || '-' || suffix;
  END LOOP;
END;
$$;


--
-- Name: generate_gift_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_gift_code() RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  alphabet  CONSTANT TEXT := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  candidate TEXT;
  i         INT;
BEGIN
  LOOP
    candidate := '';
    FOR i IN 1..8 LOOP
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.book_gifts WHERE code = candidate);
  END LOOP;
  RETURN candidate;
END;
$$;


--
-- Name: generate_nfc_token(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_nfc_token(business_name text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_slug TEXT;
  v_token TEXT;
  v_exists INT;
  v_attempts INT := 0;
BEGIN
  -- 2-3 char slug from business name
  v_slug := lower(regexp_replace(substring(business_name, 1, 2), '[^a-z0-9]', '', 'gi'));
  IF length(v_slug) < 2 THEN v_slug := 'lo'; END IF;

  LOOP
    v_token := v_slug || '-' || lower(substring(md5(random()::text || clock_timestamp()::text), 1, 8));
    SELECT count(*) INTO v_exists FROM public.local_businesses WHERE nfc_token = v_token;
    EXIT WHEN v_exists = 0;
    v_attempts := v_attempts + 1;
    IF v_attempts > 5 THEN
      v_token := v_slug || '-' || lower(substring(md5(random()::text || gen_random_uuid()::text), 1, 10));
      EXIT;
    END IF;
  END LOOP;

  RETURN v_token;
END $$;


--
-- Name: generate_ticket_backup_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_ticket_backup_code() RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code     text;
  part1    text := '';
  part2    text := '';
  i        int;
BEGIN
  LOOP
    part1 := ''; part2 := '';
    FOR i IN 1..4 LOOP
      part1 := part1 || substr(alphabet, floor(random() * 32 + 1)::int, 1);
    END LOOP;
    FOR i IN 1..4 LOOP
      part2 := part2 || substr(alphabet, floor(random() * 32 + 1)::int, 1);
    END LOOP;
    code := part1 || '-' || part2;
    IF NOT EXISTS (SELECT 1 FROM public.event_tickets WHERE backup_code = code) THEN
      RETURN code;
    END IF;
  END LOOP;
END;
$$;


--
-- Name: get_business_wallet_receipts(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_business_wallet_receipts(p_business_id uuid, p_limit integer DEFAULT 20) RETURNS TABLE(id uuid, created_at timestamp with time zone, gross_pence integer, fee_pence integer, cashback_pence integer, net_pence integer, customer_first_name text, stripe_transfer_id text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
#variable_conflict use_column
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'auth_required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.local_businesses
     WHERE id = p_business_id AND owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'not_business_owner';
  END IF;

  RETURN QUERY
    SELECT
      t.id,
      t.created_at,
      ABS(t.amount_pence)                                       AS gross_pence,
      t.platform_fee_pence                                      AS fee_pence,
      t.cashback_pence                                          AS cashback_pence,
      CASE WHEN t.platform_fee_pence IS NULL
           THEN NULL
           ELSE ABS(t.amount_pence) - t.platform_fee_pence - COALESCE(t.cashback_pence, 0)
      END                                                       AS net_pence,
      NULLIF(split_part(COALESCE(p.full_name, ''), ' ', 1), '') AS customer_first_name,
      t.stripe_transfer_id
    FROM public.local_wallet_transactions t
    LEFT JOIN public.profiles p ON p.id = t.user_id
    WHERE t.business_id = p_business_id
      AND t.type        = 'spend'
    ORDER BY t.created_at DESC
    LIMIT GREATEST(1, LEAST(p_limit, 100));
END;
$$;


--
-- Name: get_campaign_donors(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_campaign_donors(p_campaign uuid) RETURNS TABLE(name text, amount_pence integer, message text, gift_aid boolean, is_anonymous boolean, created_at timestamp with time zone)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select case when d.is_anonymous then 'Anonymous'
              else coalesce(p.display_name, p.full_name, 'Supporter') end,
         d.amount_pence,
         d.message,
         d.gift_aid,
         d.is_anonymous,
         d.created_at
  from public.hub_donations d
  left join public.profiles p on p.id = d.donor_user_id
  where d.campaign_id = p_campaign
  order by d.created_at desc
  limit 50;
$$;


--
-- Name: get_customer_info_for_request(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_customer_info_for_request(request_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v jsonb;
begin
  select jsonb_build_object(
           'first_name', nullif(split_part(coalesce(p.full_name, ''), ' ', 1), ''),
           'full_name',  p.full_name
         )
    into v
    from public.delivery_requests dr
    join public.profiles p on p.id = dr.customer_id
    left join public.runs r on r.id = dr.run_id
   where dr.id = request_id
     and (
       r.driver_id = auth.uid()
       or exists (select 1 from public.profiles me where me.id = auth.uid() and me.role = 'admin')
     );
  return v;  -- null if the caller isn't the assigned driver / admin
end;
$$;


--
-- Name: get_driver_info_for_request(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_driver_info_for_request(request_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v jsonb;
begin
  select jsonb_build_object(
           'full_name',       p.full_name,
           'vehicle_type',    dp.vehicle_type,
           'departure_start', r.departure_start,
           'departure_end',   r.departure_end,
           'ferry_crossing',  r.ferry_crossing
         )
    into v
    from public.delivery_requests dr
    join public.runs r            on r.id = dr.run_id
    join public.profiles p        on p.id = r.driver_id
    left join public.driver_profiles dp on dp.id = r.driver_id
   where dr.id = request_id
     and (
       dr.customer_id = auth.uid()
       or exists (select 1 from public.profiles me where me.id = auth.uid() and me.role = 'admin')
     );
  return v;
end;
$$;


--
-- Name: get_event_scanner_stats(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_event_scanner_stats(p_event_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT jsonb_build_object(
    'tickets_sold',     COALESCE((SELECT COUNT(*) FROM event_tickets WHERE event_id = p_event_id AND status IN ('valid','used')), 0),
    'checked_in',       COALESCE((SELECT COUNT(*) FROM event_tickets WHERE event_id = p_event_id AND status = 'used'), 0),
    'pending_payment',  COALESCE((SELECT COUNT(*) FROM event_tickets WHERE event_id = p_event_id AND status = 'pending_payment'), 0)
  );
$$;


--
-- Name: get_hub_directory(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_hub_directory(p_hub uuid) RETURNS TABLE(user_id uuid, name text, role text, tier text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not (public.is_hub_member(p_hub, auth.uid()) or public.is_hub_admin(p_hub, auth.uid())) then
    raise exception 'Members only';
  end if;
  if not exists (
    select 1 from public.hubs
    where id = p_hub and (directory_enabled or public.is_hub_admin(p_hub, auth.uid()))
  ) then
    raise exception 'Directory not enabled';
  end if;

  return query
    select m.user_id,
           coalesce(p.display_name, p.full_name, 'Member') as name,
           m.role,
           coalesce(t.name, '') as tier
    from public.hub_members m
    join public.profiles p on p.id = m.user_id
    left join public.hub_membership_types t on t.id = m.membership_type_id
    where m.hub_id = p_hub
      and m.status = 'active'
      and (m.paid_until is null or m.paid_until > now())
    order by m.role, name;
end;
$$;


--
-- Name: get_my_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_role() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid()
$$;


--
-- Name: get_public_booking_load(uuid, timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_public_booking_load(p_business_id uuid, p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE(id uuid, service_id uuid, starts_at timestamp with time zone, ends_at timestamp with time zone, status text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT b.id, b.service_id, b.starts_at, b.ends_at, b.status
  FROM public.book_bookings b
  WHERE b.business_id = p_business_id
    AND b.status IN ('confirmed', 'pending_payment')
    AND (p_from IS NULL OR b.ends_at   >  p_from)
    AND (p_to   IS NULL OR b.starts_at <  p_to);
$$;


--
-- Name: get_spik_stats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_spik_stats() RETURNS json
    LANGUAGE sql SECURITY DEFINER
    AS $$
  select json_build_object(
    'total', (select count(*) from spik_dictionary),
    'origins', (
      select json_agg(json_build_object('origin', origin_label, 'count', cnt) order by cnt desc)
      from (
        select coalesce(nullif(trim(origin), ''), 'Unknown') as origin_label, count(*) as cnt
        from spik_dictionary
        group by 1
      ) s
    ),
    'usage', (
      select json_agg(json_build_object('level', level_label, 'count', cnt) order by cnt desc)
      from (
        select coalesce(nullif(trim(usage_level), ''), 'Unknown') as level_label, count(*) as cnt
        from spik_dictionary
        group by 1
      ) s
    )
  );
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  INSERT INTO public.profiles (id, role, full_name)
  VALUES (
    NEW.id,
    'customer',
    COALESCE(NEW.raw_user_meta_data->>'full_name', '')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;


--
-- Name: hub_membership_active(text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hub_membership_active(p_status text, p_paid_until timestamp with time zone) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
  select p_status = 'active' and (p_paid_until is null or p_paid_until > now());
$$;


--
-- Name: increment_event_tickets_sold(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_event_tickets_sold(p_event_id uuid, p_count integer) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update public.events set tickets_sold = coalesce(tickets_sold, 0) + p_count where id = p_event_id;
$$;


--
-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;


--
-- Name: is_hub_admin(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_hub_admin(p_hub uuid, p_user uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1 from public.hub_members
    where hub_id = p_hub and user_id = p_user and status = 'active'
      and role in ('owner','committee')
  );
$$;


--
-- Name: is_hub_member(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_hub_member(p_hub uuid, p_user uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1 from public.hub_members
    where hub_id = p_hub and user_id = p_user and status = 'active'
      and (paid_until is null or paid_until > now())
  );
$$;


--
-- Name: purge_old_job_applications(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_old_job_applications() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE v_deleted int;
BEGIN
  WITH gone AS (
    DELETE FROM public.job_applications
    WHERE status IN ('declined','withdrawn') AND status_changed_at < now() - interval '6 months'
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM gone;
  RETURN v_deleted;
END; $$;


--
-- Name: recompute_cruise_day(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recompute_cruise_day(target date) RETURNS void
    LANGUAGE plpgsql
    AS $$
declare n int;
begin
  select count(*) into n from public.cruise_visits
    where visit_date = target and status <> 'cancelled';
  update public.cruise_visits
    set ships_same_day = n, is_multi_ship_day = (n > 1)
    where visit_date = target;
end $$;


--
-- Name: record_hub_donation(uuid, uuid, uuid, integer, integer, text, boolean, text, boolean, text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_hub_donation(p_campaign uuid, p_hub uuid, p_user uuid, p_amount integer, p_fee integer, p_message text, p_anon boolean, p_pi text, p_gift_aid boolean, p_title text, p_first text, p_last text, p_address text, p_postcode text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into public.hub_donations (
    campaign_id, hub_id, donor_user_id, amount_pence, fee_pence, message, is_anonymous,
    stripe_payment_intent_id, gift_aid, ga_title, ga_first_name, ga_last_name, ga_address, ga_postcode
  ) values (
    p_campaign, p_hub, p_user, p_amount, p_fee, p_message, coalesce(p_anon, false),
    p_pi, coalesce(p_gift_aid, false), p_title, p_first, p_last, p_address, p_postcode
  )
  on conflict (stripe_payment_intent_id) do nothing;

  if found then
    update public.hub_campaigns
       set raised_pence = raised_pence + p_amount,
           donor_count  = donor_count + 1
     where id = p_campaign;
  end if;
end;
$$;


--
-- Name: reserve_ticket_slots(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_ticket_slots(p_type_id uuid, p_quantity integer) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
DECLARE
  available int;
  sold      int;
BEGIN
  SELECT quantity_available, quantity_sold
    INTO available, sold
    FROM public.event_ticket_types
    WHERE id = p_type_id
    FOR UPDATE;

  IF NOT FOUND THEN RETURN false; END IF;

  -- null = unlimited
  IF available IS NOT NULL AND (available - sold) < p_quantity THEN
    RETURN false;
  END IF;

  UPDATE public.event_ticket_types
  SET quantity_sold = quantity_sold + p_quantity
  WHERE id = p_type_id;

  RETURN true;
END;
$$;


--
-- Name: search_memories(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_memories(q text, result_limit integer DEFAULT 50) RETURNS TABLE(id uuid, lat numeric, lng numeric, place_name text, title text, body_excerpt text, era text, tags text[], matched_via text, hero_url text, hero_kind text, created_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  WITH q_norm AS (
    SELECT lower(trim(q)) AS qq
  ),
  candidates AS (
    SELECT
      m.*,
      CASE
        WHEN m.title      ILIKE '%' || (SELECT qq FROM q_norm) || '%' THEN 'title'
        WHEN m.body       ILIKE '%' || (SELECT qq FROM q_norm) || '%' THEN 'body'
        WHEN m.era        ILIKE '%' || (SELECT qq FROM q_norm) || '%' THEN 'era'
        WHEN (SELECT qq FROM q_norm) = ANY(m.tags)                    THEN 'tag'
        ELSE                                                                'photo_tag'
      END AS matched_via
    FROM public.memories m
    WHERE NOT m.is_hidden
      AND m.parent_id IS NULL
      AND (
        m.title      ILIKE '%' || (SELECT qq FROM q_norm) || '%'
        OR m.body    ILIKE '%' || (SELECT qq FROM q_norm) || '%'
        OR m.era     ILIKE '%' || (SELECT qq FROM q_norm) || '%'
        OR (SELECT qq FROM q_norm) = ANY(m.tags)
        OR EXISTS (
          SELECT 1
          FROM public.memory_media mm
          JOIN public.memory_image_pins p ON p.media_id = mm.id
          WHERE mm.memory_id = m.id
            AND p.resolved
            AND p.resolved_answer ILIKE '%' || (SELECT qq FROM q_norm) || '%'
        )
      )
      AND (
        m.visibility = 'public'
        OR (m.visibility = 'community' AND auth.uid() IS NOT NULL)
        OR m.author_id = auth.uid()
      )
  )
  SELECT
    c.id, c.lat, c.lng, c.place_name, c.title,
    LEFT(COALESCE(c.body, ''), 220) AS body_excerpt,
    c.era, c.tags, c.matched_via,
    (SELECT mm.url
       FROM public.memory_media mm
       WHERE mm.memory_id = c.id
       ORDER BY (mm.kind = 'photo') DESC, mm.display_order
       LIMIT 1)  AS hero_url,
    (SELECT mm.kind
       FROM public.memory_media mm
       WHERE mm.memory_id = c.id
       ORDER BY (mm.kind = 'photo') DESC, mm.display_order
       LIMIT 1)  AS hero_kind,
    c.created_at
  FROM candidates c
  ORDER BY c.created_at DESC
  LIMIT result_limit;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: should_notify(uuid, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.should_notify(p_user_id uuid, p_module text, p_urgent boolean DEFAULT false) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  prefs RECORD;
  now_local TIME;
BEGIN
  -- If user has no preferences row, treat as opted-in (defaults apply)
  SELECT * INTO prefs
    FROM public.notification_preferences
   WHERE user_id = p_user_id;

  IF NOT FOUND THEN RETURN TRUE; END IF;

  -- Master kill-switch
  IF NOT prefs.enabled THEN RETURN FALSE; END IF;

  -- Per-module
  CASE p_module
    WHEN 'bookings' THEN IF NOT prefs.bookings_enabled THEN RETURN FALSE; END IF;
    WHEN 'shifts'   THEN IF NOT prefs.shifts_enabled   THEN RETURN FALSE; END IF;
    WHEN 'fetch'    THEN IF NOT prefs.fetch_enabled    THEN RETURN FALSE; END IF;
    WHEN 'loyalty'  THEN IF NOT prefs.loyalty_enabled  THEN RETURN FALSE; END IF;
    WHEN 'offers'   THEN IF NOT prefs.offers_enabled   THEN RETURN FALSE; END IF;
    WHEN 'spik'     THEN IF NOT prefs.spik_enabled     THEN RETURN FALSE; END IF;
    WHEN 'games'    THEN IF NOT prefs.games_enabled    THEN RETURN FALSE; END IF;
    ELSE RETURN TRUE; -- unknown module, default allow
  END CASE;

  -- Urgent sends bypass quiet hours
  IF p_urgent THEN RETURN TRUE; END IF;

  -- Quiet hours check. Window wraps across midnight if start > end.
  IF prefs.quiet_hours_start IS NOT NULL AND prefs.quiet_hours_end IS NOT NULL THEN
    now_local := (NOW() AT TIME ZONE 'Europe/London')::TIME;
    IF prefs.quiet_hours_start <= prefs.quiet_hours_end THEN
      IF now_local >= prefs.quiet_hours_start AND now_local < prefs.quiet_hours_end THEN
        RETURN FALSE;
      END IF;
    ELSE
      -- wraps midnight: e.g. 22:00 → 07:00
      IF now_local >= prefs.quiet_hours_start OR now_local < prefs.quiet_hours_end THEN
        RETURN FALSE;
      END IF;
    END IF;
  END IF;

  RETURN TRUE;
END;
$$;


--
-- Name: spik_normalise_origin_usage(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.spik_normalise_origin_usage() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.origin IS NOT NULL THEN
    NEW.origin := LOWER(TRIM(NEW.origin));
  END IF;
  IF NEW.usage_level IS NOT NULL THEN
    NEW.usage_level := LOWER(TRIM(NEW.usage_level));
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: tg_application_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_application_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF tg_op = 'INSERT' THEN
    INSERT INTO public.application_events (application_id, from_status, to_status, actor_id)
    VALUES (new.id, null, new.status, new.applicant_id);
  ELSIF tg_op = 'UPDATE' AND new.status IS DISTINCT FROM old.status THEN
    INSERT INTO public.application_events (application_id, from_status, to_status, actor_id)
    VALUES (new.id, old.status, new.status, auth.uid());
  END IF;
  RETURN null;
END; $$;


--
-- Name: tg_decrement_unit_stock(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_decrement_unit_stock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE public.book_unit_items
     SET stock = stock - 1
   WHERE id = NEW.item_id
     AND stock IS NOT NULL;
  RETURN NEW;
END;
$$;


--
-- Name: tg_events_sync_hidden(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_events_sync_hidden() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_verified boolean := false;
begin
  new.is_hidden  := (new.status <> 'published');
  new.updated_at := now();

  if new.organiser_hub_id is not null and new.hub_visibility = 'islands' then
    select is_verified into v_verified from public.hubs where id = new.organiser_hub_id;
    if coalesce(v_verified, false) then
      new.calendar_approved := true;
    else
      -- Ignore any client attempt to self-stamp the approver; only a platform
      -- admin/moderator may change it.
      if new.calendar_approved_by is distinct from old.calendar_approved_by
         and not exists (
           select 1 from public.profiles
           where id = auth.uid() and role in ('admin','moderator')
         )
      then
        new.calendar_approved_by := old.calendar_approved_by;
      end if;
      new.calendar_approved := (new.calendar_approved_by is not null);
    end if;
  else
    -- members / hub tiers (and non-hub events) never appear on the calendar via
    -- this flag; non-hub events are gated by is_hidden alone.
    new.calendar_approved := false;
  end if;

  if new.calendar_approved and (tg_op = 'INSERT' or not coalesce(old.calendar_approved, false)) then
    new.calendar_approved_at := now();
  end if;

  return new;
end;
$$;


--
-- Name: tg_hub_member_join_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_hub_member_join_status() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_mode text;
begin
  if new.role = 'member' then
    select join_mode into v_mode from public.hubs where id = new.hub_id;
    new.status := case when v_mode = 'open' then 'active' else 'pending' end;
  end if;
  return new;
end;
$$;


--
-- Name: tg_hub_members_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_hub_members_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_is_owner    boolean;
  v_is_admin    boolean;
  v_is_platform boolean;
begin
  -- Service role / server context: no user JWT → trust it.
  if auth.uid() is null then
    return new;
  end if;

  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
    into v_is_platform;
  if v_is_platform then
    return new;
  end if;

  select coalesce(bool_or(h.owner_id = auth.uid()), false) into v_is_owner
    from public.hubs h where h.id = new.hub_id;
  v_is_admin := public.is_hub_admin(new.hub_id, auth.uid());

  -- Role changes are owner-only.
  if new.role is distinct from old.role and not v_is_owner then
    new.role := old.role;
  end if;

  -- Only hub admins can activate a membership (approve). Members can leave.
  if new.status is distinct from old.status
     and new.status = 'active' and not v_is_admin then
    new.status := old.status;
  end if;

  return new;
end;
$$;


--
-- Name: tg_hub_owner_membership(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_hub_owner_membership() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into public.hub_members (hub_id, user_id, role, status)
  values (new.id, new.owner_id, 'owner', 'active')
  on conflict (hub_id, user_id) do nothing;
  return new;
end;
$$;


--
-- Name: tg_job_application_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_job_application_count() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF tg_op = 'INSERT' THEN
    UPDATE public.jobs SET application_count = application_count + 1 WHERE id = new.job_id;
  ELSIF tg_op = 'DELETE' THEN
    UPDATE public.jobs SET application_count = greatest(application_count - 1, 0) WHERE id = old.job_id;
  END IF;
  RETURN null;
END; $$;


--
-- Name: tg_job_application_touch(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_job_application_touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  new.updated_at := now();
  IF tg_op = 'UPDATE' AND new.status IS DISTINCT FROM old.status THEN new.status_changed_at := now(); END IF;
  RETURN new;
END; $$;


--
-- Name: tg_jobs_touch(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_jobs_touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN new.updated_at := now(); RETURN new; END; $$;


--
-- Name: tg_memory_child_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_memory_child_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.parent_id IS NOT NULL THEN
    UPDATE public.memories SET child_count = child_count + 1, updated_at = NOW()
      WHERE id = NEW.parent_id;
  ELSIF TG_OP = 'DELETE' AND OLD.parent_id IS NOT NULL THEN
    UPDATE public.memories SET child_count = GREATEST(child_count - 1, 0)
      WHERE id = OLD.parent_id;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: tg_memory_comment_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_memory_comment_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.memories SET comment_count = comment_count + 1, updated_at = NOW()
      WHERE id = NEW.memory_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.memories SET comment_count = GREATEST(comment_count - 1, 0)
      WHERE id = OLD.memory_id;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: tg_memory_media_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_memory_media_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.memories SET media_count = media_count + 1, updated_at = NOW()
      WHERE id = NEW.memory_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.memories SET media_count = GREATEST(media_count - 1, 0), updated_at = NOW()
      WHERE id = OLD.memory_id;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: tg_memory_reaction_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_memory_reaction_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.memories SET reaction_count = reaction_count + 1 WHERE id = NEW.memory_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.memories SET reaction_count = GREATEST(reaction_count - 1, 0) WHERE id = OLD.memory_id;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: tg_profiles_lock_sensitive(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_profiles_lock_sensitive() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  -- Only constrain a user editing their OWN row via a user JWT.
  -- auth.uid() is NULL for service-role / server contexts → unaffected.
  if auth.uid() is not null and auth.uid() = old.id then
    new.role               := old.role;               -- ← the critical one
    new.email_verified     := old.email_verified;
    new.is_active          := old.is_active;
    new.has_payment_method := old.has_payment_method;
    new.stripe_customer_id := old.stripe_customer_id;
    new.stripe_account_id  := old.stripe_account_id;
  end if;
  return new;
end;
$$;


--
-- Name: FUNCTION tg_profiles_lock_sensitive(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.tg_profiles_lock_sensitive() IS 'Prevents self-service privilege escalation: locks role and other server-managed columns on user-initiated profile updates. Service role bypasses (auth.uid() is null).';


--
-- Name: tg_seed_business_addons(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_seed_business_addons() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  INSERT INTO business_addons (business_id, addon_key, enabled) VALUES
    -- Standard add-ons: on by default for every plan
    (NEW.id, 'offers',     true),
    (NEW.id, 'stamps',     true),
    (NEW.id, 'enquiries',  true),
    (NEW.id, 'payments',   true),
    (NEW.id, 'featured',   true),
    -- Premium add-ons: off until Premium plan + owner enables
    (NEW.id, 'bookings',   false),
    (NEW.id, 'services',   false),
    (NEW.id, 'events',     false),
    (NEW.id, 'membership', false),
    (NEW.id, 'products',   false)
  ON CONFLICT (business_id, addon_key) DO NOTHING;
  RETURN NEW;
END;
$$;


--
-- Name: tg_set_business_slug(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_set_business_slug() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    NEW.slug := generate_business_slug(NEW.name, NEW.id);
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: tg_spik_sync_computed_fields(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_spik_sync_computed_fields() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.word IS NOT NULL THEN
    NEW.number_letters := LENGTH(TRIM(NEW.word));
    NEW.stripped_word  := LOWER(REGEXP_REPLACE(TRIM(NEW.word), '[^a-zA-Z]', '', 'g'));
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: tg_validate_vessel_edit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_validate_vessel_edit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.action = 'edit' then
    if new.target_column is null then
      raise exception 'edit requires a target_column';
    end if;
    if public.vessel_edit_col_cast(new.target_table, new.target_column) is null then
      raise exception 'column % is not editable on %', new.target_column, new.target_table;
    end if;
    if new.target_table <> 'vessels' and new.target_row_id is null then
      raise exception 'edit on % requires a target_row_id', new.target_table;
    end if;
  elsif new.action = 'add' then
    if new.target_table not in ('vessel_names','registrations','ownership_periods','measurements') then
      raise exception 'cannot add a row to %', new.target_table;
    end if;
  elsif new.action = 'remove' then
    if new.target_table not in ('vessel_names','registrations','ownership_periods','measurements') then
      raise exception 'cannot remove a row from %', new.target_table;
    end if;
    if new.target_row_id is null then
      raise exception 'remove requires a target_row_id';
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: tg_vessel_comment_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_vessel_comment_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NOT NEW.is_hidden THEN
    UPDATE public.vessels SET comment_count = comment_count + 1
      WHERE id = NEW.vessel_id;
  ELSIF TG_OP = 'DELETE' AND NOT OLD.is_hidden THEN
    UPDATE public.vessels SET comment_count = GREATEST(comment_count - 1, 0)
      WHERE id = OLD.vessel_id;
  ELSIF TG_OP = 'UPDATE' AND OLD.is_hidden IS DISTINCT FROM NEW.is_hidden THEN
    UPDATE public.vessels
       SET comment_count = comment_count
                          + CASE WHEN NEW.is_hidden THEN -1 ELSE 1 END
     WHERE id = NEW.vessel_id;
  END IF;
  RETURN NULL;
END;
$$;


--
-- Name: tg_worker_profile_touch(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.tg_worker_profile_touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN new.updated_at := now(); RETURN new; END; $$;


--
-- Name: validate_and_checkin_ticket(text, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_and_checkin_ticket(p_raw_token text, p_event_id uuid, p_scanner_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  token_hash  text;
  ticket      record;
  event_biz   uuid;
  owns_event  boolean;
BEGIN
  -- Hash the raw token to find the DB record.
  token_hash := encode(sha256(p_raw_token::bytea), 'hex');

  SELECT t.* INTO ticket
    FROM public.event_tickets t
    WHERE t.validation_token_hash = token_hash;

  IF NOT FOUND THEN
    -- Log the failed scan attempt (ticket_id stays NULL for not_found).
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (gen_random_uuid(), p_event_id, p_scanner_id, 'not_found');
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  -- Verify scanner owns the event.
  SELECT lb.owner_id = p_scanner_id INTO owns_event
    FROM public.events e
    JOIN public.local_businesses lb ON lb.id = e.organiser_business_id
    WHERE e.id = ticket.event_id;

  IF NOT owns_event THEN
    -- Also check admin role.
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_scanner_id AND role = 'admin') THEN
      RETURN jsonb_build_object('result', 'wrong_event', 'message', 'This ticket does not belong to your event.');
    END IF;
  END IF;

  -- Check event match.
  IF ticket.event_id <> p_event_id THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (ticket.id, p_event_id, p_scanner_id, 'wrong_event');
    RETURN jsonb_build_object('result', 'wrong_event');
  END IF;

  -- Check status.
  IF ticket.status = 'pending_payment' THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (ticket.id, p_event_id, p_scanner_id, 'payment_incomplete');
    RETURN jsonb_build_object('result', 'payment_incomplete');
  END IF;

  IF ticket.status = 'used' THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (ticket.id, p_event_id, p_scanner_id, 'already_used');
    RETURN jsonb_build_object(
      'result',        'already_used',
      'checked_in_at', ticket.checked_in_at,
      'attendee_name', ticket.attendee_name
    );
  END IF;

  IF ticket.status IN ('cancelled','refunded') THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (ticket.id, p_event_id, p_scanner_id, ticket.status::text);
    RETURN jsonb_build_object('result', ticket.status);
  END IF;

  -- All clear — mark as used and log the successful check-in.
  UPDATE public.event_tickets
  SET status = 'used', checked_in_at = now(), checked_in_by = p_scanner_id
  WHERE id = ticket.id;

  INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
  VALUES (ticket.id, p_event_id, p_scanner_id, 'valid');

  RETURN jsonb_build_object(
    'result',          'valid',
    'ticket_id',       ticket.id,
    'attendee_name',   ticket.attendee_name,
    'ticket_type_id',  ticket.ticket_type_id,
    'price_pence',     ticket.price_pence,
    'event_snapshot',  ticket.event_snapshot
  );
END;
$$;


--
-- Name: validate_and_checkin_ticket_by_id(uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_and_checkin_ticket_by_id(p_ticket_id uuid, p_event_id uuid, p_scanner_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  ticket     record;
  owns_event boolean;
BEGIN
  SELECT * INTO ticket FROM public.event_tickets WHERE id = p_ticket_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  SELECT lb.owner_id = p_scanner_id INTO owns_event
    FROM public.events e
    JOIN public.local_businesses lb ON lb.id = e.organiser_business_id
    WHERE e.id = ticket.event_id;

  IF NOT owns_event AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_scanner_id AND role = 'admin') THEN
    RETURN jsonb_build_object('result', 'wrong_event', 'message', 'This ticket does not belong to your event.');
  END IF;

  IF ticket.event_id <> p_event_id THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result) VALUES(ticket.id, p_event_id, p_scanner_id, 'wrong_event');
    RETURN jsonb_build_object('result', 'wrong_event');
  END IF;

  IF ticket.status = 'pending_payment' THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result) VALUES(ticket.id, p_event_id, p_scanner_id, 'payment_incomplete');
    RETURN jsonb_build_object('result', 'payment_incomplete');
  END IF;

  IF ticket.status = 'used' THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result) VALUES(ticket.id, p_event_id, p_scanner_id, 'already_used');
    RETURN jsonb_build_object('result', 'already_used', 'checked_in_at', ticket.checked_in_at, 'attendee_name', ticket.attendee_name);
  END IF;

  IF ticket.status IN ('cancelled','refunded') THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result) VALUES(ticket.id, p_event_id, p_scanner_id, ticket.status::text);
    RETURN jsonb_build_object('result', ticket.status);
  END IF;

  UPDATE public.event_tickets SET status = 'used', checked_in_at = now(), checked_in_by = p_scanner_id WHERE id = ticket.id;
  INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result) VALUES(ticket.id, p_event_id, p_scanner_id, 'valid');

  RETURN jsonb_build_object(
    'result', 'valid', 'ticket_id', ticket.id,
    'attendee_name', ticket.attendee_name, 'ticket_type_id', ticket.ticket_type_id,
    'price_pence', ticket.price_pence, 'event_snapshot', ticket.event_snapshot
  );
END;
$$;


--
-- Name: validate_backup_code(text, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_backup_code(p_backup_code text, p_event_id uuid, p_scanner_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  raw_token text;
BEGIN
  SELECT t.id::text INTO raw_token
    FROM public.event_tickets t
    WHERE upper(trim(t.backup_code)) = upper(trim(p_backup_code));

  IF NOT FOUND THEN
    INSERT INTO public.event_checkins(ticket_id, event_id, scanner_id, result)
    VALUES (gen_random_uuid(), p_event_id, p_scanner_id, 'not_found');
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  -- Re-use the main validation path (passes ticket ID as the fake token — handled below).
  RETURN validate_and_checkin_ticket_by_id(raw_token::uuid, p_event_id, p_scanner_id);
END;
$$;


--
-- Name: vessel_edit_col_cast(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vessel_edit_col_cast(p_table text, p_column text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select case
    when p_table='vessels'           and p_column='canonical_name'    then 'text'
    when p_table='vessels'           and p_column='primary_lk_number' then 'text'
    when p_table='vessels'           and p_column='built_year'        then 'int'
    when p_table='vessels'           and p_column='builder'           then 'text'
    when p_table='vessels'           and p_column='hull_material'     then 'text'
    when p_table='vessels'           and p_column='status'            then 'text'
    when p_table='vessel_names'      and p_column='name'              then 'text'
    when p_table='vessel_names'      and p_column='date_text'         then 'text'
    when p_table='vessel_names'      and p_column='start_year'        then 'int'
    when p_table='vessel_names'      and p_column='end_year'          then 'int'
    when p_table='registrations'     and p_column='registration'      then 'text'
    when p_table='registrations'     and p_column='date_text'         then 'text'
    when p_table='registrations'     and p_column='start_year'        then 'int'
    when p_table='registrations'     and p_column='end_year'          then 'int'
    when p_table='ownership_periods' and p_column='date_text'         then 'text'
    when p_table='ownership_periods' and p_column='start_year'        then 'int'
    when p_table='ownership_periods' and p_column='end_year'          then 'int'
    when p_table='ownership_periods' and p_column='notes'             then 'text'
    when p_table='owners'            and p_column='name'              then 'text'
    when p_table='owners'            and p_column='notes'             then 'text'
    when p_table='measurements'      and p_column='length_m'          then 'numeric'
    when p_table='measurements'      and p_column='tonnage'           then 'numeric'
    when p_table='measurements'      and p_column='tonnage_text'      then 'text'
    when p_table='measurements'      and p_column='engine_power_kw'   then 'numeric'
    when p_table='measurements'      and p_column='measurement_year'  then 'int'
    when p_table='measurements'      and p_column='notes'             then 'text'
    else null
  end;
$$;


--
-- Name: vessel_edit_conf_col(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vessel_edit_conf_col(p_table text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select case p_table
    when 'vessels'           then 'identity_confidence'
    when 'vessel_names'      then 'confidence'
    when 'registrations'     then 'confidence'
    when 'ownership_periods' then 'confidence'
    else null
  end;
$$;


--
-- Name: vote_vessel_edit(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.vote_vessel_edit(p_proposal uuid, p_vote text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_uid     uuid := auth.uid();
  v_p       public.vessel_edit_proposals%rowtype;
  v_confirm int;
  v_dispute int;
  v_applied boolean := false;
  v_status  text;
begin
  if v_uid is null then raise exception 'You must be signed in to vote.'; end if;
  if p_vote not in ('confirm','dispute') then raise exception 'Invalid vote.'; end if;

  select * into v_p from public.vessel_edit_proposals where id = p_proposal for update;
  if not found then raise exception 'That suggestion no longer exists.'; end if;
  if v_p.status <> 'open' then
    raise exception 'That suggestion has already been %.', v_p.status;
  end if;
  if v_p.proposed_by = v_uid then
    raise exception 'You can''t vote on your own suggestion.';
  end if;

  insert into public.vessel_edit_votes (proposal_id, user_id, vote)
  values (p_proposal, v_uid, p_vote)
  on conflict (proposal_id, user_id) do update
    set vote = excluded.vote, created_at = now();

  select count(*) filter (where vote = 'confirm'),
         count(*) filter (where vote = 'dispute')
    into v_confirm, v_dispute
    from public.vessel_edit_votes where proposal_id = p_proposal;

  if v_confirm >= 3 then
    perform public._apply_vessel_edit(v_p);
    update public.vessel_edit_proposals
       set status = 'applied', applied_at = now(),
           confirm_count = v_confirm, dispute_count = v_dispute
     where id = p_proposal;

    -- Close out competing open suggestions on the very same target.
    update public.vessel_edit_proposals
       set status = 'superseded', resolved_at = now()
     where vessel_id = v_p.vessel_id
       and status = 'open'
       and id <> p_proposal
       and target_table  = v_p.target_table
       and action        = v_p.action
       and target_column is not distinct from v_p.target_column
       and target_row_id is not distinct from v_p.target_row_id;

    v_applied := true;
    v_status  := 'applied';

  elsif v_dispute >= 3 then
    update public.vessel_edit_proposals
       set status = 'rejected', resolved_at = now(),
           confirm_count = v_confirm, dispute_count = v_dispute
     where id = p_proposal;
    v_status := 'rejected';

  else
    update public.vessel_edit_proposals
       set confirm_count = v_confirm, dispute_count = v_dispute
     where id = p_proposal;
    v_status := 'open';
  end if;

  return jsonb_build_object(
    'status',        v_status,
    'confirm_count', v_confirm,
    'dispute_count', v_dispute,
    'applied',       v_applied
  );
end;
$$;


--
-- Name: wallet_credit(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wallet_credit(p_user uuid, p_amount integer) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_new int;
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'wallet_credit: amount must be >= 0';
  end if;
  insert into public.local_wallet_balances (user_id, balance_pence, updated_at)
  values (p_user, p_amount, now())
  on conflict (user_id) do update
    set balance_pence = public.local_wallet_balances.balance_pence + excluded.balance_pence,
        updated_at    = now()
  returning balance_pence into v_new;
  return v_new;
end;
$$;


--
-- Name: FUNCTION wallet_credit(p_user uuid, p_amount integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.wallet_credit(p_user uuid, p_amount integer) IS 'Atomic wallet credit (top-up/cashback/refund). Returns new balance_pence.';


--
-- Name: wallet_debit(uuid, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.wallet_debit(p_user uuid, p_spend integer, p_cashback integer DEFAULT 0) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_new int;
begin
  if p_spend is null or p_spend < 0 or p_cashback is null or p_cashback < 0 then
    raise exception 'wallet_debit: invalid amounts';
  end if;
  update public.local_wallet_balances
     set balance_pence = balance_pence - p_spend + p_cashback,
         updated_at    = now()
   where user_id = p_user
     and balance_pence >= p_spend
  returning balance_pence into v_new;
  return v_new;  -- NULL when the guard failed (insufficient funds)
end;
$$;


--
-- Name: FUNCTION wallet_debit(p_user uuid, p_spend integer, p_cashback integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.wallet_debit(p_user uuid, p_spend integer, p_cashback integer) IS 'Atomic guarded wallet debit. Returns new balance_pence, or NULL if insufficient funds.';


--
-- Name: admin_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_config (
    key text NOT NULL,
    value text NOT NULL,
    description text,
    category text NOT NULL,
    is_secret boolean DEFAULT false,
    updated_at timestamp with time zone DEFAULT now(),
    updated_by uuid
);


--
-- Name: application_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.application_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    application_id uuid NOT NULL,
    from_status text,
    to_status text NOT NULL,
    actor_id uuid,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: book_availability_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.book_availability_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    service_id uuid,
    day_of_week integer NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    slot_interval_minutes integer DEFAULT 30,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT book_availability_rules_check CHECK ((end_time > start_time)),
    CONSTRAINT book_availability_rules_day_of_week_check CHECK (((day_of_week >= 0) AND (day_of_week <= 6))),
    CONSTRAINT book_availability_rules_slot_interval_minutes_check CHECK (((slot_interval_minutes >= 5) AND (slot_interval_minutes <= 240)))
);


--
-- Name: book_bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.book_bookings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    service_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    status text DEFAULT 'confirmed'::text NOT NULL,
    price_pence integer NOT NULL,
    deposit_pence integer DEFAULT 0,
    deposit_payment_intent_id text,
    deposit_paid_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    cancelled_by uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    gift_id uuid,
    CONSTRAINT book_bookings_check CHECK ((ends_at > starts_at)),
    CONSTRAINT book_bookings_status_check CHECK ((status = ANY (ARRAY['pending_payment'::text, 'confirmed'::text, 'cancelled'::text, 'no_show'::text, 'completed'::text])))
);


--
-- Name: book_gifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.book_gifts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    kind text NOT NULL,
    status text DEFAULT 'pending_payment'::text NOT NULL,
    business_id uuid NOT NULL,
    unit_item_id uuid,
    service_id uuid,
    purchaser_id uuid NOT NULL,
    purchaser_name text,
    recipient_email text NOT NULL,
    recipient_name text,
    message text,
    price_paid_pence integer NOT NULL,
    payment_intent_id text,
    email_sent_at timestamp with time zone,
    claimed_at timestamp with time zone,
    claimed_by_user_id uuid,
    used_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT book_gifts_check CHECK ((((kind = 'unit'::text) AND (unit_item_id IS NOT NULL) AND (service_id IS NULL)) OR ((kind = 'booking'::text) AND (service_id IS NOT NULL) AND (unit_item_id IS NULL)))),
    CONSTRAINT book_gifts_kind_check CHECK ((kind = ANY (ARRAY['unit'::text, 'booking'::text]))),
    CONSTRAINT book_gifts_status_check CHECK ((status = ANY (ARRAY['pending_payment'::text, 'sent'::text, 'claimed'::text, 'used'::text, 'cancelled'::text])))
);


--
-- Name: book_services; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.book_services (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    duration_minutes integer NOT NULL,
    buffer_minutes integer DEFAULT 0,
    price_pence integer NOT NULL,
    deposit_pence integer DEFAULT 0,
    requires_deposit boolean DEFAULT false,
    category text,
    display_order integer DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    capacity integer DEFAULT 1 NOT NULL,
    image_url text,
    CONSTRAINT book_services_buffer_minutes_check CHECK ((buffer_minutes >= 0)),
    CONSTRAINT book_services_capacity_check CHECK (((capacity >= 1) AND (capacity <= 999))),
    CONSTRAINT book_services_deposit_pence_check CHECK ((deposit_pence >= 0)),
    CONSTRAINT book_services_duration_minutes_check CHECK (((duration_minutes >= 5) AND (duration_minutes <= 600))),
    CONSTRAINT book_services_price_pence_check CHECK ((price_pence >= 0))
);


--
-- Name: book_slot_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.book_slot_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    service_id uuid,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    type text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT book_slot_overrides_check CHECK ((ends_at > starts_at)),
    CONSTRAINT book_slot_overrides_type_check CHECK ((type = ANY (ARRAY['open'::text, 'closed'::text, 'last_min'::text])))
);


--
-- Name: book_unit_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.book_unit_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    price_pence integer NOT NULL,
    stock integer,
    valid_days integer,
    uses_per_purchase integer DEFAULT 1 NOT NULL,
    image_url text,
    category text,
    display_order integer DEFAULT 0,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT book_unit_items_price_pence_check CHECK ((price_pence > 0)),
    CONSTRAINT book_unit_items_stock_check CHECK (((stock IS NULL) OR (stock >= 0))),
    CONSTRAINT book_unit_items_uses_per_purchase_check CHECK ((uses_per_purchase > 0)),
    CONSTRAINT book_unit_items_valid_days_check CHECK (((valid_days IS NULL) OR (valid_days > 0)))
);


--
-- Name: book_unit_purchases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.book_unit_purchases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    business_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    paid_amount_pence integer NOT NULL,
    uses_remaining integer NOT NULL,
    payment_intent_id text,
    gift_id uuid,
    expires_at timestamp with time zone,
    fully_used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT book_unit_purchases_uses_remaining_check CHECK ((uses_remaining >= 0))
);


--
-- Name: business_addons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.business_addons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    addon_key text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT valid_addon_key CHECK ((addon_key = ANY (ARRAY['products'::text, 'bookings'::text, 'services'::text, 'events'::text, 'membership'::text, 'offers'::text, 'stamps'::text, 'enquiries'::text, 'payments'::text, 'featured'::text, 'jobs'::text])))
);


--
-- Name: business_alert_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.business_alert_access (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    status text DEFAULT 'requested'::text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    reviewed_by uuid,
    reviewer_notes text,
    stripe_subscription_id text,
    activated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT business_alert_access_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'approved'::text, 'active'::text, 'rejected'::text, 'suspended'::text])))
);


--
-- Name: business_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.business_claims (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    user_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    contact_name text,
    contact_email text,
    contact_phone text,
    role text,
    evidence text,
    admin_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    reviewed_by uuid,
    CONSTRAINT business_claims_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: business_discount_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.business_discount_grants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    tier text NOT NULL,
    percent_off integer NOT NULL,
    duration_months integer DEFAULT 12 NOT NULL,
    applicable_from timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    stripe_coupon_id text,
    granted_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    redeemed_at timestamp with time zone,
    CONSTRAINT business_discount_grants_percent_off_check CHECK (((percent_off >= 1) AND (percent_off <= 100))),
    CONSTRAINT business_discount_grants_status_check CHECK ((status = ANY (ARRAY['active'::text, 'redeemed'::text, 'expired'::text, 'revoked'::text]))),
    CONSTRAINT business_discount_grants_tier_check CHECK ((tier = ANY (ARRAY['pro'::text, 'premium'::text])))
);


--
-- Name: compliance_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.compliance_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    user_email text NOT NULL,
    user_name text,
    event_type text NOT NULL,
    document_version text,
    description text,
    ip_address text,
    device_info text,
    app_version text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    email_log_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cruise_visits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cruise_visits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ship_id uuid,
    ship_name_cache text,
    arrival_at timestamp with time zone,
    departure_at timestamp with time zone,
    visit_date date,
    from_location text,
    to_location text,
    berth text,
    berth_area_group text,
    is_tender boolean DEFAULT false NOT NULL,
    time_in_port_hours numeric,
    all_aboard_at timestamp with time zone,
    est_pax integer,
    est_pax_label text,
    est_passenger_range text,
    ships_same_day integer,
    is_multi_ship_day boolean DEFAULT false NOT NULL,
    est_footfall_score integer,
    port_load_score integer,
    is_cruise_ship boolean DEFAULT true NOT NULL,
    is_repeat_ship boolean DEFAULT false NOT NULL,
    is_weekend boolean DEFAULT false NOT NULL,
    status text DEFAULT 'scheduled'::text NOT NULL,
    last_verified date,
    verification_source text,
    agent text,
    headline_text text,
    social_caption text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cruise_visits_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'confirmed'::text, 'in_port'::text, 'departed'::text, 'cancelled'::text, 'completed'::text]))),
    CONSTRAINT cruise_visits_verification_source_check CHECK ((verification_source = ANY (ARRAY['lerwick_harbour'::text, 'agent_update'::text, 'manual_check'::text, 'marinetraffic'::text])))
);


--
-- Name: cruise_day_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.cruise_day_summary WITH (security_invoker='true') AS
 SELECT visit_date,
    count(*) AS ships_count,
    sum(COALESCE(est_pax, 0)) AS total_est_pax,
    sum(COALESCE(est_footfall_score, 0)) AS total_footfall_score,
    max(time_in_port_hours) AS max_time_in_port_hours,
    bool_or(is_multi_ship_day) AS multi_ship,
    public.cruise_barometer((sum(COALESCE(est_pax, 0)))::integer, (count(*))::integer) AS barometer
   FROM public.cruise_visits
  WHERE ((status <> 'cancelled'::text) AND (visit_date IS NOT NULL))
  GROUP BY visit_date;


--
-- Name: cruise_ships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cruise_ships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text,
    vessel_type text,
    cruise_line text,
    image_url text,
    length_m numeric,
    length_label text,
    default_pax integer,
    imo text,
    mmsi text,
    is_large_ship boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cv_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cv_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    label text NOT NULL,
    body text,
    external_url text,
    is_primary boolean DEFAULT false NOT NULL,
    generated_by_ai boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT cv_documents_kind_check CHECK ((kind = ANY (ARRAY['cv'::text, 'cover_letter'::text])))
);


--
-- Name: delivery_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    icon text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: delivery_fees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_fees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category_slug text NOT NULL,
    base_fee_pence integer NOT NULL,
    waiting_grace_mins integer DEFAULT 5 NOT NULL,
    waiting_fee_pence integer DEFAULT 150 NOT NULL,
    waiting_period_mins integer DEFAULT 5 NOT NULL,
    waiting_max_pence integer DEFAULT 600 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: delivery_pricing_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_pricing_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    price_per_mile_pence integer DEFAULT 95 NOT NULL,
    min_fee_pence integer DEFAULT 400 NOT NULL,
    road_correction_factor numeric(4,2) DEFAULT 1.40 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: delivery_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delivery_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    run_id uuid,
    category_slug text,
    pickup_name text NOT NULL,
    pickup_location text NOT NULL,
    pickup_notes text,
    already_paid boolean DEFAULT false NOT NULL,
    ready_for_collection boolean DEFAULT false NOT NULL,
    destination_region_id uuid,
    destination_area text,
    destination_address text NOT NULL,
    delivery_notes text,
    liability_acknowledged boolean DEFAULT false NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    contact_phone text,
    payment_intent_id text,
    base_fee_pence integer,
    waiting_fee_pence integer DEFAULT 0 NOT NULL,
    total_fee_pence integer,
    payment_status text DEFAULT 'unpaid'::text NOT NULL,
    CONSTRAINT delivery_requests_payment_status_check CHECK ((payment_status = ANY (ARRAY['unpaid'::text, 'authorised'::text, 'captured'::text, 'refunded'::text, 'failed'::text]))),
    CONSTRAINT delivery_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'matched'::text, 'collected'::text, 'delivered'::text, 'cancelled'::text])))
);


--
-- Name: driver_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.driver_profiles (
    id uuid NOT NULL,
    driver_status text DEFAULT 'not_applied'::text NOT NULL,
    vehicle_type text,
    vehicle_reg text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    stripe_account_id text,
    stripe_onboarding_complete boolean DEFAULT false NOT NULL,
    stripe_payouts_enabled boolean DEFAULT false NOT NULL,
    stripe_charges_enabled boolean DEFAULT false NOT NULL,
    dispute_count integer DEFAULT 0 NOT NULL,
    flagged_for_review boolean DEFAULT false NOT NULL,
    CONSTRAINT driver_profiles_driver_status_check CHECK ((driver_status = ANY (ARRAY['not_applied'::text, 'pending'::text, 'approved'::text, 'rejected'::text, 'suspended'::text])))
);


--
-- Name: email_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_key text NOT NULL,
    recipient_id uuid,
    recipient_email text NOT NULL,
    subject text NOT NULL,
    status text DEFAULT 'sent'::text NOT NULL,
    postmark_id text,
    error_message text,
    metadata jsonb DEFAULT '{}'::jsonb,
    sent_at timestamp with time zone DEFAULT now(),
    CONSTRAINT email_log_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'delivered'::text, 'bounced'::text, 'failed'::text, 'skipped'::text])))
);


--
-- Name: email_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_name text DEFAULT 'OneShetland'::text NOT NULL,
    from_email text DEFAULT 'orders@oneshetland.com'::text NOT NULL,
    reply_to text,
    footer_sign_off text DEFAULT 'Thanks,'::text,
    footer_signature text DEFAULT 'The OneShetland Team'::text,
    footer_tagline text DEFAULT 'Everything Shetland, All in One Place'::text,
    footer_promo_text text,
    footer_promo_url text,
    footer_legal text DEFAULT 'OneShetland · Shetland Islands · Scotland'::text,
    footer_socials jsonb DEFAULT '[]'::jsonb,
    singleton boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT email_settings_singleton_check CHECK ((singleton = true))
);


--
-- Name: email_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    category text NOT NULL,
    label text NOT NULL,
    description text,
    enabled boolean DEFAULT true NOT NULL,
    subject text NOT NULL,
    body_html text NOT NULL,
    body_text text,
    variables text[] DEFAULT '{}'::text[],
    requires_optin boolean DEFAULT false,
    postmark_stream text DEFAULT 'outbound'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: event_checkins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_checkins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    event_id uuid NOT NULL,
    scanner_id uuid NOT NULL,
    result text NOT NULL,
    scanned_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT event_checkins_result_check CHECK ((result = ANY (ARRAY['valid'::text, 'already_used'::text, 'wrong_event'::text, 'cancelled'::text, 'refunded'::text, 'not_found'::text, 'payment_incomplete'::text, 'invalid_token'::text])))
);


--
-- Name: event_ticket_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_ticket_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    buyer_id uuid NOT NULL,
    stripe_payment_intent_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    total_pence integer DEFAULT 0 NOT NULL,
    platform_fee_pence integer DEFAULT 0 NOT NULL,
    tickets_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    CONSTRAINT event_ticket_orders_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'cancelled'::text, 'refunded'::text])))
);


--
-- Name: event_ticket_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_ticket_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    price_pence integer DEFAULT 0 NOT NULL,
    quantity_available integer,
    quantity_sold integer DEFAULT 0 NOT NULL,
    per_order_max integer DEFAULT 10 NOT NULL,
    sale_starts_at timestamp with time zone,
    sale_ends_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    requires_attendee_details boolean DEFAULT false NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT event_ticket_types_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 100))),
    CONSTRAINT event_ticket_types_price_pence_check CHECK ((price_pence >= 0))
);


--
-- Name: event_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    event_id uuid NOT NULL,
    ticket_type_id uuid NOT NULL,
    holder_id uuid NOT NULL,
    validation_token_hash text NOT NULL,
    backup_code text NOT NULL,
    status text DEFAULT 'pending_payment'::text NOT NULL,
    attendee_name text,
    attendee_email text,
    attendee_notes text,
    checked_in_at timestamp with time zone,
    checked_in_by uuid,
    price_pence integer DEFAULT 0 NOT NULL,
    event_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT event_tickets_status_check CHECK ((status = ANY (ARRAY['pending_payment'::text, 'valid'::text, 'used'::text, 'cancelled'::text, 'refunded'::text])))
);


--
-- Name: event_updates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_updates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    author_id uuid NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    kind text DEFAULT 'info'::text NOT NULL,
    is_urgent boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT event_updates_kind_check CHECK ((kind = ANY (ARRAY['info'::text, 'urgent'::text, 'cancellation'::text, 'venue_change'::text, 'time_change'::text, 'weather'::text, 'entry_info'::text]))),
    CONSTRAINT event_updates_title_check CHECK (((length(TRIM(BOTH FROM title)) >= 1) AND (length(TRIM(BOTH FROM title)) <= 200)))
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organiser_user_id uuid,
    organiser_business_id uuid,
    title text NOT NULL,
    description text,
    category text,
    venue text,
    locality text,
    lat numeric,
    lng numeric,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone,
    cover_url text,
    price_text text,
    ticket_url text,
    is_featured boolean DEFAULT false NOT NULL,
    is_hidden boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    doors_open_at timestamp with time zone,
    capacity integer,
    has_tickets boolean DEFAULT false NOT NULL,
    place_id text,
    formatted_address text,
    gallery_urls text[] DEFAULT '{}'::text[] NOT NULL,
    video_url text,
    accessibility_info text,
    age_restriction text,
    refund_policy text,
    contact_info text,
    event_notes text,
    tickets_sold integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    organiser_hub_id uuid,
    hub_visibility text,
    calendar_approved boolean DEFAULT false NOT NULL,
    calendar_approved_by uuid,
    calendar_approved_at timestamp with time zone,
    CONSTRAINT events_hub_visibility_check CHECK ((hub_visibility = ANY (ARRAY['members'::text, 'hub'::text, 'islands'::text]))),
    CONSTRAINT events_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'cancelled'::text, 'postponed'::text, 'archived'::text]))),
    CONSTRAINT events_title_check CHECK (((length(TRIM(BOTH FROM title)) >= 1) AND (length(TRIM(BOTH FROM title)) <= 200)))
);


--
-- Name: game_shetland_places; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.game_shetland_places (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    alt_names text[],
    category text NOT NULL,
    difficulty text NOT NULL,
    lat numeric(9,6) NOT NULL,
    lng numeric(9,6) NOT NULL,
    region text,
    notes text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT game_shetland_places_category_check CHECK ((category = ANY (ARRAY['settlement'::text, 'island'::text, 'voe'::text, 'loch'::text, 'beach'::text, 'headland'::text, 'hill'::text, 'lighthouse'::text, 'broch'::text, 'sound'::text, 'geo'::text, 'landmark'::text]))),
    CONSTRAINT game_shetland_places_difficulty_check CHECK ((difficulty = ANY (ARRAY['easy'::text, 'medium'::text, 'hard'::text])))
);


--
-- Name: games_scores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.games_scores (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    game_id text NOT NULL,
    score integer NOT NULL,
    duration_ms integer,
    metadata jsonb,
    played_at timestamp with time zone DEFAULT now()
);


--
-- Name: games_user_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.games_user_stats (
    user_id uuid NOT NULL,
    total_xp integer DEFAULT 0,
    level integer DEFAULT 1,
    current_streak_days integer DEFAULT 0,
    longest_streak_days integer DEFAULT 0,
    last_played_date date,
    games_played integer DEFAULT 0,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: hub_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hub_campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hub_id uuid NOT NULL,
    title text NOT NULL,
    story text,
    goal_pence integer NOT NULL,
    raised_pence integer DEFAULT 0 NOT NULL,
    donor_count integer DEFAULT 0 NOT NULL,
    cover_url text,
    status text DEFAULT 'active'::text NOT NULL,
    ends_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hub_campaigns_goal_pence_check CHECK ((goal_pence > 0)),
    CONSTRAINT hub_campaigns_status_check CHECK ((status = ANY (ARRAY['active'::text, 'closed'::text]))),
    CONSTRAINT hub_campaigns_title_check CHECK (((length(TRIM(BOTH FROM title)) >= 1) AND (length(TRIM(BOTH FROM title)) <= 160)))
);


--
-- Name: hub_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hub_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hub_id uuid NOT NULL,
    title text NOT NULL,
    url text NOT NULL,
    visibility text DEFAULT 'members'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hub_documents_title_check CHECK (((length(TRIM(BOTH FROM title)) >= 1) AND (length(TRIM(BOTH FROM title)) <= 160))),
    CONSTRAINT hub_documents_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'members'::text, 'committee'::text])))
);


--
-- Name: hub_donations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hub_donations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    campaign_id uuid NOT NULL,
    hub_id uuid NOT NULL,
    donor_user_id uuid,
    amount_pence integer NOT NULL,
    fee_pence integer DEFAULT 0 NOT NULL,
    message text,
    is_anonymous boolean DEFAULT false NOT NULL,
    stripe_payment_intent_id text,
    gift_aid boolean DEFAULT false NOT NULL,
    ga_title text,
    ga_first_name text,
    ga_last_name text,
    ga_address text,
    ga_postcode text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hub_donations_amount_pence_check CHECK ((amount_pence > 0))
);


--
-- Name: hub_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hub_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hub_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    membership_type_id uuid,
    member_no text,
    paid_until timestamp with time zone,
    last_payment_pence integer,
    stripe_payment_intent_id text,
    CONSTRAINT hub_members_role_check CHECK ((role = ANY (ARRAY['member'::text, 'committee'::text, 'owner'::text]))),
    CONSTRAINT hub_members_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'rejected'::text, 'left'::text])))
);


--
-- Name: COLUMN hub_members.member_no; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.hub_members.member_no IS 'Human-readable membership number, assigned when membership becomes active.';


--
-- Name: COLUMN hub_members.paid_until; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.hub_members.paid_until IS 'Membership valid until this date (paid memberships). NULL for free memberships, which do not expire.';


--
-- Name: hub_membership_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hub_membership_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hub_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    price_pence integer DEFAULT 0 NOT NULL,
    period text DEFAULT 'year'::text NOT NULL,
    benefits text,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hub_membership_types_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 80))),
    CONSTRAINT hub_membership_types_period_check CHECK ((period = ANY (ARRAY['once'::text, 'month'::text, 'year'::text]))),
    CONSTRAINT hub_membership_types_price_pence_check CHECK ((price_pence >= 0))
);


--
-- Name: hubs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hubs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    name text NOT NULL,
    slug text,
    type text DEFAULT 'community'::text NOT NULL,
    description text,
    logo_url text,
    cover_url text,
    brand_color text,
    contact_email text,
    contact_phone text,
    website text,
    area text,
    join_mode text DEFAULT 'approval'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_verified boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    stripe_account_id text,
    payout_enabled boolean DEFAULT false NOT NULL,
    memberships_enabled boolean DEFAULT false NOT NULL,
    directory_enabled boolean DEFAULT false NOT NULL,
    is_charity boolean DEFAULT false NOT NULL,
    charity_number text,
    CONSTRAINT hubs_join_mode_check CHECK ((join_mode = ANY (ARRAY['open'::text, 'approval'::text]))),
    CONSTRAINT hubs_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 120))),
    CONSTRAINT hubs_type_check CHECK ((type = ANY (ARRAY['club'::text, 'sports'::text, 'youth'::text, 'hall'::text, 'charity'::text, 'society'::text, 'volunteer'::text, 'arts'::text, 'community'::text, 'other'::text])))
);


--
-- Name: COLUMN hubs.stripe_account_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.hubs.stripe_account_id IS 'Hub''s own Stripe Connect (Express) account. Membership payments are destination-charged here; the platform keeps only the application fee.';


--
-- Name: COLUMN hubs.payout_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.hubs.payout_enabled IS 'TRUE once the hub''s connected account can receive payouts. Required before any paid membership can be sold.';


--
-- Name: job_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_applications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid NOT NULL,
    applicant_id uuid NOT NULL,
    status text DEFAULT 'applied'::text NOT NULL,
    cover_letter text,
    profile_snapshot jsonb DEFAULT '{}'::jsonb NOT NULL,
    visibility text DEFAULT 'full'::text NOT NULL,
    employer_note text,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    status_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT job_applications_status_check CHECK ((status = ANY (ARRAY['applied'::text, 'viewed'::text, 'shortlisted'::text, 'interview'::text, 'offer'::text, 'hired'::text, 'declined'::text, 'withdrawn'::text]))),
    CONSTRAINT job_applications_visibility_check CHECK ((visibility = ANY (ARRAY['full'::text, 'snapshot'::text])))
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employer_id uuid NOT NULL,
    posted_as_business_id uuid,
    title text NOT NULL,
    description text,
    category text,
    location text,
    locality text,
    lat numeric(9,6),
    lng numeric(9,6),
    contract_type text DEFAULT 'full-time'::text NOT NULL,
    pay_text text,
    apply_url text,
    apply_email text,
    is_featured boolean DEFAULT false NOT NULL,
    is_hidden boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone,
    posted_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pay_min numeric(10,2),
    pay_max numeric(10,2),
    pay_period text,
    pay_hidden boolean DEFAULT false NOT NULL,
    boosted_until timestamp with time zone,
    relocation_support boolean DEFAULT false NOT NULL,
    housing_available boolean DEFAULT false NOT NULL,
    is_seasonal boolean DEFAULT false NOT NULL,
    season_label text,
    remote_mode text DEFAULT 'on_site'::text NOT NULL,
    views_count integer DEFAULT 0 NOT NULL,
    application_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT jobs_contract_type_check CHECK ((contract_type = ANY (ARRAY['full-time'::text, 'part-time'::text, 'casual'::text, 'apprenticeship'::text, 'volunteer'::text, 'freelance'::text]))),
    CONSTRAINT jobs_pay_period_check CHECK ((pay_period = ANY (ARRAY['hour'::text, 'day'::text, 'week'::text, 'month'::text, 'year'::text, 'total'::text]))),
    CONSTRAINT jobs_remote_mode_check CHECK ((remote_mode = ANY (ARRAY['on_site'::text, 'hybrid'::text, 'remote'::text]))),
    CONSTRAINT jobs_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text, 'filled'::text]))),
    CONSTRAINT jobs_title_check CHECK (((length(TRIM(BOTH FROM title)) >= 1) AND (length(TRIM(BOTH FROM title)) <= 200)))
);


--
-- Name: local_boost_purchases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_boost_purchases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    weeks integer NOT NULL,
    amount_pence integer NOT NULL,
    stripe_payment_intent_id text,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT local_boost_purchases_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'succeeded'::text, 'failed'::text, 'refunded'::text]))),
    CONSTRAINT local_boost_purchases_weeks_check CHECK (((weeks >= 1) AND (weeks <= 4)))
);


--
-- Name: local_business_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_business_codes (
    business_id uuid NOT NULL,
    current_code text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: local_business_follows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_business_follows (
    user_id uuid NOT NULL,
    business_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: local_businesses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_businesses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid,
    name text NOT NULL,
    category text NOT NULL,
    description text,
    address text NOT NULL,
    lat numeric(9,6),
    lng numeric(9,6),
    logo_url text,
    cover_url text,
    phone text,
    website text,
    email text,
    opening_hours jsonb,
    is_verified boolean DEFAULT false,
    is_active boolean DEFAULT true,
    accepts_wallet boolean DEFAULT false,
    cashback_percent numeric(4,2) DEFAULT 0,
    stripe_account_id text,
    payout_enabled boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    subscription_tier text DEFAULT 'free'::text NOT NULL,
    subscription_until timestamp with time zone,
    nfc_token text,
    nfc_status text DEFAULT 'none'::text NOT NULL,
    nfc_dispatched_at timestamp with time zone,
    nfc_activated_at timestamp with time zone,
    accepts_bookings boolean DEFAULT false,
    stripe_customer_id text,
    stripe_subscription_id text,
    subscription_cancel_at_period_end boolean DEFAULT false,
    use_business_payment boolean DEFAULT false NOT NULL,
    business_stripe_customer_id text,
    has_business_payment_method boolean DEFAULT false NOT NULL,
    use_business_payout boolean DEFAULT false NOT NULL,
    business_stripe_account_id text,
    business_stripe_onboarding_complete boolean DEFAULT false NOT NULL,
    business_stripe_payouts_enabled boolean DEFAULT false NOT NULL,
    slug text,
    brand_color text,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    source text DEFAULT 'owner'::text NOT NULL,
    place_id text,
    is_claimed boolean DEFAULT true NOT NULL,
    claimed_at timestamp with time zone,
    verified_at timestamp with time zone,
    can_publish_urgent boolean DEFAULT false NOT NULL,
    CONSTRAINT local_businesses_category_check CHECK ((category = ANY (ARRAY['food_drink'::text, 'retail'::text, 'services'::text, 'tourism'::text, 'accommodation'::text, 'other'::text]))),
    CONSTRAINT local_businesses_nfc_status_check CHECK ((nfc_status = ANY (ARRAY['none'::text, 'requested'::text, 'dispatched'::text, 'active'::text]))),
    CONSTRAINT local_businesses_source_check CHECK ((source = ANY (ARRAY['owner'::text, 'csv'::text, 'google'::text, 'wordpress'::text]))),
    CONSTRAINT local_businesses_subscription_tier_check CHECK ((subscription_tier = ANY (ARRAY['free'::text, 'pro'::text, 'premium'::text])))
);


--
-- Name: COLUMN local_businesses.brand_color; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.local_businesses.brand_color IS 'Hex colour (#RRGGBB) auto-extracted from the logo; tints the public banner when no cover_url is set.';


--
-- Name: COLUMN local_businesses.tags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.local_businesses.tags IS 'Trade/service tags (e.g. Plumbing, Joinery) used by directory search.';


--
-- Name: COLUMN local_businesses.source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.local_businesses.source IS 'How the listing entered the directory: owner (self-registered), csv/google/wordpress (seeded).';


--
-- Name: COLUMN local_businesses.place_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.local_businesses.place_id IS 'Google Places place_id — the only Places field we may store indefinitely. Used to refresh map coords / live hours.';


--
-- Name: COLUMN local_businesses.is_claimed; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.local_businesses.is_claimed IS 'FALSE for seeded stubs nobody owns yet. A verified claim flips this to TRUE and sets owner_id.';


--
-- Name: local_loyalty_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_loyalty_cards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    program_id uuid NOT NULL,
    business_id uuid NOT NULL,
    stamps_collected integer DEFAULT 0,
    points_balance integer DEFAULT 0,
    total_redeemed integer DEFAULT 0,
    last_stamp_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: local_loyalty_programs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_loyalty_programs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    type text NOT NULL,
    stamps_required integer,
    stamp_reward text,
    points_per_pound numeric(6,2),
    points_for_pound integer,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT local_loyalty_programs_type_check CHECK ((type = ANY (ARRAY['stamps'::text, 'points'::text])))
);


--
-- Name: local_loyalty_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_loyalty_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    card_id uuid NOT NULL,
    user_id uuid NOT NULL,
    business_id uuid NOT NULL,
    type text NOT NULL,
    amount integer NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT local_loyalty_transactions_type_check CHECK ((type = ANY (ARRAY['stamp'::text, 'points_earn'::text, 'redeem'::text, 'reward'::text])))
);


--
-- Name: local_offer_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_offer_redemptions (
    offer_id uuid NOT NULL,
    user_id uuid NOT NULL,
    redeemed_at timestamp with time zone DEFAULT now()
);


--
-- Name: local_offers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_offers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    image_url text,
    discount_type text,
    discount_value numeric(8,2),
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    valid_until timestamp with time zone NOT NULL,
    terms text,
    max_redemptions integer,
    is_active boolean DEFAULT true,
    redemption_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT local_offers_discount_type_check CHECK ((discount_type = ANY (ARRAY['percent'::text, 'fixed'::text, 'freebie'::text, 'bogo'::text, 'other'::text])))
);


--
-- Name: local_wallet_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_wallet_balances (
    user_id uuid NOT NULL,
    balance_pence integer DEFAULT 0,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: local_wallet_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.local_wallet_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    business_id uuid,
    type text NOT NULL,
    amount_pence integer NOT NULL,
    stripe_payment_intent_id text,
    stripe_transfer_id text,
    description text,
    created_at timestamp with time zone DEFAULT now(),
    platform_fee_pence integer,
    cashback_pence integer,
    CONSTRAINT local_wallet_transactions_cashback_pence_check CHECK (((cashback_pence IS NULL) OR (cashback_pence >= 0))),
    CONSTRAINT local_wallet_transactions_platform_fee_pence_check CHECK (((platform_fee_pence IS NULL) OR (platform_fee_pence >= 0))),
    CONSTRAINT local_wallet_transactions_type_check CHECK ((type = ANY (ARRAY['topup'::text, 'spend'::text, 'refund'::text, 'cashback'::text])))
);


--
-- Name: measurements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.measurements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vessel_id uuid NOT NULL,
    measurement_year integer,
    length_m numeric,
    tonnage numeric,
    tonnage_type text,
    tonnage_text text,
    engine_power_kw numeric,
    capacity_units numeric,
    source_record_id uuid,
    notes text
);


--
-- Name: media_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_document_id uuid NOT NULL,
    source_record_id uuid,
    asset_type text NOT NULL,
    title text,
    external_ref text,
    image_url text,
    thumbnail_url text,
    page_url text,
    rights_note text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    author_id uuid NOT NULL,
    lat numeric(9,6),
    lng numeric(9,6),
    place_name text,
    parent_id uuid,
    era text,
    title text,
    body text,
    visibility text DEFAULT 'public'::text NOT NULL,
    is_hidden boolean DEFAULT false NOT NULL,
    hidden_reason text,
    hidden_by uuid,
    hidden_at timestamp with time zone,
    media_count integer DEFAULT 0 NOT NULL,
    comment_count integer DEFAULT 0 NOT NULL,
    reaction_count integer DEFAULT 0 NOT NULL,
    child_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT memories_has_location CHECK ((((lat IS NOT NULL) AND (lng IS NOT NULL)) OR (parent_id IS NOT NULL))),
    CONSTRAINT memories_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'community'::text, 'private'::text])))
);


--
-- Name: memory_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    memory_id uuid NOT NULL,
    author_id uuid NOT NULL,
    image_pin_id uuid,
    body text NOT NULL,
    is_hidden boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_comments_body_check CHECK (((length(body) >= 1) AND (length(body) <= 4000)))
);


--
-- Name: memory_image_pin_suggestions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_image_pin_suggestions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    pin_id uuid NOT NULL,
    suggester_id uuid NOT NULL,
    answer text NOT NULL,
    is_accepted boolean DEFAULT false NOT NULL,
    accepted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_image_pin_suggestions_answer_check CHECK (((length(TRIM(BOTH FROM answer)) >= 1) AND (length(TRIM(BOTH FROM answer)) <= 400)))
);


--
-- Name: memory_media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_media (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    memory_id uuid NOT NULL,
    uploader_id uuid NOT NULL,
    kind text NOT NULL,
    url text NOT NULL,
    storage_path text NOT NULL,
    thumb_url text,
    transcript text,
    transcript_status text DEFAULT 'none'::text NOT NULL,
    caption text,
    display_order integer DEFAULT 0 NOT NULL,
    duration_seconds integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_media_kind_check CHECK ((kind = ANY (ARRAY['photo'::text, 'video'::text, 'audio'::text]))),
    CONSTRAINT memory_media_transcript_status_check CHECK ((transcript_status = ANY (ARRAY['none'::text, 'pending'::text, 'done'::text, 'failed'::text])))
);


--
-- Name: memory_reactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_reactions (
    memory_id uuid NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT memory_reactions_kind_check CHECK ((kind = ANY (ARRAY['heart'::text, 'applaud'::text, 'compass'::text, 'scroll'::text])))
);


--
-- Name: notices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    publisher_business_id uuid,
    publisher_user_id uuid,
    severity text DEFAULT 'community'::text NOT NULL,
    title text NOT NULL,
    body text,
    locality text,
    lat numeric(9,6),
    lng numeric(9,6),
    is_pinned boolean DEFAULT false NOT NULL,
    is_hidden boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    publisher_hub_id uuid,
    visibility text DEFAULT 'public'::text NOT NULL,
    image_url text,
    category text,
    campaign_id uuid,
    event_id uuid,
    CONSTRAINT notices_severity_check CHECK ((severity = ANY (ARRAY['urgent'::text, 'community'::text, 'info'::text]))),
    CONSTRAINT notices_title_check CHECK (((length(TRIM(BOTH FROM title)) >= 1) AND (length(TRIM(BOTH FROM title)) <= 200))),
    CONSTRAINT notices_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'members'::text, 'committee'::text])))
);


--
-- Name: notification_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    category text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    data jsonb,
    status text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT notification_log_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'skipped_pref'::text, 'skipped_quiet'::text, 'no_token'::text, 'error'::text])))
);


--
-- Name: notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_preferences (
    user_id uuid NOT NULL,
    enabled boolean DEFAULT true,
    bookings_enabled boolean DEFAULT true,
    shifts_enabled boolean DEFAULT true,
    fetch_enabled boolean DEFAULT true,
    loyalty_enabled boolean DEFAULT true,
    offers_enabled boolean DEFAULT true,
    spik_enabled boolean DEFAULT true,
    games_enabled boolean DEFAULT true,
    quiet_hours_start time without time zone,
    quiet_hours_end time without time zone,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: oneshetland_feed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oneshetland_feed (
    id integer DEFAULT 1 NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: owners; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.owners (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    normalised_name text NOT NULL,
    notes text
);


--
-- Name: ownership_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ownership_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vessel_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    start_year integer,
    end_year integer,
    date_text text,
    confidence text DEFAULT 'possible'::text NOT NULL,
    source_record_id uuid,
    notes text,
    CONSTRAINT ownership_periods_confidence_check CHECK ((confidence = ANY (ARRAY['confirmed'::text, 'probable'::text, 'possible'::text, 'unmatched'::text, 'conflict'::text])))
);


--
-- Name: partner_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    business_name text NOT NULL,
    message text NOT NULL,
    type text DEFAULT 'info'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    starts_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT partner_alerts_type_check CHECK ((type = ANY (ARRAY['emergency'::text, 'disruption'::text, 'info'::text])))
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    role text DEFAULT 'customer'::text NOT NULL,
    full_name text,
    phone text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    has_payment_method boolean DEFAULT false NOT NULL,
    stripe_customer_id text,
    avatar_url text,
    display_name text,
    bio text,
    website_url text,
    location_area text,
    email_verified boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    push_token text,
    games_handle text,
    stripe_account_id text,
    stripe_onboarding_complete boolean DEFAULT false NOT NULL,
    stripe_payouts_enabled boolean DEFAULT false NOT NULL,
    stripe_charges_enabled boolean DEFAULT false NOT NULL,
    is_platform_owner boolean DEFAULT false NOT NULL,
    CONSTRAINT profiles_games_handle_format CHECK (((games_handle IS NULL) OR (((char_length(games_handle) >= 3) AND (char_length(games_handle) <= 20)) AND (games_handle ~ '^[A-Za-z0-9_-]+$'::text)))),
    CONSTRAINT profiles_role_check CHECK ((role = ANY (ARRAY['customer'::text, 'driver'::text, 'business_owner'::text, 'employer'::text, 'contributor'::text, 'moderator'::text, 'admin'::text])))
);


--
-- Name: regions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.regions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: registrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.registrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vessel_id uuid NOT NULL,
    registration text NOT NULL,
    port_mark text,
    registration_number integer,
    start_year integer,
    end_year integer,
    date_text text,
    is_primary boolean DEFAULT false NOT NULL,
    confidence text DEFAULT 'probable'::text NOT NULL,
    source_record_id uuid,
    CONSTRAINT registrations_confidence_check CHECK ((confidence = ANY (ARRAY['confirmed'::text, 'probable'::text, 'possible'::text, 'unmatched'::text, 'conflict'::text])))
);


--
-- Name: runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    driver_id uuid NOT NULL,
    origin_region_id uuid,
    destination_region_id uuid,
    destination_area text,
    departure_start timestamp with time zone NOT NULL,
    departure_end timestamp with time zone NOT NULL,
    categories_accepted text[] DEFAULT '{}'::text[] NOT NULL,
    ferry_crossing boolean DEFAULT false NOT NULL,
    notes text,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT runs_status_check CHECK ((status = ANY (ARRAY['open'::text, 'full'::text, 'completed'::text, 'cancelled'::text])))
);


--
-- Name: saved_addresses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_addresses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    label text NOT NULL,
    address text NOT NULL,
    postcode text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivery_instructions text
);


--
-- Name: saved_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    job_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: shift_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shift_alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    categories text[] DEFAULT '{}'::text[] NOT NULL,
    urgency text[] DEFAULT '{}'::text[] NOT NULL,
    min_pay numeric,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: shift_applications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shift_applications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shift_id uuid NOT NULL,
    worker_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    message text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    check_in_status text,
    checked_in_at timestamp with time zone,
    checked_out_at timestamp with time zone,
    employer_confirmed_at timestamp with time zone,
    CONSTRAINT shift_applications_check_in_status_check CHECK ((check_in_status = ANY (ARRAY['checked_in'::text, 'checked_out'::text, 'employer_confirmed'::text]))),
    CONSTRAINT shift_applications_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'withdrawn'::text])))
);


--
-- Name: shift_availability; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shift_availability (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    worker_id uuid NOT NULL,
    date date NOT NULL,
    period text DEFAULT 'all_day'::text,
    repeating text DEFAULT 'none'::text,
    valid_until date,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT shift_availability_period_check CHECK ((period = ANY (ARRAY['morning'::text, 'afternoon'::text, 'evening'::text, 'all_day'::text]))),
    CONSTRAINT shift_availability_repeating_check CHECK ((repeating = ANY (ARRAY['none'::text, 'weekly'::text])))
);


--
-- Name: shift_check_ins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shift_check_ins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shift_id uuid NOT NULL,
    worker_id uuid NOT NULL,
    clocked_in_at timestamp with time zone,
    clocked_out_at timestamp with time zone,
    hours_agreed numeric,
    hours_worked numeric GENERATED ALWAYS AS ((EXTRACT(epoch FROM (clocked_out_at - clocked_in_at)) / (3600)::numeric)) STORED,
    approved_by_employer boolean DEFAULT false,
    approved_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: shift_employer_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shift_employer_profiles (
    id uuid NOT NULL,
    business_name text NOT NULL,
    description text,
    logo_url text,
    website text,
    is_verified boolean DEFAULT false,
    rating_avg numeric DEFAULT 0,
    rating_count integer DEFAULT 0,
    stripe_customer_id text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: shift_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shift_payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shift_id uuid NOT NULL,
    worker_id uuid NOT NULL,
    employer_id uuid NOT NULL,
    gross_amount numeric NOT NULL,
    platform_fee numeric NOT NULL,
    net_amount numeric NOT NULL,
    stripe_payment_intent_id text,
    status text DEFAULT 'pending'::text,
    paid_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT shift_payments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'paid'::text, 'failed'::text, 'refunded'::text])))
);


--
-- Name: shift_qualifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shift_qualifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    worker_id uuid NOT NULL,
    name text NOT NULL,
    issued_by text,
    expires_at date,
    file_url text,
    verified_by_admin boolean DEFAULT false,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: shift_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shift_reviews (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shift_id uuid NOT NULL,
    reviewer_id uuid NOT NULL,
    reviewee_id uuid NOT NULL,
    role text NOT NULL,
    rating integer NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT shift_reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5))),
    CONSTRAINT shift_reviews_role_check CHECK ((role = ANY (ARRAY['worker'::text, 'employer'::text])))
);


--
-- Name: shift_worker_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shift_worker_profiles (
    id uuid NOT NULL,
    tagline text,
    skills text[] DEFAULT '{}'::text[],
    is_open_to_work boolean DEFAULT false,
    open_to_categories text[] DEFAULT '{}'::text[],
    min_hourly_pay numeric,
    rating_avg numeric DEFAULT 0,
    rating_count integer DEFAULT 0,
    stripe_account_id text,
    stripe_onboarding_complete boolean DEFAULT false,
    stripe_payouts_enabled boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: shifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shifts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    employer_id uuid NOT NULL,
    title text NOT NULL,
    description text,
    category text NOT NULL,
    location_text text NOT NULL,
    location_lat numeric,
    location_lng numeric,
    start_at timestamp with time zone NOT NULL,
    end_at timestamp with time zone NOT NULL,
    pay_type text DEFAULT 'hourly'::text NOT NULL,
    pay_amount numeric,
    positions_total integer DEFAULT 1 NOT NULL,
    positions_filled integer DEFAULT 0 NOT NULL,
    requirements text[] DEFAULT '{}'::text[],
    urgency text DEFAULT 'planned'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    boosted_until timestamp with time zone,
    posted_as_business_id uuid,
    CONSTRAINT shifts_pay_type_check CHECK ((pay_type = ANY (ARRAY['hourly'::text, 'fixed'::text, 'negotiable'::text, 'discuss'::text, 'volunteer'::text]))),
    CONSTRAINT shifts_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'open'::text, 'filled'::text, 'cancelled'::text, 'completed'::text]))),
    CONSTRAINT shifts_urgency_check CHECK ((urgency = ANY (ARRAY['asap'::text, 'today'::text, 'this_week'::text, 'planned'::text])))
);


--
-- Name: ship_positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ship_positions (
    mmsi text NOT NULL,
    ship_id uuid,
    lat double precision,
    lng double precision,
    sog numeric,
    cog numeric,
    heading numeric,
    nav_status text,
    source text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: source_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    source_type text NOT NULL,
    publisher text,
    url text,
    accessed_on date,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: source_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_document_id uuid NOT NULL,
    record_type text NOT NULL,
    external_ref text,
    source_page text,
    record_date_text text,
    raw_text text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    extraction_notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: spik_dictionary; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.spik_dictionary (
    id integer NOT NULL,
    word text NOT NULL,
    first_letter text,
    alternate_spelling text,
    pronunciation text,
    short_meaning text,
    spik_meaning text,
    example_sentence text,
    part_of_speech text,
    category text,
    usage_level text,
    era text,
    tone text,
    origin text,
    audio_url text,
    updated_at timestamp with time zone DEFAULT now(),
    contributor_name text,
    contributor_show boolean DEFAULT true,
    speaker_area text,
    notes text,
    word_status text,
    stripped_word text,
    number_letters integer,
    wirdil_hint_1 text,
    wirdil_hint_2 text,
    wirdil_hint_3 text,
    CONSTRAINT spik_dictionary_number_letters_check CHECK ((number_letters >= 0)),
    CONSTRAINT spik_dictionary_word_status_check CHECK ((word_status = ANY (ARRAY['draft'::text, 'review'::text, 'approved'::text, 'published'::text, 'archived'::text, 'duplicate'::text, 'rejected'::text])))
);


--
-- Name: spik_suggestions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.spik_suggestions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    word_id integer NOT NULL,
    word text NOT NULL,
    field_name text NOT NULL,
    field_label text NOT NULL,
    current_value text,
    suggested_value text NOT NULL,
    submitter_name text,
    show_name boolean DEFAULT true,
    status text DEFAULT 'pending'::text,
    created_at timestamp with time zone DEFAULT now(),
    reviewed_at timestamp with time zone,
    reviewer_notes text
);


--
-- Name: vessel_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vessel_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vessel_id uuid NOT NULL,
    author_id uuid,
    subject_type text DEFAULT 'general'::text NOT NULL,
    subject_row_id uuid,
    parent_comment_id uuid,
    body text NOT NULL,
    is_hidden boolean DEFAULT false NOT NULL,
    hidden_by uuid,
    hidden_reason text,
    hidden_at timestamp with time zone,
    edited_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vessel_comments_body_check CHECK (((length(TRIM(BOTH FROM body)) >= 1) AND (length(TRIM(BOTH FROM body)) <= 4000)))
);


--
-- Name: vessel_edit_votes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vessel_edit_votes (
    proposal_id uuid NOT NULL,
    user_id uuid NOT NULL,
    vote text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vessel_edit_votes_vote_check CHECK ((vote = ANY (ARRAY['confirm'::text, 'dispute'::text])))
);


--
-- Name: vessel_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vessel_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vessel_id uuid NOT NULL,
    event_type text NOT NULL,
    event_year integer,
    event_date_text text,
    description text NOT NULL,
    location text,
    confidence text DEFAULT 'probable'::text NOT NULL,
    source_record_id uuid,
    CONSTRAINT vessel_events_confidence_check CHECK ((confidence = ANY (ARRAY['confirmed'::text, 'probable'::text, 'possible'::text, 'unmatched'::text, 'conflict'::text])))
);


--
-- Name: vessel_media_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vessel_media_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vessel_id uuid NOT NULL,
    media_asset_id uuid NOT NULL,
    source_record_id uuid,
    confidence text DEFAULT 'possible'::text NOT NULL,
    notes text,
    CONSTRAINT vessel_media_links_confidence_check CHECK ((confidence = ANY (ARRAY['confirmed'::text, 'probable'::text, 'possible'::text, 'unmatched'::text, 'conflict'::text])))
);


--
-- Name: vessel_names; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vessel_names (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vessel_id uuid NOT NULL,
    name text NOT NULL,
    normalised_name text NOT NULL,
    start_year integer,
    end_year integer,
    date_text text,
    is_primary boolean DEFAULT false NOT NULL,
    confidence text DEFAULT 'probable'::text NOT NULL,
    source_record_id uuid,
    CONSTRAINT vessel_names_confidence_check CHECK ((confidence = ANY (ARRAY['confirmed'::text, 'probable'::text, 'possible'::text, 'unmatched'::text, 'conflict'::text])))
);


--
-- Name: vessel_relationships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vessel_relationships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vessel_id uuid NOT NULL,
    related_vessel_id uuid NOT NULL,
    relationship_type text NOT NULL,
    confidence text DEFAULT 'possible'::text NOT NULL,
    source_record_id uuid,
    notes text,
    CONSTRAINT vessel_relationships_confidence_check CHECK ((confidence = ANY (ARRAY['confirmed'::text, 'probable'::text, 'possible'::text, 'unmatched'::text, 'conflict'::text])))
);


--
-- Name: vessel_source_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vessel_source_links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vessel_id uuid NOT NULL,
    source_record_id uuid NOT NULL,
    confidence text NOT NULL,
    relationship_type text DEFAULT 'evidence_for_vessel'::text NOT NULL,
    notes text,
    CONSTRAINT vessel_source_links_confidence_check CHECK ((confidence = ANY (ARRAY['confirmed'::text, 'probable'::text, 'possible'::text, 'unmatched'::text, 'conflict'::text])))
);


--
-- Name: vessels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vessels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vessel_key text NOT NULL,
    canonical_name text NOT NULL,
    primary_lk_number text,
    built_year integer,
    built_decade text,
    builder text,
    yard_number text,
    hull_material text,
    country_of_build text,
    status text,
    identity_confidence text DEFAULT 'probable'::text NOT NULL,
    identity_notes text,
    source_family text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    comment_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT vessels_identity_confidence_check CHECK ((identity_confidence = ANY (ARRAY['confirmed'::text, 'probable'::text, 'possible'::text, 'unmatched'::text, 'conflict'::text])))
);


--
-- Name: vessel_search; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vessel_search AS
 SELECT v.id,
    v.canonical_name,
    v.primary_lk_number,
    v.built_year,
    v.builder,
    v.hull_material,
    v.status,
    v.identity_confidence,
    v.comment_count,
    string_agg(DISTINCT n.name, ', '::text ORDER BY n.name) AS all_names,
    string_agg(DISTINCT r.registration, ', '::text ORDER BY r.registration) AS all_registrations,
    count(DISTINCT l.source_record_id) AS source_record_count,
    count(DISTINCT ml.media_asset_id) AS media_asset_count
   FROM ((((public.vessels v
     LEFT JOIN public.vessel_names n ON ((n.vessel_id = v.id)))
     LEFT JOIN public.registrations r ON ((r.vessel_id = v.id)))
     LEFT JOIN public.vessel_source_links l ON ((l.vessel_id = v.id)))
     LEFT JOIN public.vessel_media_links ml ON ((ml.vessel_id = v.id)))
  GROUP BY v.id, v.canonical_name, v.primary_lk_number, v.built_year, v.builder, v.hull_material, v.status, v.identity_confidence, v.comment_count;


--
-- Name: vessel_timeline; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vessel_timeline AS
 SELECT e.vessel_id,
    v.canonical_name,
    e.event_year AS year,
    e.event_date_text AS date_text,
    e.event_type AS item_type,
    e.description,
    e.confidence,
    e.source_record_id
   FROM (public.vessel_events e
     JOIN public.vessels v ON ((v.id = e.vessel_id)))
UNION ALL
 SELECT r.vessel_id,
    v.canonical_name,
    COALESCE(r.start_year, r.end_year) AS year,
    r.date_text,
    'registration'::text AS item_type,
    ('Registration: '::text || r.registration) AS description,
    r.confidence,
    r.source_record_id
   FROM (public.registrations r
     JOIN public.vessels v ON ((v.id = r.vessel_id)))
UNION ALL
 SELECT n.vessel_id,
    v.canonical_name,
    COALESCE(n.start_year, n.end_year) AS year,
    n.date_text,
    'name'::text AS item_type,
    ('Name: '::text || n.name) AS description,
    n.confidence,
    n.source_record_id
   FROM (public.vessel_names n
     JOIN public.vessels v ON ((v.id = n.vessel_id)));


--
-- Name: waiting_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.waiting_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    driver_id uuid NOT NULL,
    arrived_at timestamp with time zone DEFAULT now() NOT NULL,
    collected_at timestamp with time zone,
    waiting_fee_pence integer DEFAULT 0 NOT NULL,
    customer_confirmed boolean,
    dispute_raised boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: worker_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_profiles (
    user_id uuid NOT NULL,
    headline text,
    summary text,
    skills text[] DEFAULT '{}'::text[] NOT NULL,
    qualifications text[] DEFAULT '{}'::text[] NOT NULL,
    experience jsonb DEFAULT '[]'::jsonb NOT NULL,
    desired_pay_text text,
    willing_to_relocate boolean DEFAULT false NOT NULL,
    available_from date,
    is_diaspora boolean DEFAULT false NOT NULL,
    is_public boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_config admin_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_config
    ADD CONSTRAINT admin_config_pkey PRIMARY KEY (key);


--
-- Name: application_events application_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_events
    ADD CONSTRAINT application_events_pkey PRIMARY KEY (id);


--
-- Name: book_availability_rules book_availability_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_availability_rules
    ADD CONSTRAINT book_availability_rules_pkey PRIMARY KEY (id);


--
-- Name: book_bookings book_bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_bookings
    ADD CONSTRAINT book_bookings_pkey PRIMARY KEY (id);


--
-- Name: book_gifts book_gifts_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_gifts
    ADD CONSTRAINT book_gifts_code_key UNIQUE (code);


--
-- Name: book_gifts book_gifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_gifts
    ADD CONSTRAINT book_gifts_pkey PRIMARY KEY (id);


--
-- Name: book_services book_services_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_services
    ADD CONSTRAINT book_services_pkey PRIMARY KEY (id);


--
-- Name: book_slot_overrides book_slot_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_slot_overrides
    ADD CONSTRAINT book_slot_overrides_pkey PRIMARY KEY (id);


--
-- Name: book_unit_items book_unit_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_unit_items
    ADD CONSTRAINT book_unit_items_pkey PRIMARY KEY (id);


--
-- Name: book_unit_purchases book_unit_purchases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_unit_purchases
    ADD CONSTRAINT book_unit_purchases_pkey PRIMARY KEY (id);


--
-- Name: business_addons business_addons_business_id_addon_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_addons
    ADD CONSTRAINT business_addons_business_id_addon_key_key UNIQUE (business_id, addon_key);


--
-- Name: business_addons business_addons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_addons
    ADD CONSTRAINT business_addons_pkey PRIMARY KEY (id);


--
-- Name: business_alert_access business_alert_access_business_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_alert_access
    ADD CONSTRAINT business_alert_access_business_id_key UNIQUE (business_id);


--
-- Name: business_alert_access business_alert_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_alert_access
    ADD CONSTRAINT business_alert_access_pkey PRIMARY KEY (id);


--
-- Name: business_claims business_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_claims
    ADD CONSTRAINT business_claims_pkey PRIMARY KEY (id);


--
-- Name: business_discount_grants business_discount_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_discount_grants
    ADD CONSTRAINT business_discount_grants_pkey PRIMARY KEY (id);


--
-- Name: compliance_log compliance_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compliance_log
    ADD CONSTRAINT compliance_log_pkey PRIMARY KEY (id);


--
-- Name: cruise_ships cruise_ships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cruise_ships
    ADD CONSTRAINT cruise_ships_pkey PRIMARY KEY (id);


--
-- Name: cruise_ships cruise_ships_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cruise_ships
    ADD CONSTRAINT cruise_ships_slug_key UNIQUE (slug);


--
-- Name: cruise_visits cruise_visits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cruise_visits
    ADD CONSTRAINT cruise_visits_pkey PRIMARY KEY (id);


--
-- Name: cv_documents cv_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cv_documents
    ADD CONSTRAINT cv_documents_pkey PRIMARY KEY (id);


--
-- Name: delivery_categories delivery_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_categories
    ADD CONSTRAINT delivery_categories_pkey PRIMARY KEY (id);


--
-- Name: delivery_categories delivery_categories_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_categories
    ADD CONSTRAINT delivery_categories_slug_key UNIQUE (slug);


--
-- Name: delivery_fees delivery_fees_category_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_fees
    ADD CONSTRAINT delivery_fees_category_slug_key UNIQUE (category_slug);


--
-- Name: delivery_fees delivery_fees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_fees
    ADD CONSTRAINT delivery_fees_pkey PRIMARY KEY (id);


--
-- Name: delivery_pricing_config delivery_pricing_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_pricing_config
    ADD CONSTRAINT delivery_pricing_config_pkey PRIMARY KEY (id);


--
-- Name: delivery_requests delivery_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_requests
    ADD CONSTRAINT delivery_requests_pkey PRIMARY KEY (id);


--
-- Name: driver_profiles driver_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_profiles
    ADD CONSTRAINT driver_profiles_pkey PRIMARY KEY (id);


--
-- Name: email_log email_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_log
    ADD CONSTRAINT email_log_pkey PRIMARY KEY (id);


--
-- Name: email_settings email_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_settings
    ADD CONSTRAINT email_settings_pkey PRIMARY KEY (id);


--
-- Name: email_settings email_settings_singleton_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_settings
    ADD CONSTRAINT email_settings_singleton_key UNIQUE (singleton);


--
-- Name: email_templates email_templates_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_templates
    ADD CONSTRAINT email_templates_key_key UNIQUE (key);


--
-- Name: email_templates email_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_templates
    ADD CONSTRAINT email_templates_pkey PRIMARY KEY (id);


--
-- Name: event_checkins event_checkins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_checkins
    ADD CONSTRAINT event_checkins_pkey PRIMARY KEY (id);


--
-- Name: event_ticket_orders event_ticket_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_ticket_orders
    ADD CONSTRAINT event_ticket_orders_pkey PRIMARY KEY (id);


--
-- Name: event_ticket_orders event_ticket_orders_stripe_payment_intent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_ticket_orders
    ADD CONSTRAINT event_ticket_orders_stripe_payment_intent_id_key UNIQUE (stripe_payment_intent_id);


--
-- Name: event_ticket_types event_ticket_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_ticket_types
    ADD CONSTRAINT event_ticket_types_pkey PRIMARY KEY (id);


--
-- Name: event_tickets event_tickets_backup_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_tickets
    ADD CONSTRAINT event_tickets_backup_code_key UNIQUE (backup_code);


--
-- Name: event_tickets event_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_tickets
    ADD CONSTRAINT event_tickets_pkey PRIMARY KEY (id);


--
-- Name: event_tickets event_tickets_validation_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_tickets
    ADD CONSTRAINT event_tickets_validation_token_hash_key UNIQUE (validation_token_hash);


--
-- Name: event_updates event_updates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_updates
    ADD CONSTRAINT event_updates_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: game_shetland_places game_shetland_places_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.game_shetland_places
    ADD CONSTRAINT game_shetland_places_pkey PRIMARY KEY (id);


--
-- Name: games_scores games_scores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.games_scores
    ADD CONSTRAINT games_scores_pkey PRIMARY KEY (id);


--
-- Name: games_user_stats games_user_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.games_user_stats
    ADD CONSTRAINT games_user_stats_pkey PRIMARY KEY (user_id);


--
-- Name: hub_campaigns hub_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_campaigns
    ADD CONSTRAINT hub_campaigns_pkey PRIMARY KEY (id);


--
-- Name: hub_documents hub_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_documents
    ADD CONSTRAINT hub_documents_pkey PRIMARY KEY (id);


--
-- Name: hub_donations hub_donations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_donations
    ADD CONSTRAINT hub_donations_pkey PRIMARY KEY (id);


--
-- Name: hub_donations hub_donations_stripe_payment_intent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_donations
    ADD CONSTRAINT hub_donations_stripe_payment_intent_id_key UNIQUE (stripe_payment_intent_id);


--
-- Name: hub_members hub_members_hub_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_members
    ADD CONSTRAINT hub_members_hub_id_user_id_key UNIQUE (hub_id, user_id);


--
-- Name: hub_members hub_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_members
    ADD CONSTRAINT hub_members_pkey PRIMARY KEY (id);


--
-- Name: hub_membership_types hub_membership_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_membership_types
    ADD CONSTRAINT hub_membership_types_pkey PRIMARY KEY (id);


--
-- Name: hubs hubs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hubs
    ADD CONSTRAINT hubs_pkey PRIMARY KEY (id);


--
-- Name: hubs hubs_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hubs
    ADD CONSTRAINT hubs_slug_key UNIQUE (slug);


--
-- Name: job_applications job_applications_job_id_applicant_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_applications
    ADD CONSTRAINT job_applications_job_id_applicant_id_key UNIQUE (job_id, applicant_id);


--
-- Name: job_applications job_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_applications
    ADD CONSTRAINT job_applications_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: local_boost_purchases local_boost_purchases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_boost_purchases
    ADD CONSTRAINT local_boost_purchases_pkey PRIMARY KEY (id);


--
-- Name: local_boost_purchases local_boost_purchases_stripe_payment_intent_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_boost_purchases
    ADD CONSTRAINT local_boost_purchases_stripe_payment_intent_id_key UNIQUE (stripe_payment_intent_id);


--
-- Name: local_business_codes local_business_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_business_codes
    ADD CONSTRAINT local_business_codes_pkey PRIMARY KEY (business_id);


--
-- Name: local_business_follows local_business_follows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_business_follows
    ADD CONSTRAINT local_business_follows_pkey PRIMARY KEY (user_id, business_id);


--
-- Name: local_businesses local_businesses_nfc_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_businesses
    ADD CONSTRAINT local_businesses_nfc_token_key UNIQUE (nfc_token);


--
-- Name: local_businesses local_businesses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_businesses
    ADD CONSTRAINT local_businesses_pkey PRIMARY KEY (id);


--
-- Name: local_loyalty_cards local_loyalty_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_loyalty_cards
    ADD CONSTRAINT local_loyalty_cards_pkey PRIMARY KEY (id);


--
-- Name: local_loyalty_cards local_loyalty_cards_user_id_program_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_loyalty_cards
    ADD CONSTRAINT local_loyalty_cards_user_id_program_id_key UNIQUE (user_id, program_id);


--
-- Name: local_loyalty_programs local_loyalty_programs_business_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_loyalty_programs
    ADD CONSTRAINT local_loyalty_programs_business_id_key UNIQUE (business_id);


--
-- Name: local_loyalty_programs local_loyalty_programs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_loyalty_programs
    ADD CONSTRAINT local_loyalty_programs_pkey PRIMARY KEY (id);


--
-- Name: local_loyalty_transactions local_loyalty_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_loyalty_transactions
    ADD CONSTRAINT local_loyalty_transactions_pkey PRIMARY KEY (id);


--
-- Name: local_offer_redemptions local_offer_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_offer_redemptions
    ADD CONSTRAINT local_offer_redemptions_pkey PRIMARY KEY (offer_id, user_id);


--
-- Name: local_offers local_offers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_offers
    ADD CONSTRAINT local_offers_pkey PRIMARY KEY (id);


--
-- Name: local_wallet_balances local_wallet_balances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_wallet_balances
    ADD CONSTRAINT local_wallet_balances_pkey PRIMARY KEY (user_id);


--
-- Name: local_wallet_transactions local_wallet_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_wallet_transactions
    ADD CONSTRAINT local_wallet_transactions_pkey PRIMARY KEY (id);


--
-- Name: measurements measurements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurements
    ADD CONSTRAINT measurements_pkey PRIMARY KEY (id);


--
-- Name: media_assets media_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_pkey PRIMARY KEY (id);


--
-- Name: memories memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);


--
-- Name: memory_comments memory_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_comments
    ADD CONSTRAINT memory_comments_pkey PRIMARY KEY (id);


--
-- Name: memory_image_pin_suggestions memory_image_pin_suggestions_pin_id_suggester_id_answer_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_image_pin_suggestions
    ADD CONSTRAINT memory_image_pin_suggestions_pin_id_suggester_id_answer_key UNIQUE (pin_id, suggester_id, answer);


--
-- Name: memory_image_pin_suggestions memory_image_pin_suggestions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_image_pin_suggestions
    ADD CONSTRAINT memory_image_pin_suggestions_pkey PRIMARY KEY (id);


--
-- Name: memory_image_pins memory_image_pins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_image_pins
    ADD CONSTRAINT memory_image_pins_pkey PRIMARY KEY (id);


--
-- Name: memory_media memory_media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_media
    ADD CONSTRAINT memory_media_pkey PRIMARY KEY (id);


--
-- Name: memory_reactions memory_reactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_reactions
    ADD CONSTRAINT memory_reactions_pkey PRIMARY KEY (memory_id, user_id, kind);


--
-- Name: notices notices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notices
    ADD CONSTRAINT notices_pkey PRIMARY KEY (id);


--
-- Name: notification_log notification_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_log
    ADD CONSTRAINT notification_log_pkey PRIMARY KEY (id);


--
-- Name: notification_preferences notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: oneshetland_feed oneshetland_feed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oneshetland_feed
    ADD CONSTRAINT oneshetland_feed_pkey PRIMARY KEY (id);


--
-- Name: owners owners_normalised_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owners
    ADD CONSTRAINT owners_normalised_name_key UNIQUE (normalised_name);


--
-- Name: owners owners_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.owners
    ADD CONSTRAINT owners_pkey PRIMARY KEY (id);


--
-- Name: ownership_periods ownership_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ownership_periods
    ADD CONSTRAINT ownership_periods_pkey PRIMARY KEY (id);


--
-- Name: partner_alerts partner_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_alerts
    ADD CONSTRAINT partner_alerts_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: regions regions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regions
    ADD CONSTRAINT regions_pkey PRIMARY KEY (id);


--
-- Name: regions regions_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regions
    ADD CONSTRAINT regions_slug_key UNIQUE (slug);


--
-- Name: registrations registrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registrations
    ADD CONSTRAINT registrations_pkey PRIMARY KEY (id);


--
-- Name: runs runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);


--
-- Name: saved_addresses saved_addresses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_addresses
    ADD CONSTRAINT saved_addresses_pkey PRIMARY KEY (id);


--
-- Name: saved_jobs saved_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_jobs
    ADD CONSTRAINT saved_jobs_pkey PRIMARY KEY (id);


--
-- Name: saved_jobs saved_jobs_user_id_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_jobs
    ADD CONSTRAINT saved_jobs_user_id_job_id_key UNIQUE (user_id, job_id);


--
-- Name: shift_alerts shift_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_alerts
    ADD CONSTRAINT shift_alerts_pkey PRIMARY KEY (id);


--
-- Name: shift_alerts shift_alerts_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_alerts
    ADD CONSTRAINT shift_alerts_user_id_key UNIQUE (user_id);


--
-- Name: shift_applications shift_applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_applications
    ADD CONSTRAINT shift_applications_pkey PRIMARY KEY (id);


--
-- Name: shift_applications shift_applications_shift_id_worker_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_applications
    ADD CONSTRAINT shift_applications_shift_id_worker_id_key UNIQUE (shift_id, worker_id);


--
-- Name: shift_availability shift_availability_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_availability
    ADD CONSTRAINT shift_availability_pkey PRIMARY KEY (id);


--
-- Name: shift_check_ins shift_check_ins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_check_ins
    ADD CONSTRAINT shift_check_ins_pkey PRIMARY KEY (id);


--
-- Name: shift_check_ins shift_check_ins_shift_id_worker_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_check_ins
    ADD CONSTRAINT shift_check_ins_shift_id_worker_id_key UNIQUE (shift_id, worker_id);


--
-- Name: shift_employer_profiles shift_employer_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_employer_profiles
    ADD CONSTRAINT shift_employer_profiles_pkey PRIMARY KEY (id);


--
-- Name: shift_payments shift_payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_payments
    ADD CONSTRAINT shift_payments_pkey PRIMARY KEY (id);


--
-- Name: shift_qualifications shift_qualifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_qualifications
    ADD CONSTRAINT shift_qualifications_pkey PRIMARY KEY (id);


--
-- Name: shift_reviews shift_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_reviews
    ADD CONSTRAINT shift_reviews_pkey PRIMARY KEY (id);


--
-- Name: shift_reviews shift_reviews_shift_id_reviewer_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_reviews
    ADD CONSTRAINT shift_reviews_shift_id_reviewer_id_key UNIQUE (shift_id, reviewer_id);


--
-- Name: shift_worker_profiles shift_worker_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_worker_profiles
    ADD CONSTRAINT shift_worker_profiles_pkey PRIMARY KEY (id);


--
-- Name: shifts shifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_pkey PRIMARY KEY (id);


--
-- Name: ship_positions ship_positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ship_positions
    ADD CONSTRAINT ship_positions_pkey PRIMARY KEY (mmsi);


--
-- Name: source_documents source_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_documents
    ADD CONSTRAINT source_documents_pkey PRIMARY KEY (id);


--
-- Name: source_documents source_documents_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_documents
    ADD CONSTRAINT source_documents_slug_key UNIQUE (slug);


--
-- Name: source_records source_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_records
    ADD CONSTRAINT source_records_pkey PRIMARY KEY (id);


--
-- Name: spik_dictionary spik_dictionary_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spik_dictionary
    ADD CONSTRAINT spik_dictionary_pkey PRIMARY KEY (id);


--
-- Name: spik_suggestions spik_suggestions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spik_suggestions
    ADD CONSTRAINT spik_suggestions_pkey PRIMARY KEY (id);


--
-- Name: vessel_comments vessel_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_comments
    ADD CONSTRAINT vessel_comments_pkey PRIMARY KEY (id);


--
-- Name: vessel_edit_proposals vessel_edit_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_edit_proposals
    ADD CONSTRAINT vessel_edit_proposals_pkey PRIMARY KEY (id);


--
-- Name: vessel_edit_votes vessel_edit_votes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_edit_votes
    ADD CONSTRAINT vessel_edit_votes_pkey PRIMARY KEY (proposal_id, user_id);


--
-- Name: vessel_events vessel_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_events
    ADD CONSTRAINT vessel_events_pkey PRIMARY KEY (id);


--
-- Name: vessel_media_links vessel_media_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_media_links
    ADD CONSTRAINT vessel_media_links_pkey PRIMARY KEY (id);


--
-- Name: vessel_media_links vessel_media_links_vessel_id_media_asset_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_media_links
    ADD CONSTRAINT vessel_media_links_vessel_id_media_asset_id_key UNIQUE (vessel_id, media_asset_id);


--
-- Name: vessel_names vessel_names_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_names
    ADD CONSTRAINT vessel_names_pkey PRIMARY KEY (id);


--
-- Name: vessel_relationships vessel_relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_relationships
    ADD CONSTRAINT vessel_relationships_pkey PRIMARY KEY (id);


--
-- Name: vessel_source_links vessel_source_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_source_links
    ADD CONSTRAINT vessel_source_links_pkey PRIMARY KEY (id);


--
-- Name: vessel_source_links vessel_source_links_vessel_id_source_record_id_relationship_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_source_links
    ADD CONSTRAINT vessel_source_links_vessel_id_source_record_id_relationship_key UNIQUE (vessel_id, source_record_id, relationship_type);


--
-- Name: vessels vessels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessels
    ADD CONSTRAINT vessels_pkey PRIMARY KEY (id);


--
-- Name: vessels vessels_vessel_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessels
    ADD CONSTRAINT vessels_vessel_key_key UNIQUE (vessel_key);


--
-- Name: waiting_events waiting_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waiting_events
    ADD CONSTRAINT waiting_events_pkey PRIMARY KEY (id);


--
-- Name: worker_profiles worker_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_profiles
    ADD CONSTRAINT worker_profiles_pkey PRIMARY KEY (user_id);


--
-- Name: applications_shift_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX applications_shift_idx ON public.shift_applications USING btree (shift_id);


--
-- Name: applications_worker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX applications_worker_idx ON public.shift_applications USING btree (worker_id);


--
-- Name: availability_worker_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX availability_worker_date_idx ON public.shift_availability USING btree (worker_id, date);


--
-- Name: business_addons_business_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX business_addons_business_id_idx ON public.business_addons USING btree (business_id);


--
-- Name: cruise_ships_imo_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cruise_ships_imo_uq ON public.cruise_ships USING btree (imo) WHERE (imo IS NOT NULL);


--
-- Name: cruise_ships_mmsi_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cruise_ships_mmsi_idx ON public.cruise_ships USING btree (mmsi) WHERE (mmsi IS NOT NULL);


--
-- Name: cruise_ships_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cruise_ships_name_idx ON public.cruise_ships USING btree (lower(name));


--
-- Name: cruise_visits_arrival_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cruise_visits_arrival_idx ON public.cruise_visits USING btree (arrival_at);


--
-- Name: cruise_visits_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cruise_visits_date_idx ON public.cruise_visits USING btree (visit_date);


--
-- Name: cruise_visits_ship_arrival_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX cruise_visits_ship_arrival_uq ON public.cruise_visits USING btree (ship_id, arrival_at);


--
-- Name: cruise_visits_ship_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cruise_visits_ship_idx ON public.cruise_visits USING btree (ship_id);


--
-- Name: cruise_visits_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cruise_visits_status_idx ON public.cruise_visits USING btree (status);


--
-- Name: cruise_visits_upcoming_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cruise_visits_upcoming_idx ON public.cruise_visits USING btree (arrival_at) WHERE (status = ANY (ARRAY['scheduled'::text, 'confirmed'::text, 'in_port'::text]));


--
-- Name: delivery_requests_payment_intent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX delivery_requests_payment_intent_idx ON public.delivery_requests USING btree (payment_intent_id);


--
-- Name: idx_admin_config_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_config_category ON public.admin_config USING btree (category);


--
-- Name: idx_application_events_app; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_application_events_app ON public.application_events USING btree (application_id, created_at);


--
-- Name: idx_book_avail_business_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_book_avail_business_day ON public.book_availability_rules USING btree (business_id, day_of_week) WHERE (is_active = true);


--
-- Name: idx_book_bookings_business_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_book_bookings_business_time ON public.book_bookings USING btree (business_id, starts_at);


--
-- Name: idx_book_bookings_customer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_book_bookings_customer ON public.book_bookings USING btree (customer_id, starts_at DESC);


--
-- Name: idx_book_bookings_gift; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_book_bookings_gift ON public.book_bookings USING btree (gift_id) WHERE (gift_id IS NOT NULL);


--
-- Name: idx_book_gifts_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_book_gifts_business ON public.book_gifts USING btree (business_id, created_at DESC);


--
-- Name: idx_book_gifts_claimed_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_book_gifts_claimed_by ON public.book_gifts USING btree (claimed_by_user_id);


--
-- Name: idx_book_gifts_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_book_gifts_code ON public.book_gifts USING btree (code);


--
-- Name: idx_book_gifts_purchaser; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_book_gifts_purchaser ON public.book_gifts USING btree (purchaser_id, created_at DESC);


--
-- Name: idx_book_gifts_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_book_gifts_recipient ON public.book_gifts USING btree (recipient_email);


--
-- Name: idx_book_overrides_business_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_book_overrides_business_time ON public.book_slot_overrides USING btree (business_id, starts_at);


--
-- Name: idx_book_overrides_last_min; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_book_overrides_last_min ON public.book_slot_overrides USING btree (starts_at) WHERE (type = 'last_min'::text);


--
-- Name: idx_book_services_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_book_services_business ON public.book_services USING btree (business_id) WHERE (is_active = true);


--
-- Name: idx_book_unit_items_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_book_unit_items_business ON public.book_unit_items USING btree (business_id) WHERE (is_active = true);


--
-- Name: idx_book_unit_purchases_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_book_unit_purchases_business ON public.book_unit_purchases USING btree (business_id, created_at DESC);


--
-- Name: idx_book_unit_purchases_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_book_unit_purchases_owner ON public.book_unit_purchases USING btree (owner_id, created_at DESC);


--
-- Name: idx_business_claims_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_business_claims_business ON public.business_claims USING btree (business_id);


--
-- Name: idx_business_claims_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_business_claims_pending ON public.business_claims USING btree (status) WHERE (status = 'pending'::text);


--
-- Name: idx_business_claims_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_business_claims_user ON public.business_claims USING btree (user_id);


--
-- Name: idx_checkins_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_checkins_event ON public.event_checkins USING btree (event_id);


--
-- Name: idx_checkins_ticket; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_checkins_ticket ON public.event_checkins USING btree (ticket_id);


--
-- Name: idx_compliance_event_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_compliance_event_type ON public.compliance_log USING btree (event_type, created_at DESC);


--
-- Name: idx_compliance_user_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_compliance_user_email ON public.compliance_log USING btree (user_email, created_at DESC);


--
-- Name: idx_compliance_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_compliance_user_id ON public.compliance_log USING btree (user_id, created_at DESC);


--
-- Name: idx_cv_documents_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cv_documents_user ON public.cv_documents USING btree (user_id, kind);


--
-- Name: idx_discount_grants_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_discount_grants_business ON public.business_discount_grants USING btree (business_id);


--
-- Name: idx_email_log_postmark_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_log_postmark_id ON public.email_log USING btree (postmark_id) WHERE (postmark_id IS NOT NULL);


--
-- Name: idx_email_log_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_log_recipient ON public.email_log USING btree (recipient_id, sent_at DESC);


--
-- Name: idx_email_log_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_log_template ON public.email_log USING btree (template_key, sent_at DESC);


--
-- Name: idx_email_templates_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_templates_category ON public.email_templates USING btree (category);


--
-- Name: idx_email_templates_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_templates_key ON public.email_templates USING btree (key);


--
-- Name: idx_event_tickets_backup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_tickets_backup ON public.event_tickets USING btree (backup_code);


--
-- Name: idx_event_tickets_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_tickets_event ON public.event_tickets USING btree (event_id);


--
-- Name: idx_event_tickets_holder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_tickets_holder ON public.event_tickets USING btree (holder_id);


--
-- Name: idx_event_tickets_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_tickets_order ON public.event_tickets USING btree (order_id);


--
-- Name: idx_event_tickets_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_tickets_token_hash ON public.event_tickets USING btree (validation_token_hash);


--
-- Name: idx_event_updates_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_event_updates_event ON public.event_updates USING btree (event_id);


--
-- Name: idx_events_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_business ON public.events USING btree (organiser_business_id);


--
-- Name: idx_events_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_category ON public.events USING btree (category) WHERE (NOT is_hidden);


--
-- Name: idx_events_hub; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_hub ON public.events USING btree (organiser_hub_id);


--
-- Name: idx_events_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_status ON public.events USING btree (status) WHERE (status = 'published'::text);


--
-- Name: idx_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_type ON public.vessel_events USING btree (event_type);


--
-- Name: idx_events_vessel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_vessel ON public.vessel_events USING btree (vessel_id);


--
-- Name: idx_events_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_events_year ON public.vessel_events USING btree (event_year);


--
-- Name: idx_game_shetland_places_difficulty; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_game_shetland_places_difficulty ON public.game_shetland_places USING btree (difficulty) WHERE (is_active = true);


--
-- Name: idx_game_shetland_places_region; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_game_shetland_places_region ON public.game_shetland_places USING btree (region) WHERE (is_active = true);


--
-- Name: idx_games_scores_leaderboard; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_games_scores_leaderboard ON public.games_scores USING btree (game_id, score DESC, played_at DESC);


--
-- Name: idx_games_scores_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_games_scores_recent ON public.games_scores USING btree (played_at DESC);


--
-- Name: idx_games_scores_user_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_games_scores_user_recent ON public.games_scores USING btree (user_id, played_at DESC);


--
-- Name: idx_hub_campaigns_hub; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hub_campaigns_hub ON public.hub_campaigns USING btree (hub_id);


--
-- Name: idx_hub_documents_hub; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hub_documents_hub ON public.hub_documents USING btree (hub_id);


--
-- Name: idx_hub_donations_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hub_donations_campaign ON public.hub_donations USING btree (campaign_id);


--
-- Name: idx_hub_donations_giftaid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hub_donations_giftaid ON public.hub_donations USING btree (hub_id) WHERE gift_aid;


--
-- Name: idx_hub_members_hub; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hub_members_hub ON public.hub_members USING btree (hub_id) WHERE (status = 'active'::text);


--
-- Name: idx_hub_members_paid_until; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hub_members_paid_until ON public.hub_members USING btree (paid_until) WHERE (paid_until IS NOT NULL);


--
-- Name: idx_hub_members_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hub_members_pending ON public.hub_members USING btree (hub_id) WHERE (status = 'pending'::text);


--
-- Name: idx_hub_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hub_members_user ON public.hub_members USING btree (user_id) WHERE (status = 'active'::text);


--
-- Name: idx_hub_membership_types_hub; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hub_membership_types_hub ON public.hub_membership_types USING btree (hub_id) WHERE is_active;


--
-- Name: idx_hubs_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hubs_active ON public.hubs USING btree (is_active) WHERE is_active;


--
-- Name: idx_hubs_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hubs_type ON public.hubs USING btree (type) WHERE is_active;


--
-- Name: idx_job_apps_applicant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_apps_applicant ON public.job_applications USING btree (applicant_id);


--
-- Name: idx_job_apps_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_job_apps_job ON public.job_applications USING btree (job_id, status);


--
-- Name: idx_jobs_employer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_employer ON public.jobs USING btree (employer_id);


--
-- Name: idx_jobs_featured; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_featured ON public.jobs USING btree (is_featured) WHERE (is_featured AND (NOT is_hidden));


--
-- Name: idx_jobs_locality; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_locality ON public.jobs USING btree (locality) WHERE (NOT is_hidden);


--
-- Name: idx_jobs_posted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_jobs_posted ON public.jobs USING btree (posted_at DESC) WHERE (NOT is_hidden);


--
-- Name: idx_local_boost_purchases_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_boost_purchases_business ON public.local_boost_purchases USING btree (business_id, created_at DESC);


--
-- Name: idx_local_boost_purchases_payment_intent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_boost_purchases_payment_intent ON public.local_boost_purchases USING btree (stripe_payment_intent_id) WHERE (stripe_payment_intent_id IS NOT NULL);


--
-- Name: idx_local_businesses_biz_stripe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_businesses_biz_stripe ON public.local_businesses USING btree (business_stripe_account_id) WHERE (business_stripe_account_id IS NOT NULL);


--
-- Name: idx_local_businesses_bookable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_businesses_bookable ON public.local_businesses USING btree (id) WHERE ((accepts_bookings = true) AND (is_active = true));


--
-- Name: idx_local_businesses_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_businesses_category ON public.local_businesses USING btree (category) WHERE (is_active = true);


--
-- Name: idx_local_businesses_nfc_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_businesses_nfc_token ON public.local_businesses USING btree (nfc_token) WHERE (nfc_token IS NOT NULL);


--
-- Name: idx_local_businesses_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_businesses_owner ON public.local_businesses USING btree (owner_id);


--
-- Name: idx_local_businesses_premium; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_businesses_premium ON public.local_businesses USING btree (subscription_tier, subscription_until) WHERE ((subscription_tier = 'premium'::text) AND (is_active = true));


--
-- Name: idx_local_businesses_stripe_sub; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_businesses_stripe_sub ON public.local_businesses USING btree (stripe_subscription_id) WHERE (stripe_subscription_id IS NOT NULL);


--
-- Name: idx_local_businesses_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_businesses_tags ON public.local_businesses USING gin (tags);


--
-- Name: idx_local_businesses_unclaimed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_businesses_unclaimed ON public.local_businesses USING btree (is_claimed) WHERE (is_claimed = false);


--
-- Name: idx_local_cards_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_cards_user ON public.local_loyalty_cards USING btree (user_id);


--
-- Name: idx_local_loyalty_tx_card; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_loyalty_tx_card ON public.local_loyalty_transactions USING btree (card_id);


--
-- Name: idx_local_offers_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_offers_active ON public.local_offers USING btree (valid_until) WHERE (is_active = true);


--
-- Name: idx_local_offers_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_offers_business ON public.local_offers USING btree (business_id);


--
-- Name: idx_local_wallet_transactions_business_spend; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_wallet_transactions_business_spend ON public.local_wallet_transactions USING btree (business_id, created_at DESC) WHERE (type = 'spend'::text);


--
-- Name: idx_local_wallet_tx_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_local_wallet_tx_user ON public.local_wallet_transactions USING btree (user_id, created_at DESC);


--
-- Name: idx_measurements_vessel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_measurements_vessel ON public.measurements USING btree (vessel_id);


--
-- Name: idx_media_assets_payload_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_assets_payload_gin ON public.media_assets USING gin (payload);


--
-- Name: idx_media_assets_source_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_assets_source_document ON public.media_assets USING btree (source_document_id);


--
-- Name: idx_media_assets_source_record; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_assets_source_record ON public.media_assets USING btree (source_record_id);


--
-- Name: idx_media_assets_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_assets_type ON public.media_assets USING btree (asset_type);


--
-- Name: idx_memories_author; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_author ON public.memories USING btree (author_id);


--
-- Name: idx_memories_location; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_location ON public.memories USING btree (lat, lng) WHERE ((lat IS NOT NULL) AND (is_hidden = false));


--
-- Name: idx_memories_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_parent ON public.memories USING btree (parent_id) WHERE (parent_id IS NOT NULL);


--
-- Name: idx_memories_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_recent ON public.memories USING btree (created_at DESC) WHERE ((is_hidden = false) AND (parent_id IS NULL));


--
-- Name: idx_memories_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_tags ON public.memories USING gin (tags);


--
-- Name: idx_memory_comments_memory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_comments_memory ON public.memory_comments USING btree (memory_id, created_at);


--
-- Name: idx_memory_comments_pin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_comments_pin ON public.memory_comments USING btree (image_pin_id) WHERE (image_pin_id IS NOT NULL);


--
-- Name: idx_memory_image_pins_media; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_image_pins_media ON public.memory_image_pins USING btree (media_id);


--
-- Name: idx_memory_media_memory; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_media_memory ON public.memory_media USING btree (memory_id);


--
-- Name: idx_memory_reactions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_reactions_user ON public.memory_reactions USING btree (user_id);


--
-- Name: idx_notices_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notices_campaign ON public.notices USING btree (campaign_id) WHERE (campaign_id IS NOT NULL);


--
-- Name: idx_notices_hub; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notices_hub ON public.notices USING btree (publisher_hub_id) WHERE (NOT is_hidden);


--
-- Name: idx_notices_pinned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notices_pinned ON public.notices USING btree (is_pinned) WHERE (is_pinned AND (NOT is_hidden));


--
-- Name: idx_notices_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notices_published ON public.notices USING btree (published_at DESC) WHERE (NOT is_hidden);


--
-- Name: idx_notification_log_user_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_log_user_recent ON public.notification_log USING btree (user_id, created_at DESC);


--
-- Name: idx_ownership_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ownership_owner ON public.ownership_periods USING btree (owner_id);


--
-- Name: idx_ownership_vessel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ownership_vessel ON public.ownership_periods USING btree (vessel_id);


--
-- Name: idx_pin_suggestions_pin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pin_suggestions_pin ON public.memory_image_pin_suggestions USING btree (pin_id);


--
-- Name: idx_profiles_games_handle_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_profiles_games_handle_unique ON public.profiles USING btree (lower(games_handle)) WHERE (games_handle IS NOT NULL);


--
-- Name: idx_profiles_push_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_push_token ON public.profiles USING btree (push_token) WHERE (push_token IS NOT NULL);


--
-- Name: idx_profiles_stripe_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_stripe_account ON public.profiles USING btree (stripe_account_id) WHERE (stripe_account_id IS NOT NULL);


--
-- Name: idx_registrations_port_number; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_registrations_port_number ON public.registrations USING btree (port_mark, registration_number);


--
-- Name: idx_registrations_registration; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_registrations_registration ON public.registrations USING btree (registration);


--
-- Name: idx_registrations_vessel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_registrations_vessel ON public.registrations USING btree (vessel_id);


--
-- Name: idx_shifts_posted_as_business; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shifts_posted_as_business ON public.shifts USING btree (posted_as_business_id) WHERE (posted_as_business_id IS NOT NULL);


--
-- Name: idx_source_records_document; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_records_document ON public.source_records USING btree (source_document_id);


--
-- Name: idx_source_records_payload_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_records_payload_gin ON public.source_records USING gin (payload);


--
-- Name: idx_source_records_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_records_type ON public.source_records USING btree (record_type);


--
-- Name: idx_spik_number_letters; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_spik_number_letters ON public.spik_dictionary USING btree (number_letters);


--
-- Name: idx_spik_word_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_spik_word_status ON public.spik_dictionary USING btree (word_status) WHERE (word_status = ANY (ARRAY['approved'::text, 'published'::text]));


--
-- Name: idx_ticket_orders_buyer; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_orders_buyer ON public.event_ticket_orders USING btree (buyer_id);


--
-- Name: idx_ticket_orders_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_orders_event ON public.event_ticket_orders USING btree (event_id);


--
-- Name: idx_ticket_orders_stripe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_orders_stripe ON public.event_ticket_orders USING btree (stripe_payment_intent_id);


--
-- Name: idx_ticket_types_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_types_event ON public.event_ticket_types USING btree (event_id);


--
-- Name: idx_vessel_comments_author; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vessel_comments_author ON public.vessel_comments USING btree (author_id);


--
-- Name: idx_vessel_comments_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vessel_comments_parent ON public.vessel_comments USING btree (parent_comment_id) WHERE (parent_comment_id IS NOT NULL);


--
-- Name: idx_vessel_comments_vessel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vessel_comments_vessel ON public.vessel_comments USING btree (vessel_id, created_at);


--
-- Name: idx_vessel_edit_proposals_vessel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vessel_edit_proposals_vessel ON public.vessel_edit_proposals USING btree (vessel_id, status);


--
-- Name: idx_vessel_media_links_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vessel_media_links_asset ON public.vessel_media_links USING btree (media_asset_id);


--
-- Name: idx_vessel_media_links_vessel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vessel_media_links_vessel ON public.vessel_media_links USING btree (vessel_id);


--
-- Name: idx_vessel_names_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vessel_names_name_trgm ON public.vessel_names USING gin (name public.gin_trgm_ops);


--
-- Name: idx_vessel_names_normalised; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vessel_names_normalised ON public.vessel_names USING btree (normalised_name);


--
-- Name: idx_vessel_names_vessel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vessel_names_vessel ON public.vessel_names USING btree (vessel_id);


--
-- Name: idx_vessel_source_links_record; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vessel_source_links_record ON public.vessel_source_links USING btree (source_record_id);


--
-- Name: idx_vessel_source_links_vessel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vessel_source_links_vessel ON public.vessel_source_links USING btree (vessel_id);


--
-- Name: idx_vessels_built_year; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vessels_built_year ON public.vessels USING btree (built_year);


--
-- Name: idx_vessels_lk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vessels_lk ON public.vessels USING btree (primary_lk_number);


--
-- Name: idx_vessels_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vessels_name_trgm ON public.vessels USING gin (canonical_name public.gin_trgm_ops);


--
-- Name: local_businesses_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX local_businesses_slug_idx ON public.local_businesses USING btree (slug);


--
-- Name: partner_alerts_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX partner_alerts_active_idx ON public.partner_alerts USING btree (is_active, expires_at) WHERE (is_active = true);


--
-- Name: profiles_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_role_idx ON public.profiles USING btree (role);


--
-- Name: qualifications_worker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX qualifications_worker_idx ON public.shift_qualifications USING btree (worker_id);


--
-- Name: shifts_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shifts_category_idx ON public.shifts USING btree (category);


--
-- Name: shifts_employer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shifts_employer_idx ON public.shifts USING btree (employer_id);


--
-- Name: shifts_status_start_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX shifts_status_start_idx ON public.shifts USING btree (status, start_at);


--
-- Name: ship_positions_ship_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ship_positions_ship_idx ON public.ship_positions USING btree (ship_id);


--
-- Name: ship_positions_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ship_positions_updated_idx ON public.ship_positions USING btree (updated_at);


--
-- Name: spik_first_letter_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX spik_first_letter_idx ON public.spik_dictionary USING btree (first_letter);


--
-- Name: spik_word_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX spik_word_idx ON public.spik_dictionary USING btree (word);


--
-- Name: uq_business_claims_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_business_claims_open ON public.business_claims USING btree (business_id, user_id) WHERE (status = 'pending'::text);


--
-- Name: admin_config admin_config_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER admin_config_touch_updated_at BEFORE UPDATE ON public.admin_config FOR EACH ROW EXECUTE FUNCTION public.admin_config_touch_updated_at();


--
-- Name: book_unit_purchases book_unit_purchases_decrement_stock; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER book_unit_purchases_decrement_stock AFTER INSERT ON public.book_unit_purchases FOR EACH ROW EXECUTE FUNCTION public.tg_decrement_unit_stock();


--
-- Name: compliance_log compliance_log_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER compliance_log_no_delete BEFORE DELETE ON public.compliance_log FOR EACH ROW EXECUTE FUNCTION public.compliance_log_immutable();


--
-- Name: compliance_log compliance_log_no_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER compliance_log_no_update BEFORE UPDATE ON public.compliance_log FOR EACH ROW EXECUTE FUNCTION public.compliance_log_immutable();


--
-- Name: cruise_ships cruise_ships_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cruise_ships_touch BEFORE UPDATE ON public.cruise_ships FOR EACH ROW EXECUTE FUNCTION public.cruise_touch_updated_at();


--
-- Name: cruise_visits cruise_visits_derive; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cruise_visits_derive BEFORE INSERT OR UPDATE ON public.cruise_visits FOR EACH ROW EXECUTE FUNCTION public.cruise_visit_derive();


--
-- Name: delivery_fees delivery_fees_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER delivery_fees_updated_at BEFORE UPDATE ON public.delivery_fees FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: delivery_requests delivery_requests_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER delivery_requests_updated_at BEFORE UPDATE ON public.delivery_requests FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: driver_profiles driver_profiles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER driver_profiles_updated_at BEFORE UPDATE ON public.driver_profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: profiles profiles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: runs runs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER runs_updated_at BEFORE UPDATE ON public.runs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: spik_dictionary spik_normalise_origin_usage_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER spik_normalise_origin_usage_trigger BEFORE INSERT OR UPDATE ON public.spik_dictionary FOR EACH ROW EXECUTE FUNCTION public.spik_normalise_origin_usage();


--
-- Name: spik_dictionary spik_sync_computed_fields; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER spik_sync_computed_fields BEFORE INSERT OR UPDATE OF word ON public.spik_dictionary FOR EACH ROW EXECUTE FUNCTION public.tg_spik_sync_computed_fields();


--
-- Name: job_applications tg_application_event; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_application_event AFTER INSERT OR UPDATE ON public.job_applications FOR EACH ROW EXECUTE FUNCTION public.tg_application_event();


--
-- Name: events tg_events_sync; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_events_sync BEFORE INSERT OR UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.tg_events_sync_hidden();


--
-- Name: job_applications tg_job_application_count; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_job_application_count AFTER INSERT OR DELETE ON public.job_applications FOR EACH ROW EXECUTE FUNCTION public.tg_job_application_count();


--
-- Name: job_applications tg_job_application_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_job_application_touch BEFORE INSERT OR UPDATE ON public.job_applications FOR EACH ROW EXECUTE FUNCTION public.tg_job_application_touch();


--
-- Name: jobs tg_jobs_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_jobs_touch BEFORE UPDATE ON public.jobs FOR EACH ROW EXECUTE FUNCTION public.tg_jobs_touch();


--
-- Name: local_businesses tg_local_businesses_slug; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_local_businesses_slug BEFORE INSERT ON public.local_businesses FOR EACH ROW EXECUTE FUNCTION public.tg_set_business_slug();


--
-- Name: memories tg_memory_child_count_aiud; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_memory_child_count_aiud AFTER INSERT OR DELETE ON public.memories FOR EACH ROW EXECUTE FUNCTION public.tg_memory_child_count();


--
-- Name: memory_comments tg_memory_comment_count_aiud; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_memory_comment_count_aiud AFTER INSERT OR DELETE ON public.memory_comments FOR EACH ROW EXECUTE FUNCTION public.tg_memory_comment_count();


--
-- Name: memory_media tg_memory_media_count_aiud; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_memory_media_count_aiud AFTER INSERT OR DELETE ON public.memory_media FOR EACH ROW EXECUTE FUNCTION public.tg_memory_media_count();


--
-- Name: memory_reactions tg_memory_reaction_count_aiud; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_memory_reaction_count_aiud AFTER INSERT OR DELETE ON public.memory_reactions FOR EACH ROW EXECUTE FUNCTION public.tg_memory_reaction_count();


--
-- Name: local_businesses tg_seed_business_addons; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_seed_business_addons AFTER INSERT ON public.local_businesses FOR EACH ROW EXECUTE FUNCTION public.tg_seed_business_addons();


--
-- Name: vessel_edit_proposals tg_validate_vessel_edit_bi; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_validate_vessel_edit_bi BEFORE INSERT ON public.vessel_edit_proposals FOR EACH ROW EXECUTE FUNCTION public.tg_validate_vessel_edit();


--
-- Name: vessel_comments tg_vessel_comment_count_aiud; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_vessel_comment_count_aiud AFTER INSERT OR DELETE OR UPDATE ON public.vessel_comments FOR EACH ROW EXECUTE FUNCTION public.tg_vessel_comment_count();


--
-- Name: worker_profiles tg_worker_profile_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tg_worker_profile_touch BEFORE UPDATE ON public.worker_profiles FOR EACH ROW EXECUTE FUNCTION public.tg_worker_profile_touch();


--
-- Name: hub_members trg_hub_member_join_status; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_hub_member_join_status BEFORE INSERT ON public.hub_members FOR EACH ROW EXECUTE FUNCTION public.tg_hub_member_join_status();


--
-- Name: hub_members trg_hub_members_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_hub_members_guard BEFORE UPDATE ON public.hub_members FOR EACH ROW EXECUTE FUNCTION public.tg_hub_members_guard();


--
-- Name: hubs trg_hub_owner_membership; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_hub_owner_membership AFTER INSERT ON public.hubs FOR EACH ROW EXECUTE FUNCTION public.tg_hub_owner_membership();


--
-- Name: profiles trg_profiles_lock_sensitive; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_profiles_lock_sensitive BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.tg_profiles_lock_sensitive();


--
-- Name: admin_config admin_config_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_config
    ADD CONSTRAINT admin_config_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id);


--
-- Name: application_events application_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_events
    ADD CONSTRAINT application_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: application_events application_events_application_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.application_events
    ADD CONSTRAINT application_events_application_id_fkey FOREIGN KEY (application_id) REFERENCES public.job_applications(id) ON DELETE CASCADE;


--
-- Name: book_availability_rules book_availability_rules_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_availability_rules
    ADD CONSTRAINT book_availability_rules_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: book_availability_rules book_availability_rules_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_availability_rules
    ADD CONSTRAINT book_availability_rules_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.book_services(id) ON DELETE CASCADE;


--
-- Name: book_bookings book_bookings_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_bookings
    ADD CONSTRAINT book_bookings_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: book_bookings book_bookings_cancelled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_bookings
    ADD CONSTRAINT book_bookings_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES public.profiles(id);


--
-- Name: book_bookings book_bookings_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_bookings
    ADD CONSTRAINT book_bookings_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.profiles(id);


--
-- Name: book_bookings book_bookings_gift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_bookings
    ADD CONSTRAINT book_bookings_gift_id_fkey FOREIGN KEY (gift_id) REFERENCES public.book_gifts(id) ON DELETE SET NULL;


--
-- Name: book_bookings book_bookings_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_bookings
    ADD CONSTRAINT book_bookings_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.book_services(id);


--
-- Name: book_gifts book_gifts_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_gifts
    ADD CONSTRAINT book_gifts_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: book_gifts book_gifts_claimed_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_gifts
    ADD CONSTRAINT book_gifts_claimed_by_user_id_fkey FOREIGN KEY (claimed_by_user_id) REFERENCES public.profiles(id);


--
-- Name: book_gifts book_gifts_purchaser_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_gifts
    ADD CONSTRAINT book_gifts_purchaser_id_fkey FOREIGN KEY (purchaser_id) REFERENCES public.profiles(id);


--
-- Name: book_gifts book_gifts_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_gifts
    ADD CONSTRAINT book_gifts_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.book_services(id) ON DELETE RESTRICT;


--
-- Name: book_gifts book_gifts_unit_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_gifts
    ADD CONSTRAINT book_gifts_unit_item_id_fkey FOREIGN KEY (unit_item_id) REFERENCES public.book_unit_items(id) ON DELETE RESTRICT;


--
-- Name: book_services book_services_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_services
    ADD CONSTRAINT book_services_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: book_slot_overrides book_slot_overrides_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_slot_overrides
    ADD CONSTRAINT book_slot_overrides_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: book_slot_overrides book_slot_overrides_service_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_slot_overrides
    ADD CONSTRAINT book_slot_overrides_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.book_services(id) ON DELETE CASCADE;


--
-- Name: book_unit_items book_unit_items_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_unit_items
    ADD CONSTRAINT book_unit_items_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: book_unit_purchases book_unit_purchases_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_unit_purchases
    ADD CONSTRAINT book_unit_purchases_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: book_unit_purchases book_unit_purchases_gift_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_unit_purchases
    ADD CONSTRAINT book_unit_purchases_gift_fk FOREIGN KEY (gift_id) REFERENCES public.book_gifts(id) ON DELETE SET NULL;


--
-- Name: book_unit_purchases book_unit_purchases_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_unit_purchases
    ADD CONSTRAINT book_unit_purchases_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.book_unit_items(id);


--
-- Name: book_unit_purchases book_unit_purchases_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book_unit_purchases
    ADD CONSTRAINT book_unit_purchases_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.profiles(id);


--
-- Name: business_addons business_addons_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_addons
    ADD CONSTRAINT business_addons_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: business_alert_access business_alert_access_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_alert_access
    ADD CONSTRAINT business_alert_access_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: business_alert_access business_alert_access_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_alert_access
    ADD CONSTRAINT business_alert_access_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id);


--
-- Name: business_claims business_claims_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_claims
    ADD CONSTRAINT business_claims_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: business_claims business_claims_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_claims
    ADD CONSTRAINT business_claims_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: business_claims business_claims_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_claims
    ADD CONSTRAINT business_claims_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: business_discount_grants business_discount_grants_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_discount_grants
    ADD CONSTRAINT business_discount_grants_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: business_discount_grants business_discount_grants_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_discount_grants
    ADD CONSTRAINT business_discount_grants_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: compliance_log compliance_log_email_log_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compliance_log
    ADD CONSTRAINT compliance_log_email_log_id_fkey FOREIGN KEY (email_log_id) REFERENCES public.email_log(id) ON DELETE SET NULL;


--
-- Name: compliance_log compliance_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.compliance_log
    ADD CONSTRAINT compliance_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: cruise_visits cruise_visits_ship_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cruise_visits
    ADD CONSTRAINT cruise_visits_ship_id_fkey FOREIGN KEY (ship_id) REFERENCES public.cruise_ships(id) ON DELETE SET NULL;


--
-- Name: cv_documents cv_documents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cv_documents
    ADD CONSTRAINT cv_documents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: delivery_fees delivery_fees_category_slug_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_fees
    ADD CONSTRAINT delivery_fees_category_slug_fkey FOREIGN KEY (category_slug) REFERENCES public.delivery_categories(slug) ON DELETE CASCADE;


--
-- Name: delivery_requests delivery_requests_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_requests
    ADD CONSTRAINT delivery_requests_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: delivery_requests delivery_requests_destination_region_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_requests
    ADD CONSTRAINT delivery_requests_destination_region_id_fkey FOREIGN KEY (destination_region_id) REFERENCES public.regions(id);


--
-- Name: delivery_requests delivery_requests_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delivery_requests
    ADD CONSTRAINT delivery_requests_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id);


--
-- Name: driver_profiles driver_profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.driver_profiles
    ADD CONSTRAINT driver_profiles_id_fkey FOREIGN KEY (id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: email_log email_log_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_log
    ADD CONSTRAINT email_log_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: event_checkins event_checkins_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_checkins
    ADD CONSTRAINT event_checkins_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id);


--
-- Name: event_checkins event_checkins_scanner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_checkins
    ADD CONSTRAINT event_checkins_scanner_id_fkey FOREIGN KEY (scanner_id) REFERENCES public.profiles(id);


--
-- Name: event_checkins event_checkins_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_checkins
    ADD CONSTRAINT event_checkins_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.event_tickets(id);


--
-- Name: event_ticket_orders event_ticket_orders_buyer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_ticket_orders
    ADD CONSTRAINT event_ticket_orders_buyer_id_fkey FOREIGN KEY (buyer_id) REFERENCES public.profiles(id);


--
-- Name: event_ticket_orders event_ticket_orders_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_ticket_orders
    ADD CONSTRAINT event_ticket_orders_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id);


--
-- Name: event_ticket_types event_ticket_types_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_ticket_types
    ADD CONSTRAINT event_ticket_types_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: event_tickets event_tickets_checked_in_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_tickets
    ADD CONSTRAINT event_tickets_checked_in_by_fkey FOREIGN KEY (checked_in_by) REFERENCES public.profiles(id);


--
-- Name: event_tickets event_tickets_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_tickets
    ADD CONSTRAINT event_tickets_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id);


--
-- Name: event_tickets event_tickets_holder_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_tickets
    ADD CONSTRAINT event_tickets_holder_id_fkey FOREIGN KEY (holder_id) REFERENCES public.profiles(id);


--
-- Name: event_tickets event_tickets_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_tickets
    ADD CONSTRAINT event_tickets_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.event_ticket_orders(id);


--
-- Name: event_tickets event_tickets_ticket_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_tickets
    ADD CONSTRAINT event_tickets_ticket_type_id_fkey FOREIGN KEY (ticket_type_id) REFERENCES public.event_ticket_types(id);


--
-- Name: event_updates event_updates_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_updates
    ADD CONSTRAINT event_updates_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id);


--
-- Name: event_updates event_updates_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_updates
    ADD CONSTRAINT event_updates_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: events events_calendar_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_calendar_approved_by_fkey FOREIGN KEY (calendar_approved_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: events events_organiser_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_organiser_business_id_fkey FOREIGN KEY (organiser_business_id) REFERENCES public.local_businesses(id) ON DELETE SET NULL;


--
-- Name: events events_organiser_hub_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_organiser_hub_id_fkey FOREIGN KEY (organiser_hub_id) REFERENCES public.hubs(id) ON DELETE SET NULL;


--
-- Name: events events_organiser_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_organiser_user_id_fkey FOREIGN KEY (organiser_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: games_scores games_scores_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.games_scores
    ADD CONSTRAINT games_scores_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: games_user_stats games_user_stats_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.games_user_stats
    ADD CONSTRAINT games_user_stats_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: hub_campaigns hub_campaigns_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_campaigns
    ADD CONSTRAINT hub_campaigns_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: hub_campaigns hub_campaigns_hub_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_campaigns
    ADD CONSTRAINT hub_campaigns_hub_id_fkey FOREIGN KEY (hub_id) REFERENCES public.hubs(id) ON DELETE CASCADE;


--
-- Name: hub_documents hub_documents_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_documents
    ADD CONSTRAINT hub_documents_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: hub_documents hub_documents_hub_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_documents
    ADD CONSTRAINT hub_documents_hub_id_fkey FOREIGN KEY (hub_id) REFERENCES public.hubs(id) ON DELETE CASCADE;


--
-- Name: hub_donations hub_donations_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_donations
    ADD CONSTRAINT hub_donations_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.hub_campaigns(id) ON DELETE CASCADE;


--
-- Name: hub_donations hub_donations_donor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_donations
    ADD CONSTRAINT hub_donations_donor_user_id_fkey FOREIGN KEY (donor_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: hub_donations hub_donations_hub_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_donations
    ADD CONSTRAINT hub_donations_hub_id_fkey FOREIGN KEY (hub_id) REFERENCES public.hubs(id) ON DELETE CASCADE;


--
-- Name: hub_members hub_members_hub_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_members
    ADD CONSTRAINT hub_members_hub_id_fkey FOREIGN KEY (hub_id) REFERENCES public.hubs(id) ON DELETE CASCADE;


--
-- Name: hub_members hub_members_membership_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_members
    ADD CONSTRAINT hub_members_membership_type_id_fkey FOREIGN KEY (membership_type_id) REFERENCES public.hub_membership_types(id) ON DELETE SET NULL;


--
-- Name: hub_members hub_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_members
    ADD CONSTRAINT hub_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: hub_membership_types hub_membership_types_hub_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hub_membership_types
    ADD CONSTRAINT hub_membership_types_hub_id_fkey FOREIGN KEY (hub_id) REFERENCES public.hubs(id) ON DELETE CASCADE;


--
-- Name: hubs hubs_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hubs
    ADD CONSTRAINT hubs_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: job_applications job_applications_applicant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_applications
    ADD CONSTRAINT job_applications_applicant_id_fkey FOREIGN KEY (applicant_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: job_applications job_applications_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_applications
    ADD CONSTRAINT job_applications_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: jobs jobs_employer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_employer_id_fkey FOREIGN KEY (employer_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: jobs jobs_posted_as_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_posted_as_business_id_fkey FOREIGN KEY (posted_as_business_id) REFERENCES public.local_businesses(id) ON DELETE SET NULL;


--
-- Name: local_boost_purchases local_boost_purchases_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_boost_purchases
    ADD CONSTRAINT local_boost_purchases_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: local_boost_purchases local_boost_purchases_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_boost_purchases
    ADD CONSTRAINT local_boost_purchases_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.profiles(id);


--
-- Name: local_business_codes local_business_codes_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_business_codes
    ADD CONSTRAINT local_business_codes_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: local_business_follows local_business_follows_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_business_follows
    ADD CONSTRAINT local_business_follows_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: local_business_follows local_business_follows_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_business_follows
    ADD CONSTRAINT local_business_follows_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: local_businesses local_businesses_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_businesses
    ADD CONSTRAINT local_businesses_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: local_loyalty_cards local_loyalty_cards_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_loyalty_cards
    ADD CONSTRAINT local_loyalty_cards_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: local_loyalty_cards local_loyalty_cards_program_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_loyalty_cards
    ADD CONSTRAINT local_loyalty_cards_program_id_fkey FOREIGN KEY (program_id) REFERENCES public.local_loyalty_programs(id) ON DELETE CASCADE;


--
-- Name: local_loyalty_cards local_loyalty_cards_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_loyalty_cards
    ADD CONSTRAINT local_loyalty_cards_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: local_loyalty_programs local_loyalty_programs_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_loyalty_programs
    ADD CONSTRAINT local_loyalty_programs_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: local_loyalty_transactions local_loyalty_transactions_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_loyalty_transactions
    ADD CONSTRAINT local_loyalty_transactions_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: local_loyalty_transactions local_loyalty_transactions_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_loyalty_transactions
    ADD CONSTRAINT local_loyalty_transactions_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.local_loyalty_cards(id) ON DELETE CASCADE;


--
-- Name: local_loyalty_transactions local_loyalty_transactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_loyalty_transactions
    ADD CONSTRAINT local_loyalty_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: local_offer_redemptions local_offer_redemptions_offer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_offer_redemptions
    ADD CONSTRAINT local_offer_redemptions_offer_id_fkey FOREIGN KEY (offer_id) REFERENCES public.local_offers(id) ON DELETE CASCADE;


--
-- Name: local_offer_redemptions local_offer_redemptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_offer_redemptions
    ADD CONSTRAINT local_offer_redemptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: local_offers local_offers_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_offers
    ADD CONSTRAINT local_offers_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: local_wallet_balances local_wallet_balances_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_wallet_balances
    ADD CONSTRAINT local_wallet_balances_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: local_wallet_transactions local_wallet_transactions_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_wallet_transactions
    ADD CONSTRAINT local_wallet_transactions_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id);


--
-- Name: local_wallet_transactions local_wallet_transactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.local_wallet_transactions
    ADD CONSTRAINT local_wallet_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: measurements measurements_source_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurements
    ADD CONSTRAINT measurements_source_record_id_fkey FOREIGN KEY (source_record_id) REFERENCES public.source_records(id) ON DELETE SET NULL;


--
-- Name: measurements measurements_vessel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.measurements
    ADD CONSTRAINT measurements_vessel_id_fkey FOREIGN KEY (vessel_id) REFERENCES public.vessels(id) ON DELETE CASCADE;


--
-- Name: media_assets media_assets_source_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_source_document_id_fkey FOREIGN KEY (source_document_id) REFERENCES public.source_documents(id) ON DELETE RESTRICT;


--
-- Name: media_assets media_assets_source_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_assets
    ADD CONSTRAINT media_assets_source_record_id_fkey FOREIGN KEY (source_record_id) REFERENCES public.source_records(id) ON DELETE SET NULL;


--
-- Name: memories memories_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: memories memories_hidden_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_hidden_by_fkey FOREIGN KEY (hidden_by) REFERENCES public.profiles(id);


--
-- Name: memories memories_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.memories(id) ON DELETE CASCADE;


--
-- Name: memory_comments memory_comments_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_comments
    ADD CONSTRAINT memory_comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: memory_comments memory_comments_image_pin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_comments
    ADD CONSTRAINT memory_comments_image_pin_id_fkey FOREIGN KEY (image_pin_id) REFERENCES public.memory_image_pins(id) ON DELETE SET NULL;


--
-- Name: memory_comments memory_comments_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_comments
    ADD CONSTRAINT memory_comments_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id) ON DELETE CASCADE;


--
-- Name: memory_image_pin_suggestions memory_image_pin_suggestions_pin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_image_pin_suggestions
    ADD CONSTRAINT memory_image_pin_suggestions_pin_id_fkey FOREIGN KEY (pin_id) REFERENCES public.memory_image_pins(id) ON DELETE CASCADE;


--
-- Name: memory_image_pin_suggestions memory_image_pin_suggestions_suggester_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_image_pin_suggestions
    ADD CONSTRAINT memory_image_pin_suggestions_suggester_id_fkey FOREIGN KEY (suggester_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: memory_image_pins memory_image_pins_accepted_suggestion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_image_pins
    ADD CONSTRAINT memory_image_pins_accepted_suggestion_id_fkey FOREIGN KEY (accepted_suggestion_id) REFERENCES public.memory_image_pin_suggestions(id) ON DELETE SET NULL;


--
-- Name: memory_image_pins memory_image_pins_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_image_pins
    ADD CONSTRAINT memory_image_pins_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: memory_image_pins memory_image_pins_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_image_pins
    ADD CONSTRAINT memory_image_pins_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.memory_media(id) ON DELETE CASCADE;


--
-- Name: memory_image_pins memory_image_pins_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_image_pins
    ADD CONSTRAINT memory_image_pins_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.profiles(id);


--
-- Name: memory_media memory_media_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_media
    ADD CONSTRAINT memory_media_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id) ON DELETE CASCADE;


--
-- Name: memory_media memory_media_uploader_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_media
    ADD CONSTRAINT memory_media_uploader_id_fkey FOREIGN KEY (uploader_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: memory_reactions memory_reactions_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_reactions
    ADD CONSTRAINT memory_reactions_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.memories(id) ON DELETE CASCADE;


--
-- Name: memory_reactions memory_reactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_reactions
    ADD CONSTRAINT memory_reactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: notices notices_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notices
    ADD CONSTRAINT notices_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.hub_campaigns(id) ON DELETE CASCADE;


--
-- Name: notices notices_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notices
    ADD CONSTRAINT notices_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;


--
-- Name: notices notices_publisher_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notices
    ADD CONSTRAINT notices_publisher_business_id_fkey FOREIGN KEY (publisher_business_id) REFERENCES public.local_businesses(id) ON DELETE SET NULL;


--
-- Name: notices notices_publisher_hub_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notices
    ADD CONSTRAINT notices_publisher_hub_id_fkey FOREIGN KEY (publisher_hub_id) REFERENCES public.hubs(id) ON DELETE CASCADE;


--
-- Name: notices notices_publisher_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notices
    ADD CONSTRAINT notices_publisher_user_id_fkey FOREIGN KEY (publisher_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: notification_log notification_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_log
    ADD CONSTRAINT notification_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: notification_preferences notification_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: ownership_periods ownership_periods_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ownership_periods
    ADD CONSTRAINT ownership_periods_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.owners(id) ON DELETE RESTRICT;


--
-- Name: ownership_periods ownership_periods_source_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ownership_periods
    ADD CONSTRAINT ownership_periods_source_record_id_fkey FOREIGN KEY (source_record_id) REFERENCES public.source_records(id) ON DELETE SET NULL;


--
-- Name: ownership_periods ownership_periods_vessel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ownership_periods
    ADD CONSTRAINT ownership_periods_vessel_id_fkey FOREIGN KEY (vessel_id) REFERENCES public.vessels(id) ON DELETE CASCADE;


--
-- Name: partner_alerts partner_alerts_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_alerts
    ADD CONSTRAINT partner_alerts_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.local_businesses(id) ON DELETE CASCADE;


--
-- Name: partner_alerts partner_alerts_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_alerts
    ADD CONSTRAINT partner_alerts_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: registrations registrations_source_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registrations
    ADD CONSTRAINT registrations_source_record_id_fkey FOREIGN KEY (source_record_id) REFERENCES public.source_records(id) ON DELETE SET NULL;


--
-- Name: registrations registrations_vessel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.registrations
    ADD CONSTRAINT registrations_vessel_id_fkey FOREIGN KEY (vessel_id) REFERENCES public.vessels(id) ON DELETE CASCADE;


--
-- Name: runs runs_destination_region_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_destination_region_id_fkey FOREIGN KEY (destination_region_id) REFERENCES public.regions(id);


--
-- Name: runs runs_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: runs runs_origin_region_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_origin_region_id_fkey FOREIGN KEY (origin_region_id) REFERENCES public.regions(id);


--
-- Name: saved_addresses saved_addresses_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_addresses
    ADD CONSTRAINT saved_addresses_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: saved_jobs saved_jobs_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_jobs
    ADD CONSTRAINT saved_jobs_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE CASCADE;


--
-- Name: saved_jobs saved_jobs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_jobs
    ADD CONSTRAINT saved_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: shift_alerts shift_alerts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_alerts
    ADD CONSTRAINT shift_alerts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: shift_applications shift_applications_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_applications
    ADD CONSTRAINT shift_applications_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.shifts(id) ON DELETE CASCADE;


--
-- Name: shift_applications shift_applications_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_applications
    ADD CONSTRAINT shift_applications_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: shift_availability shift_availability_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_availability
    ADD CONSTRAINT shift_availability_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: shift_check_ins shift_check_ins_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_check_ins
    ADD CONSTRAINT shift_check_ins_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.shifts(id) ON DELETE CASCADE;


--
-- Name: shift_check_ins shift_check_ins_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_check_ins
    ADD CONSTRAINT shift_check_ins_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: shift_employer_profiles shift_employer_profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_employer_profiles
    ADD CONSTRAINT shift_employer_profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: shift_payments shift_payments_employer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_payments
    ADD CONSTRAINT shift_payments_employer_id_fkey FOREIGN KEY (employer_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: shift_payments shift_payments_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_payments
    ADD CONSTRAINT shift_payments_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.shifts(id) ON DELETE CASCADE;


--
-- Name: shift_payments shift_payments_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_payments
    ADD CONSTRAINT shift_payments_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: shift_qualifications shift_qualifications_worker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_qualifications
    ADD CONSTRAINT shift_qualifications_worker_id_fkey FOREIGN KEY (worker_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: shift_reviews shift_reviews_reviewee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_reviews
    ADD CONSTRAINT shift_reviews_reviewee_id_fkey FOREIGN KEY (reviewee_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: shift_reviews shift_reviews_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_reviews
    ADD CONSTRAINT shift_reviews_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: shift_reviews shift_reviews_shift_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_reviews
    ADD CONSTRAINT shift_reviews_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES public.shifts(id) ON DELETE CASCADE;


--
-- Name: shift_worker_profiles shift_worker_profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shift_worker_profiles
    ADD CONSTRAINT shift_worker_profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: shifts shifts_employer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_employer_id_fkey FOREIGN KEY (employer_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: shifts shifts_posted_as_business_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shifts
    ADD CONSTRAINT shifts_posted_as_business_id_fkey FOREIGN KEY (posted_as_business_id) REFERENCES public.local_businesses(id) ON DELETE SET NULL;


--
-- Name: ship_positions ship_positions_ship_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ship_positions
    ADD CONSTRAINT ship_positions_ship_id_fkey FOREIGN KEY (ship_id) REFERENCES public.cruise_ships(id) ON DELETE SET NULL;


--
-- Name: source_records source_records_source_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_records
    ADD CONSTRAINT source_records_source_document_id_fkey FOREIGN KEY (source_document_id) REFERENCES public.source_documents(id) ON DELETE RESTRICT;


--
-- Name: vessel_comments vessel_comments_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_comments
    ADD CONSTRAINT vessel_comments_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: vessel_comments vessel_comments_hidden_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_comments
    ADD CONSTRAINT vessel_comments_hidden_by_fkey FOREIGN KEY (hidden_by) REFERENCES public.profiles(id);


--
-- Name: vessel_comments vessel_comments_parent_comment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_comments
    ADD CONSTRAINT vessel_comments_parent_comment_id_fkey FOREIGN KEY (parent_comment_id) REFERENCES public.vessel_comments(id) ON DELETE CASCADE;


--
-- Name: vessel_comments vessel_comments_vessel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_comments
    ADD CONSTRAINT vessel_comments_vessel_id_fkey FOREIGN KEY (vessel_id) REFERENCES public.vessels(id) ON DELETE CASCADE;


--
-- Name: vessel_edit_proposals vessel_edit_proposals_proposed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_edit_proposals
    ADD CONSTRAINT vessel_edit_proposals_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: vessel_edit_proposals vessel_edit_proposals_vessel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_edit_proposals
    ADD CONSTRAINT vessel_edit_proposals_vessel_id_fkey FOREIGN KEY (vessel_id) REFERENCES public.vessels(id) ON DELETE CASCADE;


--
-- Name: vessel_edit_votes vessel_edit_votes_proposal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_edit_votes
    ADD CONSTRAINT vessel_edit_votes_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES public.vessel_edit_proposals(id) ON DELETE CASCADE;


--
-- Name: vessel_edit_votes vessel_edit_votes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_edit_votes
    ADD CONSTRAINT vessel_edit_votes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: vessel_events vessel_events_source_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_events
    ADD CONSTRAINT vessel_events_source_record_id_fkey FOREIGN KEY (source_record_id) REFERENCES public.source_records(id) ON DELETE SET NULL;


--
-- Name: vessel_events vessel_events_vessel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_events
    ADD CONSTRAINT vessel_events_vessel_id_fkey FOREIGN KEY (vessel_id) REFERENCES public.vessels(id) ON DELETE CASCADE;


--
-- Name: vessel_media_links vessel_media_links_media_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_media_links
    ADD CONSTRAINT vessel_media_links_media_asset_id_fkey FOREIGN KEY (media_asset_id) REFERENCES public.media_assets(id) ON DELETE CASCADE;


--
-- Name: vessel_media_links vessel_media_links_source_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_media_links
    ADD CONSTRAINT vessel_media_links_source_record_id_fkey FOREIGN KEY (source_record_id) REFERENCES public.source_records(id) ON DELETE SET NULL;


--
-- Name: vessel_media_links vessel_media_links_vessel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_media_links
    ADD CONSTRAINT vessel_media_links_vessel_id_fkey FOREIGN KEY (vessel_id) REFERENCES public.vessels(id) ON DELETE CASCADE;


--
-- Name: vessel_names vessel_names_source_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_names
    ADD CONSTRAINT vessel_names_source_record_id_fkey FOREIGN KEY (source_record_id) REFERENCES public.source_records(id) ON DELETE SET NULL;


--
-- Name: vessel_names vessel_names_vessel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_names
    ADD CONSTRAINT vessel_names_vessel_id_fkey FOREIGN KEY (vessel_id) REFERENCES public.vessels(id) ON DELETE CASCADE;


--
-- Name: vessel_relationships vessel_relationships_related_vessel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_relationships
    ADD CONSTRAINT vessel_relationships_related_vessel_id_fkey FOREIGN KEY (related_vessel_id) REFERENCES public.vessels(id) ON DELETE CASCADE;


--
-- Name: vessel_relationships vessel_relationships_source_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_relationships
    ADD CONSTRAINT vessel_relationships_source_record_id_fkey FOREIGN KEY (source_record_id) REFERENCES public.source_records(id) ON DELETE SET NULL;


--
-- Name: vessel_relationships vessel_relationships_vessel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_relationships
    ADD CONSTRAINT vessel_relationships_vessel_id_fkey FOREIGN KEY (vessel_id) REFERENCES public.vessels(id) ON DELETE CASCADE;


--
-- Name: vessel_source_links vessel_source_links_source_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_source_links
    ADD CONSTRAINT vessel_source_links_source_record_id_fkey FOREIGN KEY (source_record_id) REFERENCES public.source_records(id) ON DELETE CASCADE;


--
-- Name: vessel_source_links vessel_source_links_vessel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vessel_source_links
    ADD CONSTRAINT vessel_source_links_vessel_id_fkey FOREIGN KEY (vessel_id) REFERENCES public.vessels(id) ON DELETE CASCADE;


--
-- Name: waiting_events waiting_events_driver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waiting_events
    ADD CONSTRAINT waiting_events_driver_id_fkey FOREIGN KEY (driver_id) REFERENCES public.profiles(id);


--
-- Name: waiting_events waiting_events_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waiting_events
    ADD CONSTRAINT waiting_events_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.delivery_requests(id) ON DELETE CASCADE;


--
-- Name: worker_profiles worker_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_profiles
    ADD CONSTRAINT worker_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: delivery_requests Admins can manage all requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage all requests" ON public.delivery_requests USING ((public.get_my_role() = 'admin'::text));


--
-- Name: runs Admins can manage all runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage all runs" ON public.runs USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: waiting_events Admins can manage all waiting events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage all waiting events" ON public.waiting_events USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: delivery_categories Admins can manage delivery categories; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage delivery categories" ON public.delivery_categories USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: delivery_fees Admins can manage delivery fees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage delivery fees" ON public.delivery_fees USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: regions Admins can manage regions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage regions" ON public.regions USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: driver_profiles Admins can read all driver profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can read all driver profiles" ON public.driver_profiles FOR SELECT USING ((public.get_my_role() = 'admin'::text));


--
-- Name: profiles Admins can read all profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can read all profiles" ON public.profiles FOR SELECT USING (public.is_admin());


--
-- Name: runs Admins can read all runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can read all runs" ON public.runs FOR SELECT USING ((public.get_my_role() = 'admin'::text));


--
-- Name: driver_profiles Admins can update all driver profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update all driver profiles" ON public.driver_profiles FOR UPDATE USING ((public.get_my_role() = 'admin'::text));


--
-- Name: runs Admins can update all runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update all runs" ON public.runs FOR UPDATE USING ((public.get_my_role() = 'admin'::text));


--
-- Name: admin_config Admins manage config; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage config" ON public.admin_config USING ((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)) WITH CHECK ((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text));


--
-- Name: business_discount_grants Admins manage discount grants; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage discount grants" ON public.business_discount_grants USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: email_settings Admins manage email settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage email settings" ON public.email_settings USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: email_templates Admins manage email templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage email templates" ON public.email_templates USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: game_shetland_places Admins manage places; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage places" ON public.game_shetland_places USING ((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text)) WITH CHECK ((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text));


--
-- Name: business_claims Admins read all claims; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins read all claims" ON public.business_claims FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: admin_config Admins read config; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins read config" ON public.admin_config FOR SELECT USING ((( SELECT profiles.role
   FROM public.profiles
  WHERE (profiles.id = auth.uid())) = 'admin'::text));


--
-- Name: email_log Admins see all email logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins see all email logs" ON public.email_log FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: business_claims Admins update claims; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins update claims" ON public.business_claims FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: compliance_log Admins view all compliance records; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins view all compliance records" ON public.compliance_log FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: game_shetland_places Anyone authed can read active places; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone authed can read active places" ON public.game_shetland_places FOR SELECT USING ((is_active = true));


--
-- Name: local_businesses Anyone can read active businesses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can read active businesses" ON public.local_businesses FOR SELECT USING (((is_active = true) OR (owner_id = auth.uid())));


--
-- Name: local_loyalty_programs Anyone can read active loyalty programs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can read active loyalty programs" ON public.local_loyalty_programs FOR SELECT USING ((is_active = true));


--
-- Name: local_offers Anyone can read active offers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can read active offers" ON public.local_offers FOR SELECT USING (((is_active = true) OR (business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid())))));


--
-- Name: book_services Anyone can read active services; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can read active services" ON public.book_services FOR SELECT USING (((is_active = true) OR (business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid())))));


--
-- Name: book_unit_items Anyone can read active unit items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can read active unit items" ON public.book_unit_items FOR SELECT USING (((is_active = true) OR (business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid())))));


--
-- Name: book_availability_rules Anyone can read availability rules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can read availability rules" ON public.book_availability_rules FOR SELECT USING (true);


--
-- Name: book_slot_overrides Anyone can read overrides; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can read overrides" ON public.book_slot_overrides FOR SELECT USING (true);


--
-- Name: games_scores Anyone can read scores; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can read scores" ON public.games_scores FOR SELECT USING (true);


--
-- Name: games_user_stats Anyone can read user stats (for leaderboards); Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can read user stats (for leaderboards)" ON public.games_user_stats FOR SELECT USING (true);


--
-- Name: delivery_requests Approved drivers can accept pending requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Approved drivers can accept pending requests" ON public.delivery_requests FOR UPDATE USING (((status = 'pending'::text) AND (EXISTS ( SELECT 1
   FROM public.driver_profiles dp
  WHERE ((dp.id = auth.uid()) AND (dp.driver_status = 'approved'::text)))))) WITH CHECK ((status = ANY (ARRAY['matched'::text, 'collected'::text, 'delivered'::text])));


--
-- Name: runs Approved drivers can create runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Approved drivers can create runs" ON public.runs FOR INSERT WITH CHECK (((auth.uid() = driver_id) AND (EXISTS ( SELECT 1
   FROM public.driver_profiles dp
  WHERE ((dp.id = auth.uid()) AND (dp.driver_status = 'approved'::text))))));


--
-- Name: delivery_requests Approved drivers can read all pending requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Approved drivers can read all pending requests" ON public.delivery_requests FOR SELECT USING (((status = 'pending'::text) AND (EXISTS ( SELECT 1
   FROM public.driver_profiles dp
  WHERE ((dp.id = auth.uid()) AND (dp.driver_status = 'approved'::text))))));


--
-- Name: delivery_requests Approved drivers can read pending requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Approved drivers can read pending requests" ON public.delivery_requests FOR SELECT USING (((status = 'pending'::text) AND (EXISTS ( SELECT 1
   FROM public.driver_profiles dp
  WHERE ((dp.id = auth.uid()) AND (dp.driver_status = 'approved'::text))))));


--
-- Name: delivery_requests Authenticated users can create requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can create requests" ON public.delivery_requests FOR INSERT WITH CHECK ((auth.uid() = customer_id));


--
-- Name: local_offers Business owners can manage their offers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business owners can manage their offers" ON public.local_offers USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid())))) WITH CHECK ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: local_loyalty_programs Business owners can manage their program; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business owners can manage their program" ON public.local_loyalty_programs USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid())))) WITH CHECK ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: local_business_codes Business owners can refresh their code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business owners can refresh their code" ON public.local_business_codes USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid())))) WITH CHECK ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: local_business_follows Business owners can see followers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business owners can see followers" ON public.local_business_follows FOR SELECT USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: book_availability_rules Business owners manage their availability; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business owners manage their availability" ON public.book_availability_rules USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid())))) WITH CHECK ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: book_slot_overrides Business owners manage their overrides; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business owners manage their overrides" ON public.book_slot_overrides USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid())))) WITH CHECK ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: book_services Business owners manage their services; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business owners manage their services" ON public.book_services USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid())))) WITH CHECK ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: book_unit_items Business owners manage their unit items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business owners manage their unit items" ON public.book_unit_items USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid())))) WITH CHECK ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: local_business_codes Business owners read their own code; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business owners read their own code" ON public.local_business_codes FOR SELECT USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: book_bookings Business owners see bookings for their business; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business owners see bookings for their business" ON public.book_bookings FOR SELECT USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: local_loyalty_cards Business owners see cards for their business; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business owners see cards for their business" ON public.local_loyalty_cards FOR SELECT USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: local_offer_redemptions Business owners see redemptions for their offers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business owners see redemptions for their offers" ON public.local_offer_redemptions FOR SELECT USING ((offer_id IN ( SELECT local_offers.id
   FROM public.local_offers
  WHERE (local_offers.business_id IN ( SELECT local_businesses.id
           FROM public.local_businesses
          WHERE (local_businesses.owner_id = auth.uid()))))));


--
-- Name: local_loyalty_transactions Business owners see their loyalty transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business owners see their loyalty transactions" ON public.local_loyalty_transactions FOR SELECT USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: local_wallet_transactions Business owners see their wallet transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business owners see their wallet transactions" ON public.local_wallet_transactions FOR SELECT USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: book_bookings Business owners update bookings for their business; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Business owners update bookings for their business" ON public.book_bookings FOR UPDATE USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: book_unit_purchases Businesses redeem uses on their items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Businesses redeem uses on their items" ON public.book_unit_purchases FOR UPDATE USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid())))) WITH CHECK ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: book_gifts Businesses see gifts for their items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Businesses see gifts for their items" ON public.book_gifts FOR SELECT USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: book_unit_purchases Businesses see purchases of their items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Businesses see purchases of their items" ON public.book_unit_purchases FOR SELECT USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: book_gifts Claimers see gifts they've claimed; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Claimers see gifts they've claimed" ON public.book_gifts FOR SELECT USING ((claimed_by_user_id = auth.uid()));


--
-- Name: delivery_requests Customers can read their own requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Customers can read their own requests" ON public.delivery_requests FOR SELECT USING ((auth.uid() = customer_id));


--
-- Name: profiles Customers can update own payment flag; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Customers can update own payment flag" ON public.profiles FOR UPDATE USING ((auth.uid() = id)) WITH CHECK ((auth.uid() = id));


--
-- Name: waiting_events Customers can view waiting events for their requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Customers can view waiting events for their requests" ON public.waiting_events FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.delivery_requests dr
  WHERE ((dr.id = waiting_events.request_id) AND (dr.customer_id = auth.uid())))));


--
-- Name: book_bookings Customers create their own bookings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Customers create their own bookings" ON public.book_bookings FOR INSERT WITH CHECK ((customer_id = auth.uid()));


--
-- Name: book_bookings Customers see their own bookings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Customers see their own bookings" ON public.book_bookings FOR SELECT USING ((customer_id = auth.uid()));


--
-- Name: book_bookings Customers update their own bookings (e.g. cancel); Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Customers update their own bookings (e.g. cancel)" ON public.book_bookings FOR UPDATE USING ((customer_id = auth.uid()));


--
-- Name: delivery_categories Delivery categories are publicly readable; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Delivery categories are publicly readable" ON public.delivery_categories FOR SELECT USING (true);


--
-- Name: delivery_fees Delivery fees are publicly readable; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Delivery fees are publicly readable" ON public.delivery_fees FOR SELECT USING (true);


--
-- Name: delivery_requests Drivers can accept pending requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can accept pending requests" ON public.delivery_requests FOR UPDATE USING ((status = 'pending'::text)) WITH CHECK (((status = 'matched'::text) AND (run_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.runs r
  WHERE ((r.id = delivery_requests.run_id) AND (r.driver_id = auth.uid()))))));


--
-- Name: waiting_events Drivers can insert their own waiting events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can insert their own waiting events" ON public.waiting_events FOR INSERT WITH CHECK ((auth.uid() = driver_id));


--
-- Name: delivery_requests Drivers can read requests on their runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can read requests on their runs" ON public.delivery_requests FOR SELECT USING (((run_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.runs r
  WHERE ((r.id = delivery_requests.run_id) AND (r.driver_id = auth.uid()))))));


--
-- Name: driver_profiles Drivers can read their own driver profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can read their own driver profile" ON public.driver_profiles FOR SELECT USING ((auth.uid() = id));


--
-- Name: runs Drivers can read their own runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can read their own runs" ON public.runs FOR SELECT USING ((auth.uid() = driver_id));


--
-- Name: waiting_events Drivers can read their own waiting events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can read their own waiting events" ON public.waiting_events FOR SELECT USING ((auth.uid() = driver_id));


--
-- Name: delivery_requests Drivers can update matched requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can update matched requests" ON public.delivery_requests FOR UPDATE USING (((status = ANY (ARRAY['matched'::text, 'collected'::text])) AND (EXISTS ( SELECT 1
   FROM public.runs r
  WHERE ((r.id = delivery_requests.run_id) AND (r.driver_id = auth.uid()))))));


--
-- Name: delivery_requests Drivers can update status of their matched requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can update status of their matched requests" ON public.delivery_requests FOR UPDATE USING (((run_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.runs r
  WHERE ((r.id = delivery_requests.run_id) AND (r.driver_id = auth.uid())))))) WITH CHECK ((status = ANY (ARRAY['matched'::text, 'collected'::text, 'delivered'::text, 'cancelled'::text])));


--
-- Name: driver_profiles Drivers can update their own driver profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can update their own driver profile" ON public.driver_profiles FOR UPDATE USING ((auth.uid() = id));


--
-- Name: runs Drivers can update their own runs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can update their own runs" ON public.runs FOR UPDATE USING ((auth.uid() = driver_id));


--
-- Name: waiting_events Drivers can update their own waiting events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers can update their own waiting events" ON public.waiting_events FOR UPDATE USING ((auth.uid() = driver_id));


--
-- Name: delivery_requests Drivers must have bank connected to accept requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Drivers must have bank connected to accept requests" ON public.delivery_requests FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.driver_profiles dp
  WHERE ((dp.id = auth.uid()) AND (dp.stripe_onboarding_complete = true) AND (dp.stripe_payouts_enabled = true)))));


--
-- Name: runs Open runs are publicly readable; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Open runs are publicly readable" ON public.runs FOR SELECT USING ((status = 'open'::text));


--
-- Name: local_businesses Owners can insert their own business; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners can insert their own business" ON public.local_businesses FOR INSERT WITH CHECK ((owner_id = auth.uid()));


--
-- Name: local_businesses Owners can update their own business; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners can update their own business" ON public.local_businesses FOR UPDATE USING ((owner_id = auth.uid()));


--
-- Name: business_discount_grants Owners read their discount grants; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners read their discount grants" ON public.business_discount_grants FOR SELECT USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: local_boost_purchases Owners see their own boost purchases; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners see their own boost purchases" ON public.local_boost_purchases FOR SELECT USING ((owner_id = auth.uid()));


--
-- Name: book_unit_purchases Owners see their unit purchases; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Owners see their unit purchases" ON public.book_unit_purchases FOR SELECT USING ((owner_id = auth.uid()));


--
-- Name: delivery_pricing_config Pricing config is publicly readable; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Pricing config is publicly readable" ON public.delivery_pricing_config FOR SELECT USING (true);


--
-- Name: oneshetland_feed Public feed is readable by everyone; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public feed is readable by everyone" ON public.oneshetland_feed FOR SELECT USING (true);


--
-- Name: book_gifts Purchasers see their gifts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Purchasers see their gifts" ON public.book_gifts FOR SELECT USING ((purchaser_id = auth.uid()));


--
-- Name: regions Regions are publicly readable; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Regions are publicly readable" ON public.regions FOR SELECT USING (true);


--
-- Name: email_log Service role full access to email_log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access to email_log" ON public.email_log USING (true);


--
-- Name: email_settings Service role full access to email_settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access to email_settings" ON public.email_settings USING (true);


--
-- Name: email_templates Service role full access to email_templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role full access to email_templates" ON public.email_templates USING (true);


--
-- Name: shift_alerts Service role reads all alerts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role reads all alerts" ON public.shift_alerts FOR SELECT USING (true);


--
-- Name: driver_profiles Users can insert their own driver profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own driver profile" ON public.driver_profiles FOR INSERT WITH CHECK ((auth.uid() = id));


--
-- Name: games_scores Users can insert their own scores; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own scores" ON public.games_scores FOR INSERT WITH CHECK ((user_id = auth.uid()));


--
-- Name: saved_addresses Users can manage their own saved addresses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage their own saved addresses" ON public.saved_addresses USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: profiles Users can read their own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read their own profile" ON public.profiles FOR SELECT USING ((auth.uid() = id));


--
-- Name: profiles Users can update their own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own profile" ON public.profiles FOR UPDATE USING ((auth.uid() = id)) WITH CHECK ((auth.uid() = id));


--
-- Name: compliance_log Users insert own compliance records; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users insert own compliance records" ON public.compliance_log FOR INSERT WITH CHECK ((user_id = auth.uid()));


--
-- Name: shift_alerts Users manage their own alerts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage their own alerts" ON public.shift_alerts USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: business_claims Users manage their own claims; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage their own claims" ON public.business_claims USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: local_business_follows Users manage their own follows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage their own follows" ON public.local_business_follows USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: notification_preferences Users manage their own notification preferences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage their own notification preferences" ON public.notification_preferences USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: games_user_stats Users manage their own stats; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage their own stats" ON public.games_user_stats USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: local_loyalty_cards Users see their own cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see their own cards" ON public.local_loyalty_cards FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: email_log Users see their own email log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see their own email log" ON public.email_log FOR SELECT USING ((recipient_id = auth.uid()));


--
-- Name: local_loyalty_transactions Users see their own loyalty transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see their own loyalty transactions" ON public.local_loyalty_transactions FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: notification_log Users see their own notification log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see their own notification log" ON public.notification_log FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: notification_preferences Users see their own notification preferences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see their own notification preferences" ON public.notification_preferences FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: local_offer_redemptions Users see their own redemptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see their own redemptions" ON public.local_offer_redemptions FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: local_wallet_balances Users see their own wallet; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see their own wallet" ON public.local_wallet_balances FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: local_wallet_transactions Users see their own wallet transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users see their own wallet transactions" ON public.local_wallet_transactions FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: compliance_log Users view own compliance records; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users view own compliance records" ON public.compliance_log FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: admin_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_config ENABLE ROW LEVEL SECURITY;

--
-- Name: spik_suggestions anyone can submit; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "anyone can submit" ON public.spik_suggestions FOR INSERT TO authenticated, anon WITH CHECK (true);


--
-- Name: application_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.application_events ENABLE ROW LEVEL SECURITY;

--
-- Name: application_events application_events read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "application_events read" ON public.application_events FOR SELECT USING (((EXISTS ( SELECT 1
   FROM (public.job_applications ja
     JOIN public.jobs j ON ((j.id = ja.job_id)))
  WHERE ((ja.id = application_events.application_id) AND ((ja.applicant_id = auth.uid()) OR (j.employer_id = auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: shift_reviews authenticated user posts review; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated user posts review" ON public.shift_reviews FOR INSERT TO authenticated WITH CHECK ((auth.uid() = reviewer_id));


--
-- Name: shift_availability availability visible to authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "availability visible to authenticated" ON public.shift_availability FOR SELECT TO authenticated USING (true);


--
-- Name: book_availability_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.book_availability_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: book_bookings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.book_bookings ENABLE ROW LEVEL SECURITY;

--
-- Name: book_gifts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.book_gifts ENABLE ROW LEVEL SECURITY;

--
-- Name: book_services; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.book_services ENABLE ROW LEVEL SECURITY;

--
-- Name: book_slot_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.book_slot_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: book_unit_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.book_unit_items ENABLE ROW LEVEL SECURITY;

--
-- Name: book_unit_purchases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.book_unit_purchases ENABLE ROW LEVEL SECURITY;

--
-- Name: business_addons; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.business_addons ENABLE ROW LEVEL SECURITY;

--
-- Name: business_addons business_addons_admin_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY business_addons_admin_all ON public.business_addons USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: business_addons business_addons_owner_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY business_addons_owner_select ON public.business_addons FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.local_businesses lb
  WHERE ((lb.id = business_addons.business_id) AND (lb.owner_id = auth.uid())))));


--
-- Name: business_addons business_addons_owner_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY business_addons_owner_update ON public.business_addons FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.local_businesses lb
  WHERE ((lb.id = business_addons.business_id) AND (lb.owner_id = auth.uid())))));


--
-- Name: business_addons business_addons_public_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY business_addons_public_select ON public.business_addons FOR SELECT USING (((enabled = true) AND (EXISTS ( SELECT 1
   FROM public.local_businesses lb
  WHERE ((lb.id = business_addons.business_id) AND (lb.is_active = true))))));


--
-- Name: business_alert_access; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.business_alert_access ENABLE ROW LEVEL SECURITY;

--
-- Name: business_alert_access business_alert_access_admin_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY business_alert_access_admin_all ON public.business_alert_access USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: business_alert_access business_alert_access_owner_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY business_alert_access_owner_insert ON public.business_alert_access FOR INSERT WITH CHECK (((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))) AND (status = 'requested'::text)));


--
-- Name: business_alert_access business_alert_access_owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY business_alert_access_owner_read ON public.business_alert_access FOR SELECT USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: business_claims; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.business_claims ENABLE ROW LEVEL SECURITY;

--
-- Name: business_discount_grants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.business_discount_grants ENABLE ROW LEVEL SECURITY;

--
-- Name: compliance_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.compliance_log ENABLE ROW LEVEL SECURITY;

--
-- Name: cruise_ships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cruise_ships ENABLE ROW LEVEL SECURITY;

--
-- Name: cruise_ships cruise_ships admin write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cruise_ships admin write" ON public.cruise_ships USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: cruise_ships cruise_ships read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cruise_ships read" ON public.cruise_ships FOR SELECT USING (true);


--
-- Name: cruise_visits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cruise_visits ENABLE ROW LEVEL SECURITY;

--
-- Name: cruise_visits cruise_visits admin write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cruise_visits admin write" ON public.cruise_visits USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: cruise_visits cruise_visits read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cruise_visits read" ON public.cruise_visits FOR SELECT USING (true);


--
-- Name: cv_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cv_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: cv_documents cv_documents owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cv_documents owner" ON public.cv_documents USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: measurements da_boats admin delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin delete" ON public.measurements FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: media_assets da_boats admin delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin delete" ON public.media_assets FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: owners da_boats admin delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin delete" ON public.owners FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: ownership_periods da_boats admin delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin delete" ON public.ownership_periods FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: registrations da_boats admin delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin delete" ON public.registrations FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: source_documents da_boats admin delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin delete" ON public.source_documents FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: source_records da_boats admin delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin delete" ON public.source_records FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: vessel_events da_boats admin delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin delete" ON public.vessel_events FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: vessel_media_links da_boats admin delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin delete" ON public.vessel_media_links FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: vessel_names da_boats admin delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin delete" ON public.vessel_names FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: vessel_relationships da_boats admin delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin delete" ON public.vessel_relationships FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: vessel_source_links da_boats admin delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin delete" ON public.vessel_source_links FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: vessels da_boats admin delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin delete" ON public.vessels FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: measurements da_boats admin update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin update" ON public.measurements FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: media_assets da_boats admin update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin update" ON public.media_assets FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: owners da_boats admin update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin update" ON public.owners FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: ownership_periods da_boats admin update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin update" ON public.ownership_periods FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: registrations da_boats admin update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin update" ON public.registrations FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: source_documents da_boats admin update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin update" ON public.source_documents FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: source_records da_boats admin update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin update" ON public.source_records FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: vessel_events da_boats admin update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin update" ON public.vessel_events FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: vessel_media_links da_boats admin update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin update" ON public.vessel_media_links FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: vessel_names da_boats admin update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin update" ON public.vessel_names FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: vessel_relationships da_boats admin update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin update" ON public.vessel_relationships FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: vessel_source_links da_boats admin update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin update" ON public.vessel_source_links FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: vessels da_boats admin update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin update" ON public.vessels FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: measurements da_boats admin write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin write" ON public.measurements FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: media_assets da_boats admin write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin write" ON public.media_assets FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: owners da_boats admin write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin write" ON public.owners FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: ownership_periods da_boats admin write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin write" ON public.ownership_periods FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: registrations da_boats admin write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin write" ON public.registrations FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: source_documents da_boats admin write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin write" ON public.source_documents FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: source_records da_boats admin write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin write" ON public.source_records FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: vessel_events da_boats admin write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin write" ON public.vessel_events FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: vessel_media_links da_boats admin write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin write" ON public.vessel_media_links FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: vessel_names da_boats admin write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin write" ON public.vessel_names FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: vessel_relationships da_boats admin write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin write" ON public.vessel_relationships FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: vessel_source_links da_boats admin write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin write" ON public.vessel_source_links FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: vessels da_boats admin write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats admin write" ON public.vessels FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: measurements da_boats public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats public read" ON public.measurements FOR SELECT USING (true);


--
-- Name: media_assets da_boats public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats public read" ON public.media_assets FOR SELECT USING (true);


--
-- Name: owners da_boats public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats public read" ON public.owners FOR SELECT USING (true);


--
-- Name: ownership_periods da_boats public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats public read" ON public.ownership_periods FOR SELECT USING (true);


--
-- Name: registrations da_boats public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats public read" ON public.registrations FOR SELECT USING (true);


--
-- Name: source_documents da_boats public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats public read" ON public.source_documents FOR SELECT USING (true);


--
-- Name: source_records da_boats public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats public read" ON public.source_records FOR SELECT USING (true);


--
-- Name: vessel_events da_boats public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats public read" ON public.vessel_events FOR SELECT USING (true);


--
-- Name: vessel_media_links da_boats public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats public read" ON public.vessel_media_links FOR SELECT USING (true);


--
-- Name: vessel_names da_boats public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats public read" ON public.vessel_names FOR SELECT USING (true);


--
-- Name: vessel_relationships da_boats public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats public read" ON public.vessel_relationships FOR SELECT USING (true);


--
-- Name: vessel_source_links da_boats public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats public read" ON public.vessel_source_links FOR SELECT USING (true);


--
-- Name: vessels da_boats public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "da_boats public read" ON public.vessels FOR SELECT USING (true);


--
-- Name: delivery_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_fees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_fees ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_pricing_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_pricing_config ENABLE ROW LEVEL SECURITY;

--
-- Name: delivery_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.delivery_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: driver_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.driver_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: email_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_log ENABLE ROW LEVEL SECURITY;

--
-- Name: email_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: email_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: shift_applications employer accepts or rejects; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "employer accepts or rejects" ON public.shift_applications FOR UPDATE USING ((auth.uid() = ( SELECT shifts.employer_id
   FROM public.shifts
  WHERE (shifts.id = shift_applications.shift_id))));


--
-- Name: shift_check_ins employer approves hours; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "employer approves hours" ON public.shift_check_ins FOR UPDATE USING ((auth.uid() = ( SELECT shifts.employer_id
   FROM public.shifts
  WHERE (shifts.id = shift_check_ins.shift_id))));


--
-- Name: shift_employer_profiles employer manages own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "employer manages own profile" ON public.shift_employer_profiles USING ((auth.uid() = id)) WITH CHECK ((auth.uid() = id));


--
-- Name: shifts employer manages own shifts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "employer manages own shifts" ON public.shifts USING ((auth.uid() = employer_id)) WITH CHECK ((auth.uid() = employer_id));


--
-- Name: shift_employer_profiles employer profile visible to all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "employer profile visible to all" ON public.shift_employer_profiles FOR SELECT USING (true);


--
-- Name: shift_applications employer sees applications for their shifts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "employer sees applications for their shifts" ON public.shift_applications FOR SELECT USING ((auth.uid() = ( SELECT shifts.employer_id
   FROM public.shifts
  WHERE (shifts.id = shift_applications.shift_id))));


--
-- Name: shift_check_ins employer sees check-ins for their shifts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "employer sees check-ins for their shifts" ON public.shift_check_ins FOR SELECT USING ((auth.uid() = ( SELECT shifts.employer_id
   FROM public.shifts
  WHERE (shifts.id = shift_check_ins.shift_id))));


--
-- Name: shift_payments employer sees their payments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "employer sees their payments" ON public.shift_payments FOR SELECT USING ((auth.uid() = employer_id));


--
-- Name: event_checkins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.event_checkins ENABLE ROW LEVEL SECURITY;

--
-- Name: event_checkins event_checkins_owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY event_checkins_owner_read ON public.event_checkins FOR SELECT USING (((EXISTS ( SELECT 1
   FROM (public.events e
     JOIN public.local_businesses lb ON ((lb.id = e.organiser_business_id)))
  WHERE ((e.id = event_checkins.event_id) AND (lb.owner_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))))));


--
-- Name: event_checkins event_checkins_scanner_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY event_checkins_scanner_insert ON public.event_checkins FOR INSERT WITH CHECK ((scanner_id = auth.uid()));


--
-- Name: event_ticket_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.event_ticket_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: event_ticket_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.event_ticket_types ENABLE ROW LEVEL SECURITY;

--
-- Name: event_tickets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.event_tickets ENABLE ROW LEVEL SECURITY;

--
-- Name: event_tickets event_tickets_admin_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY event_tickets_admin_all ON public.event_tickets USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: event_tickets event_tickets_holder_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY event_tickets_holder_read ON public.event_tickets FOR SELECT USING ((holder_id = auth.uid()));


--
-- Name: event_tickets event_tickets_owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY event_tickets_owner_read ON public.event_tickets FOR SELECT USING (((EXISTS ( SELECT 1
   FROM (public.events e
     JOIN public.local_businesses lb ON ((lb.id = e.organiser_business_id)))
  WHERE ((e.id = event_tickets.event_id) AND (lb.owner_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM public.events e
  WHERE ((e.id = event_tickets.event_id) AND (e.organiser_hub_id IS NOT NULL) AND public.is_hub_admin(e.organiser_hub_id, auth.uid()))))));


--
-- Name: event_updates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.event_updates ENABLE ROW LEVEL SECURITY;

--
-- Name: event_updates event_updates_admin_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY event_updates_admin_all ON public.event_updates USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: event_updates event_updates_owner_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY event_updates_owner_write ON public.event_updates FOR INSERT WITH CHECK (((author_id = auth.uid()) AND ((EXISTS ( SELECT 1
   FROM (public.events e
     JOIN public.local_businesses lb ON ((lb.id = e.organiser_business_id)))
  WHERE ((e.id = event_updates.event_id) AND (lb.owner_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM public.events e
  WHERE ((e.id = event_updates.event_id) AND (e.organiser_hub_id IS NOT NULL) AND public.is_hub_admin(e.organiser_hub_id, auth.uid())))))));


--
-- Name: event_updates event_updates_public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY event_updates_public_read ON public.event_updates FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.events e
  WHERE ((e.id = event_updates.event_id) AND ((NOT e.is_hidden) OR (EXISTS ( SELECT 1
           FROM public.profiles p
          WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))))))));


--
-- Name: events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

--
-- Name: events events_owner_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY events_owner_write ON public.events USING (((organiser_user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.local_businesses lb
  WHERE ((lb.id = events.organiser_business_id) AND (lb.owner_id = auth.uid())))) OR ((organiser_hub_id IS NOT NULL) AND public.is_hub_admin(organiser_hub_id, auth.uid())) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: events events_public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY events_public_read ON public.events FOR SELECT USING ((((NOT is_hidden) AND ((organiser_hub_id IS NULL) OR (hub_visibility = ANY (ARRAY['hub'::text, 'islands'::text])))) OR ((organiser_hub_id IS NOT NULL) AND public.is_hub_member(organiser_hub_id, auth.uid())) OR (organiser_user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.local_businesses lb
  WHERE ((lb.id = events.organiser_business_id) AND (lb.owner_id = auth.uid())))) OR ((organiser_hub_id IS NOT NULL) AND public.is_hub_admin(organiser_hub_id, auth.uid())) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: game_shetland_places; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.game_shetland_places ENABLE ROW LEVEL SECURITY;

--
-- Name: games_scores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.games_scores ENABLE ROW LEVEL SECURITY;

--
-- Name: games_user_stats; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.games_user_stats ENABLE ROW LEVEL SECURITY;

--
-- Name: hub_campaigns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hub_campaigns ENABLE ROW LEVEL SECURITY;

--
-- Name: hub_campaigns hub_campaigns manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hub_campaigns manage" ON public.hub_campaigns USING (public.is_hub_admin(hub_id, auth.uid())) WITH CHECK (public.is_hub_admin(hub_id, auth.uid()));


--
-- Name: hub_campaigns hub_campaigns read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hub_campaigns read" ON public.hub_campaigns FOR SELECT USING (true);


--
-- Name: hub_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hub_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: hub_documents hub_documents manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hub_documents manage" ON public.hub_documents USING (public.is_hub_admin(hub_id, auth.uid())) WITH CHECK (public.is_hub_admin(hub_id, auth.uid()));


--
-- Name: hub_documents hub_documents read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hub_documents read" ON public.hub_documents FOR SELECT USING (((visibility = 'public'::text) OR ((visibility = 'members'::text) AND public.is_hub_member(hub_id, auth.uid())) OR ((visibility = 'committee'::text) AND public.is_hub_admin(hub_id, auth.uid()))));


--
-- Name: hub_donations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hub_donations ENABLE ROW LEVEL SECURITY;

--
-- Name: hub_donations hub_donations read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hub_donations read" ON public.hub_donations FOR SELECT USING (((donor_user_id = auth.uid()) OR public.is_hub_admin(hub_id, auth.uid())));


--
-- Name: hub_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hub_members ENABLE ROW LEVEL SECURITY;

--
-- Name: hub_members hub_members delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hub_members delete" ON public.hub_members FOR DELETE USING ((public.is_hub_admin(hub_id, auth.uid()) OR (user_id = auth.uid())));


--
-- Name: hub_members hub_members join; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hub_members join" ON public.hub_members FOR INSERT WITH CHECK (((user_id = auth.uid()) AND (role = 'member'::text)));


--
-- Name: hub_members hub_members read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hub_members read" ON public.hub_members FOR SELECT USING (((user_id = auth.uid()) OR public.is_hub_admin(hub_id, auth.uid())));


--
-- Name: hub_members hub_members update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hub_members update" ON public.hub_members FOR UPDATE USING ((public.is_hub_admin(hub_id, auth.uid()) OR (user_id = auth.uid())));


--
-- Name: hub_membership_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hub_membership_types ENABLE ROW LEVEL SECURITY;

--
-- Name: hub_membership_types hub_membership_types manage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hub_membership_types manage" ON public.hub_membership_types USING (public.is_hub_admin(hub_id, auth.uid())) WITH CHECK (public.is_hub_admin(hub_id, auth.uid()));


--
-- Name: hub_membership_types hub_membership_types read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hub_membership_types read" ON public.hub_membership_types FOR SELECT USING ((is_active OR public.is_hub_admin(hub_id, auth.uid())));


--
-- Name: hubs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hubs ENABLE ROW LEVEL SECURITY;

--
-- Name: hubs hubs delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hubs delete" ON public.hubs FOR DELETE USING ((owner_id = auth.uid()));


--
-- Name: hubs hubs insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hubs insert" ON public.hubs FOR INSERT WITH CHECK ((owner_id = auth.uid()));


--
-- Name: hubs hubs read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hubs read" ON public.hubs FOR SELECT USING (((is_active = true) OR (owner_id = auth.uid())));


--
-- Name: hubs hubs update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "hubs update" ON public.hubs FOR UPDATE USING (((owner_id = auth.uid()) OR public.is_hub_admin(id, auth.uid())));


--
-- Name: job_applications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_applications ENABLE ROW LEVEL SECURITY;

--
-- Name: job_applications job_applications admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "job_applications admin" ON public.job_applications USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))));


--
-- Name: job_applications job_applications applicant; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "job_applications applicant" ON public.job_applications USING ((applicant_id = auth.uid())) WITH CHECK ((applicant_id = auth.uid()));


--
-- Name: job_applications job_applications employer read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "job_applications employer read" ON public.job_applications FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.jobs j
  WHERE ((j.id = job_applications.job_id) AND (j.employer_id = auth.uid())))));


--
-- Name: job_applications job_applications employer update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "job_applications employer update" ON public.job_applications FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.jobs j
  WHERE ((j.id = job_applications.job_id) AND (j.employer_id = auth.uid())))));


--
-- Name: jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: jobs jobs delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "jobs delete" ON public.jobs FOR DELETE USING (((employer_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))))));


--
-- Name: jobs jobs insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "jobs insert" ON public.jobs FOR INSERT WITH CHECK (((auth.uid() IS NOT NULL) AND (employer_id = auth.uid())));


--
-- Name: jobs jobs read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "jobs read" ON public.jobs FOR SELECT USING ((((NOT is_hidden) AND ((expires_at IS NULL) OR (expires_at > now()))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: jobs jobs update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "jobs update" ON public.jobs FOR UPDATE USING (((employer_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: local_boost_purchases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.local_boost_purchases ENABLE ROW LEVEL SECURITY;

--
-- Name: local_business_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.local_business_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: local_business_follows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.local_business_follows ENABLE ROW LEVEL SECURITY;

--
-- Name: local_businesses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.local_businesses ENABLE ROW LEVEL SECURITY;

--
-- Name: local_loyalty_cards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.local_loyalty_cards ENABLE ROW LEVEL SECURITY;

--
-- Name: local_loyalty_programs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.local_loyalty_programs ENABLE ROW LEVEL SECURITY;

--
-- Name: local_loyalty_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.local_loyalty_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: local_offer_redemptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.local_offer_redemptions ENABLE ROW LEVEL SECURITY;

--
-- Name: local_offers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.local_offers ENABLE ROW LEVEL SECURITY;

--
-- Name: local_wallet_balances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.local_wallet_balances ENABLE ROW LEVEL SECURITY;

--
-- Name: local_wallet_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.local_wallet_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: measurements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.measurements ENABLE ROW LEVEL SECURITY;

--
-- Name: media_assets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;

--
-- Name: memories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memories ENABLE ROW LEVEL SECURITY;

--
-- Name: memories memories author delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memories author delete" ON public.memories FOR DELETE USING (((author_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))))));


--
-- Name: memories memories author insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memories author insert" ON public.memories FOR INSERT WITH CHECK ((author_id = auth.uid()));


--
-- Name: memories memories author update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memories author update" ON public.memories FOR UPDATE USING (((author_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))))) WITH CHECK (((author_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: memories memories visible per visibility; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memories visible per visibility" ON public.memories FOR SELECT USING (((NOT is_hidden) AND ((visibility = 'public'::text) OR ((visibility = 'community'::text) AND (auth.uid() IS NOT NULL)) OR (author_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))))));


--
-- Name: memory_comments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_comments ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_comments memory_comments delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memory_comments delete" ON public.memory_comments FOR DELETE USING (((author_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: memory_comments memory_comments insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memory_comments insert" ON public.memory_comments FOR INSERT WITH CHECK (((author_id = auth.uid()) AND (auth.uid() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.memories m
  WHERE ((m.id = memory_comments.memory_id) AND (NOT m.is_hidden) AND ((m.visibility = 'public'::text) OR ((m.visibility = 'community'::text) AND (auth.uid() IS NOT NULL)) OR (m.author_id = auth.uid())))))));


--
-- Name: memory_comments memory_comments read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memory_comments read" ON public.memory_comments FOR SELECT USING (((NOT is_hidden) AND (EXISTS ( SELECT 1
   FROM public.memories m
  WHERE ((m.id = memory_comments.memory_id) AND (NOT m.is_hidden) AND ((m.visibility = 'public'::text) OR ((m.visibility = 'community'::text) AND (auth.uid() IS NOT NULL)) OR (m.author_id = auth.uid())))))));


--
-- Name: memory_comments memory_comments update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memory_comments update" ON public.memory_comments FOR UPDATE USING (((author_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: memory_image_pin_suggestions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_image_pin_suggestions ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_image_pins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_image_pins ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_image_pins memory_image_pins delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memory_image_pins delete" ON public.memory_image_pins FOR DELETE USING (((author_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))))));


--
-- Name: memory_image_pins memory_image_pins insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memory_image_pins insert" ON public.memory_image_pins FOR INSERT WITH CHECK (((author_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM (public.memory_media mm
     JOIN public.memories m ON ((m.id = mm.memory_id)))
  WHERE ((mm.id = memory_image_pins.media_id) AND (m.author_id = auth.uid()))))));


--
-- Name: memory_image_pins memory_image_pins read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memory_image_pins read" ON public.memory_image_pins FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (public.memory_media mm
     JOIN public.memories m ON ((m.id = mm.memory_id)))
  WHERE ((mm.id = memory_image_pins.media_id) AND (NOT m.is_hidden) AND ((m.visibility = 'public'::text) OR ((m.visibility = 'community'::text) AND (auth.uid() IS NOT NULL)) OR (m.author_id = auth.uid()))))));


--
-- Name: memory_image_pins memory_image_pins update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memory_image_pins update" ON public.memory_image_pins FOR UPDATE USING (((author_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: memory_media; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_media ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_media memory_media delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memory_media delete" ON public.memory_media FOR DELETE USING (((uploader_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))))));


--
-- Name: memory_media memory_media insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memory_media insert" ON public.memory_media FOR INSERT WITH CHECK (((uploader_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.memories m
  WHERE ((m.id = memory_media.memory_id) AND (m.author_id = auth.uid()))))));


--
-- Name: memory_media memory_media read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memory_media read" ON public.memory_media FOR SELECT USING (((EXISTS ( SELECT 1
   FROM public.memories m
  WHERE ((m.id = memory_media.memory_id) AND (NOT m.is_hidden) AND ((m.visibility = 'public'::text) OR ((m.visibility = 'community'::text) AND (auth.uid() IS NOT NULL)) OR (m.author_id = auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: memory_media memory_media update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memory_media update" ON public.memory_media FOR UPDATE USING (((uploader_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: memory_reactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.memory_reactions ENABLE ROW LEVEL SECURITY;

--
-- Name: memory_reactions memory_reactions delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memory_reactions delete" ON public.memory_reactions FOR DELETE USING ((user_id = auth.uid()));


--
-- Name: memory_reactions memory_reactions read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memory_reactions read" ON public.memory_reactions FOR SELECT USING (((user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.memories m
  WHERE (m.id = memory_reactions.memory_id)))));


--
-- Name: memory_reactions memory_reactions write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "memory_reactions write" ON public.memory_reactions FOR INSERT WITH CHECK ((user_id = auth.uid()));


--
-- Name: notices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notices ENABLE ROW LEVEL SECURITY;

--
-- Name: notices notices delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "notices delete" ON public.notices FOR DELETE USING (((publisher_user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.local_businesses b
  WHERE ((b.id = notices.publisher_business_id) AND (b.owner_id = auth.uid())))) OR public.is_hub_admin(publisher_hub_id, auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))))));


--
-- Name: notices notices insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "notices insert" ON public.notices FOR INSERT WITH CHECK (((auth.uid() IS NOT NULL) AND ((severity <> 'urgent'::text) OR (EXISTS ( SELECT 1
   FROM public.local_businesses b
  WHERE ((b.id = notices.publisher_business_id) AND (b.owner_id = auth.uid()) AND (b.can_publish_urgent = true)))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))) AND ((publisher_user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.local_businesses b
  WHERE ((b.id = notices.publisher_business_id) AND (b.owner_id = auth.uid())))) OR public.is_hub_admin(publisher_hub_id, auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))))));


--
-- Name: notices notices read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "notices read" ON public.notices FOR SELECT USING ((((NOT is_hidden) AND ((expires_at IS NULL) OR (expires_at > now())) AND ((visibility = 'public'::text) OR ((visibility = 'members'::text) AND public.is_hub_member(publisher_hub_id, auth.uid())) OR ((visibility = 'committee'::text) AND public.is_hub_admin(publisher_hub_id, auth.uid())))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: notices notices update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "notices update" ON public.notices FOR UPDATE USING (((publisher_user_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.local_businesses b
  WHERE ((b.id = notices.publisher_business_id) AND (b.owner_id = auth.uid())))) OR public.is_hub_admin(publisher_hub_id, auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: notification_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_log ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: oneshetland_feed; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.oneshetland_feed ENABLE ROW LEVEL SECURITY;

--
-- Name: shifts open shifts visible to all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "open shifts visible to all" ON public.shifts FOR SELECT USING ((status = ANY (ARRAY['open'::text, 'filled'::text, 'completed'::text])));


--
-- Name: owners; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.owners ENABLE ROW LEVEL SECURITY;

--
-- Name: ownership_periods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ownership_periods ENABLE ROW LEVEL SECURITY;

--
-- Name: partner_alerts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.partner_alerts ENABLE ROW LEVEL SECURITY;

--
-- Name: partner_alerts partner_alerts_admin_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY partner_alerts_admin_all ON public.partner_alerts USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = 'admin'::text)))));


--
-- Name: partner_alerts partner_alerts_owner_read_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY partner_alerts_owner_read_all ON public.partner_alerts FOR SELECT USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: partner_alerts partner_alerts_owner_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY partner_alerts_owner_update ON public.partner_alerts FOR UPDATE USING ((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))));


--
-- Name: partner_alerts partner_alerts_owner_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY partner_alerts_owner_write ON public.partner_alerts FOR INSERT WITH CHECK (((business_id IN ( SELECT local_businesses.id
   FROM public.local_businesses
  WHERE (local_businesses.owner_id = auth.uid()))) AND (EXISTS ( SELECT 1
   FROM public.business_alert_access
  WHERE ((business_alert_access.business_id = partner_alerts.business_id) AND (business_alert_access.status = 'active'::text))))));


--
-- Name: partner_alerts partner_alerts_public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY partner_alerts_public_read ON public.partner_alerts FOR SELECT USING (((is_active = true) AND ((expires_at IS NULL) OR (expires_at > now()))));


--
-- Name: memory_image_pin_suggestions pin_suggestions delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "pin_suggestions delete" ON public.memory_image_pin_suggestions FOR DELETE USING (((suggester_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM ((public.memory_image_pins p
     JOIN public.memory_media mm ON ((mm.id = p.media_id)))
     JOIN public.memories m ON ((m.id = mm.memory_id)))
  WHERE ((p.id = memory_image_pin_suggestions.pin_id) AND (m.author_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM public.profiles pr
  WHERE ((pr.id = auth.uid()) AND (pr.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: memory_image_pin_suggestions pin_suggestions insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "pin_suggestions insert" ON public.memory_image_pin_suggestions FOR INSERT WITH CHECK (((suggester_id = auth.uid()) AND (auth.uid() IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM ((public.memory_image_pins p
     JOIN public.memory_media mm ON ((mm.id = p.media_id)))
     JOIN public.memories m ON ((m.id = mm.memory_id)))
  WHERE ((p.id = memory_image_pin_suggestions.pin_id) AND (NOT m.is_hidden))))));


--
-- Name: memory_image_pin_suggestions pin_suggestions read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "pin_suggestions read" ON public.memory_image_pin_suggestions FOR SELECT USING (((EXISTS ( SELECT 1
   FROM ((public.memory_image_pins p
     JOIN public.memory_media mm ON ((mm.id = p.media_id)))
     JOIN public.memories m ON ((m.id = mm.memory_id)))
  WHERE ((p.id = memory_image_pin_suggestions.pin_id) AND (NOT m.is_hidden) AND ((m.visibility = 'public'::text) OR ((m.visibility = 'community'::text) AND (auth.uid() IS NOT NULL)) OR (m.author_id = auth.uid()))))) OR (EXISTS ( SELECT 1
   FROM public.profiles pr
  WHERE ((pr.id = auth.uid()) AND (pr.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: memory_image_pin_suggestions pin_suggestions update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "pin_suggestions update" ON public.memory_image_pin_suggestions FOR UPDATE USING (((suggester_id = auth.uid()) AND (NOT is_accepted)));


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: regions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.regions ENABLE ROW LEVEL SECURITY;

--
-- Name: registrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.registrations ENABLE ROW LEVEL SECURITY;

--
-- Name: shift_reviews reviews visible to all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "reviews visible to all" ON public.shift_reviews FOR SELECT USING (true);


--
-- Name: runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.runs ENABLE ROW LEVEL SECURITY;

--
-- Name: saved_addresses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.saved_addresses ENABLE ROW LEVEL SECURITY;

--
-- Name: saved_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.saved_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: saved_jobs saved_jobs owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "saved_jobs owner" ON public.saved_jobs USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: shift_alerts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shift_alerts ENABLE ROW LEVEL SECURITY;

--
-- Name: shift_applications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shift_applications ENABLE ROW LEVEL SECURITY;

--
-- Name: shift_availability; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shift_availability ENABLE ROW LEVEL SECURITY;

--
-- Name: shift_check_ins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shift_check_ins ENABLE ROW LEVEL SECURITY;

--
-- Name: shift_employer_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shift_employer_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: shift_payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shift_payments ENABLE ROW LEVEL SECURITY;

--
-- Name: shift_qualifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shift_qualifications ENABLE ROW LEVEL SECURITY;

--
-- Name: shift_reviews; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shift_reviews ENABLE ROW LEVEL SECURITY;

--
-- Name: shift_worker_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shift_worker_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: shifts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;

--
-- Name: ship_positions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ship_positions ENABLE ROW LEVEL SECURITY;

--
-- Name: ship_positions ship_positions admin write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "ship_positions admin write" ON public.ship_positions USING ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text)))));


--
-- Name: ship_positions ship_positions read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "ship_positions read" ON public.ship_positions FOR SELECT USING (true);


--
-- Name: source_documents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.source_documents ENABLE ROW LEVEL SECURITY;

--
-- Name: source_records; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.source_records ENABLE ROW LEVEL SECURITY;

--
-- Name: spik_suggestions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.spik_suggestions ENABLE ROW LEVEL SECURITY;

--
-- Name: event_ticket_orders ticket_orders_buyer_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ticket_orders_buyer_insert ON public.event_ticket_orders FOR INSERT WITH CHECK ((buyer_id = auth.uid()));


--
-- Name: event_ticket_orders ticket_orders_buyer_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ticket_orders_buyer_read ON public.event_ticket_orders FOR SELECT USING (((buyer_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM (public.events e
     JOIN public.local_businesses lb ON ((lb.id = e.organiser_business_id)))
  WHERE ((e.id = event_ticket_orders.event_id) AND (lb.owner_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM public.events e
  WHERE ((e.id = event_ticket_orders.event_id) AND (e.organiser_hub_id IS NOT NULL) AND public.is_hub_admin(e.organiser_hub_id, auth.uid())))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))))));


--
-- Name: event_ticket_types ticket_types_owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ticket_types_owner_all ON public.event_ticket_types USING (((EXISTS ( SELECT 1
   FROM (public.events e
     JOIN public.local_businesses lb ON ((lb.id = e.organiser_business_id)))
  WHERE ((e.id = event_ticket_types.event_id) AND (lb.owner_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM public.events e
  WHERE ((e.id = event_ticket_types.event_id) AND (e.organiser_hub_id IS NOT NULL) AND public.is_hub_admin(e.organiser_hub_id, auth.uid())))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))))));


--
-- Name: event_ticket_types ticket_types_public_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ticket_types_public_read ON public.event_ticket_types FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.events e
  WHERE ((e.id = event_ticket_types.event_id) AND (NOT e.is_hidden)))));


--
-- Name: shift_qualifications verified qualifications visible to employers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "verified qualifications visible to employers" ON public.shift_qualifications FOR SELECT USING ((verified_by_admin = true));


--
-- Name: vessel_comments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vessel_comments ENABLE ROW LEVEL SECURITY;

--
-- Name: vessel_comments vessel_comments delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vessel_comments delete" ON public.vessel_comments FOR DELETE USING (((author_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))))));


--
-- Name: vessel_comments vessel_comments insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vessel_comments insert" ON public.vessel_comments FOR INSERT WITH CHECK (((author_id = auth.uid()) AND (auth.uid() IS NOT NULL)));


--
-- Name: vessel_comments vessel_comments read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vessel_comments read" ON public.vessel_comments FOR SELECT USING (((NOT is_hidden) OR (author_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: vessel_comments vessel_comments update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vessel_comments update" ON public.vessel_comments FOR UPDATE USING (((author_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: vessel_edit_proposals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vessel_edit_proposals ENABLE ROW LEVEL SECURITY;

--
-- Name: vessel_edit_proposals vessel_edit_proposals insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vessel_edit_proposals insert" ON public.vessel_edit_proposals FOR INSERT WITH CHECK (((proposed_by = auth.uid()) AND (auth.uid() IS NOT NULL)));


--
-- Name: vessel_edit_proposals vessel_edit_proposals read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vessel_edit_proposals read" ON public.vessel_edit_proposals FOR SELECT USING (true);


--
-- Name: vessel_edit_votes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vessel_edit_votes ENABLE ROW LEVEL SECURITY;

--
-- Name: vessel_edit_votes vessel_edit_votes read own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "vessel_edit_votes read own" ON public.vessel_edit_votes FOR SELECT USING ((user_id = auth.uid()));


--
-- Name: vessel_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vessel_events ENABLE ROW LEVEL SECURITY;

--
-- Name: vessel_media_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vessel_media_links ENABLE ROW LEVEL SECURITY;

--
-- Name: vessel_names; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vessel_names ENABLE ROW LEVEL SECURITY;

--
-- Name: vessel_relationships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vessel_relationships ENABLE ROW LEVEL SECURITY;

--
-- Name: vessel_source_links; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vessel_source_links ENABLE ROW LEVEL SECURITY;

--
-- Name: vessels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vessels ENABLE ROW LEVEL SECURITY;

--
-- Name: waiting_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.waiting_events ENABLE ROW LEVEL SECURITY;

--
-- Name: shift_check_ins worker clocks in; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "worker clocks in" ON public.shift_check_ins FOR INSERT TO authenticated WITH CHECK ((auth.uid() = worker_id));


--
-- Name: shift_check_ins worker clocks out; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "worker clocks out" ON public.shift_check_ins FOR UPDATE USING ((auth.uid() = worker_id)) WITH CHECK ((auth.uid() = worker_id));


--
-- Name: shift_qualifications worker deletes own qualifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "worker deletes own qualifications" ON public.shift_qualifications FOR DELETE USING ((auth.uid() = worker_id));


--
-- Name: shift_qualifications worker inserts own qualifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "worker inserts own qualifications" ON public.shift_qualifications FOR INSERT TO authenticated WITH CHECK ((auth.uid() = worker_id));


--
-- Name: shift_availability worker manages own availability; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "worker manages own availability" ON public.shift_availability USING ((auth.uid() = worker_id)) WITH CHECK ((auth.uid() = worker_id));


--
-- Name: shift_worker_profiles worker manages own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "worker manages own profile" ON public.shift_worker_profiles USING ((auth.uid() = id)) WITH CHECK ((auth.uid() = id));


--
-- Name: shift_worker_profiles worker profile visible to all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "worker profile visible to all" ON public.shift_worker_profiles FOR SELECT USING (true);


--
-- Name: shift_applications worker sees own applications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "worker sees own applications" ON public.shift_applications FOR SELECT USING ((auth.uid() = worker_id));


--
-- Name: shift_check_ins worker sees own check-ins; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "worker sees own check-ins" ON public.shift_check_ins FOR SELECT USING ((auth.uid() = worker_id));


--
-- Name: shift_payments worker sees own payments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "worker sees own payments" ON public.shift_payments FOR SELECT USING ((auth.uid() = worker_id));


--
-- Name: shift_qualifications worker sees own qualifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "worker sees own qualifications" ON public.shift_qualifications FOR SELECT USING ((auth.uid() = worker_id));


--
-- Name: shift_applications worker submits interest; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "worker submits interest" ON public.shift_applications FOR INSERT TO authenticated WITH CHECK ((auth.uid() = worker_id));


--
-- Name: shift_qualifications worker updates own qualifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "worker updates own qualifications" ON public.shift_qualifications FOR UPDATE USING ((auth.uid() = worker_id)) WITH CHECK ((auth.uid() = worker_id));


--
-- Name: shift_applications worker withdraws own application; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "worker withdraws own application" ON public.shift_applications FOR UPDATE USING (((auth.uid() = worker_id) AND (status = 'pending'::text)));


--
-- Name: worker_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.worker_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: worker_profiles worker_profiles employer read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "worker_profiles employer read" ON public.worker_profiles FOR SELECT USING (((EXISTS ( SELECT 1
   FROM (public.job_applications ja
     JOIN public.jobs j ON ((j.id = ja.job_id)))
  WHERE ((ja.applicant_id = worker_profiles.user_id) AND (j.employer_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: worker_profiles worker_profiles owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "worker_profiles owner" ON public.worker_profiles USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: TABLE vessel_edit_proposals; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vessel_edit_proposals TO anon;
GRANT ALL ON TABLE public.vessel_edit_proposals TO authenticated;
GRANT ALL ON TABLE public.vessel_edit_proposals TO service_role;


--
-- Name: FUNCTION _apply_vessel_edit(p public.vessel_edit_proposals); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public._apply_vessel_edit(p public.vessel_edit_proposals) FROM PUBLIC;
GRANT ALL ON FUNCTION public._apply_vessel_edit(p public.vessel_edit_proposals) TO anon;
GRANT ALL ON FUNCTION public._apply_vessel_edit(p public.vessel_edit_proposals) TO authenticated;
GRANT ALL ON FUNCTION public._apply_vessel_edit(p public.vessel_edit_proposals) TO service_role;


--
-- Name: TABLE memory_image_pins; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.memory_image_pins TO anon;
GRANT ALL ON TABLE public.memory_image_pins TO authenticated;
GRANT ALL ON TABLE public.memory_image_pins TO service_role;


--
-- Name: FUNCTION accept_image_pin_suggestion(suggestion_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.accept_image_pin_suggestion(suggestion_id uuid) TO anon;
GRANT ALL ON FUNCTION public.accept_image_pin_suggestion(suggestion_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.accept_image_pin_suggestion(suggestion_id uuid) TO service_role;


--
-- Name: FUNCTION activate_hub_membership(p_hub uuid, p_user uuid, p_type uuid, p_period text, p_payment_pence integer, p_pi text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.activate_hub_membership(p_hub uuid, p_user uuid, p_type uuid, p_period text, p_payment_pence integer, p_pi text) TO anon;
GRANT ALL ON FUNCTION public.activate_hub_membership(p_hub uuid, p_user uuid, p_type uuid, p_period text, p_payment_pence integer, p_pi text) TO authenticated;
GRANT ALL ON FUNCTION public.activate_hub_membership(p_hub uuid, p_user uuid, p_type uuid, p_period text, p_payment_pence integer, p_pi text) TO service_role;


--
-- Name: FUNCTION admin_config_touch_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_config_touch_updated_at() TO anon;
GRANT ALL ON FUNCTION public.admin_config_touch_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.admin_config_touch_updated_at() TO service_role;


--
-- Name: FUNCTION approve_business_claim(p_claim_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.approve_business_claim(p_claim_id uuid) TO anon;
GRANT ALL ON FUNCTION public.approve_business_claim(p_claim_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.approve_business_claim(p_claim_id uuid) TO service_role;


--
-- Name: FUNCTION claim_gift(p_code text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.claim_gift(p_code text) TO anon;
GRANT ALL ON FUNCTION public.claim_gift(p_code text) TO authenticated;
GRANT ALL ON FUNCTION public.claim_gift(p_code text) TO service_role;


--
-- Name: FUNCTION compliance_log_immutable(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.compliance_log_immutable() TO anon;
GRANT ALL ON FUNCTION public.compliance_log_immutable() TO authenticated;
GRANT ALL ON FUNCTION public.compliance_log_immutable() TO service_role;


--
-- Name: FUNCTION cruise_barometer(total_pax integer, ships integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.cruise_barometer(total_pax integer, ships integer) TO anon;
GRANT ALL ON FUNCTION public.cruise_barometer(total_pax integer, ships integer) TO authenticated;
GRANT ALL ON FUNCTION public.cruise_barometer(total_pax integer, ships integer) TO service_role;


--
-- Name: FUNCTION cruise_touch_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.cruise_touch_updated_at() TO anon;
GRANT ALL ON FUNCTION public.cruise_touch_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.cruise_touch_updated_at() TO service_role;


--
-- Name: FUNCTION cruise_visit_derive(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.cruise_visit_derive() TO anon;
GRANT ALL ON FUNCTION public.cruise_visit_derive() TO authenticated;
GRANT ALL ON FUNCTION public.cruise_visit_derive() TO service_role;


--
-- Name: FUNCTION fetch_memory_pins(min_lat numeric, max_lat numeric, min_lng numeric, max_lng numeric, result_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.fetch_memory_pins(min_lat numeric, max_lat numeric, min_lng numeric, max_lng numeric, result_limit integer) TO anon;
GRANT ALL ON FUNCTION public.fetch_memory_pins(min_lat numeric, max_lat numeric, min_lng numeric, max_lng numeric, result_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.fetch_memory_pins(min_lat numeric, max_lat numeric, min_lng numeric, max_lng numeric, result_limit integer) TO service_role;


--
-- Name: FUNCTION generate_business_slug(p_name text, p_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.generate_business_slug(p_name text, p_id uuid) TO anon;
GRANT ALL ON FUNCTION public.generate_business_slug(p_name text, p_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.generate_business_slug(p_name text, p_id uuid) TO service_role;


--
-- Name: FUNCTION generate_gift_code(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.generate_gift_code() TO anon;
GRANT ALL ON FUNCTION public.generate_gift_code() TO authenticated;
GRANT ALL ON FUNCTION public.generate_gift_code() TO service_role;


--
-- Name: FUNCTION generate_nfc_token(business_name text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.generate_nfc_token(business_name text) TO anon;
GRANT ALL ON FUNCTION public.generate_nfc_token(business_name text) TO authenticated;
GRANT ALL ON FUNCTION public.generate_nfc_token(business_name text) TO service_role;


--
-- Name: FUNCTION generate_ticket_backup_code(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.generate_ticket_backup_code() TO anon;
GRANT ALL ON FUNCTION public.generate_ticket_backup_code() TO authenticated;
GRANT ALL ON FUNCTION public.generate_ticket_backup_code() TO service_role;


--
-- Name: FUNCTION get_business_wallet_receipts(p_business_id uuid, p_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_business_wallet_receipts(p_business_id uuid, p_limit integer) TO anon;
GRANT ALL ON FUNCTION public.get_business_wallet_receipts(p_business_id uuid, p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_business_wallet_receipts(p_business_id uuid, p_limit integer) TO service_role;


--
-- Name: FUNCTION get_campaign_donors(p_campaign uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_campaign_donors(p_campaign uuid) TO anon;
GRANT ALL ON FUNCTION public.get_campaign_donors(p_campaign uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_campaign_donors(p_campaign uuid) TO service_role;


--
-- Name: FUNCTION get_customer_info_for_request(request_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_customer_info_for_request(request_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_customer_info_for_request(request_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_customer_info_for_request(request_id uuid) TO service_role;


--
-- Name: FUNCTION get_driver_info_for_request(request_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_driver_info_for_request(request_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_driver_info_for_request(request_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_driver_info_for_request(request_id uuid) TO service_role;


--
-- Name: FUNCTION get_event_scanner_stats(p_event_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_event_scanner_stats(p_event_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_event_scanner_stats(p_event_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_event_scanner_stats(p_event_id uuid) TO service_role;


--
-- Name: FUNCTION get_hub_directory(p_hub uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_hub_directory(p_hub uuid) TO anon;
GRANT ALL ON FUNCTION public.get_hub_directory(p_hub uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_hub_directory(p_hub uuid) TO service_role;


--
-- Name: FUNCTION get_my_role(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_my_role() TO anon;
GRANT ALL ON FUNCTION public.get_my_role() TO authenticated;
GRANT ALL ON FUNCTION public.get_my_role() TO service_role;


--
-- Name: FUNCTION get_public_booking_load(p_business_id uuid, p_from timestamp with time zone, p_to timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_public_booking_load(p_business_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) TO anon;
GRANT ALL ON FUNCTION public.get_public_booking_load(p_business_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.get_public_booking_load(p_business_id uuid, p_from timestamp with time zone, p_to timestamp with time zone) TO service_role;


--
-- Name: FUNCTION get_spik_stats(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_spik_stats() TO anon;
GRANT ALL ON FUNCTION public.get_spik_stats() TO authenticated;
GRANT ALL ON FUNCTION public.get_spik_stats() TO service_role;


--
-- Name: FUNCTION handle_new_user(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.handle_new_user() TO anon;
GRANT ALL ON FUNCTION public.handle_new_user() TO authenticated;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;


--
-- Name: FUNCTION hub_membership_active(p_status text, p_paid_until timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.hub_membership_active(p_status text, p_paid_until timestamp with time zone) TO anon;
GRANT ALL ON FUNCTION public.hub_membership_active(p_status text, p_paid_until timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.hub_membership_active(p_status text, p_paid_until timestamp with time zone) TO service_role;


--
-- Name: FUNCTION increment_event_tickets_sold(p_event_id uuid, p_count integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.increment_event_tickets_sold(p_event_id uuid, p_count integer) TO anon;
GRANT ALL ON FUNCTION public.increment_event_tickets_sold(p_event_id uuid, p_count integer) TO authenticated;
GRANT ALL ON FUNCTION public.increment_event_tickets_sold(p_event_id uuid, p_count integer) TO service_role;


--
-- Name: FUNCTION is_admin(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_admin() TO anon;
GRANT ALL ON FUNCTION public.is_admin() TO authenticated;
GRANT ALL ON FUNCTION public.is_admin() TO service_role;


--
-- Name: FUNCTION is_hub_admin(p_hub uuid, p_user uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_hub_admin(p_hub uuid, p_user uuid) TO anon;
GRANT ALL ON FUNCTION public.is_hub_admin(p_hub uuid, p_user uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_hub_admin(p_hub uuid, p_user uuid) TO service_role;


--
-- Name: FUNCTION is_hub_member(p_hub uuid, p_user uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_hub_member(p_hub uuid, p_user uuid) TO anon;
GRANT ALL ON FUNCTION public.is_hub_member(p_hub uuid, p_user uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_hub_member(p_hub uuid, p_user uuid) TO service_role;


--
-- Name: FUNCTION purge_old_job_applications(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.purge_old_job_applications() FROM PUBLIC;
GRANT ALL ON FUNCTION public.purge_old_job_applications() TO anon;
GRANT ALL ON FUNCTION public.purge_old_job_applications() TO authenticated;
GRANT ALL ON FUNCTION public.purge_old_job_applications() TO service_role;


--
-- Name: FUNCTION recompute_cruise_day(target date); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.recompute_cruise_day(target date) TO anon;
GRANT ALL ON FUNCTION public.recompute_cruise_day(target date) TO authenticated;
GRANT ALL ON FUNCTION public.recompute_cruise_day(target date) TO service_role;


--
-- Name: FUNCTION record_hub_donation(p_campaign uuid, p_hub uuid, p_user uuid, p_amount integer, p_fee integer, p_message text, p_anon boolean, p_pi text, p_gift_aid boolean, p_title text, p_first text, p_last text, p_address text, p_postcode text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.record_hub_donation(p_campaign uuid, p_hub uuid, p_user uuid, p_amount integer, p_fee integer, p_message text, p_anon boolean, p_pi text, p_gift_aid boolean, p_title text, p_first text, p_last text, p_address text, p_postcode text) TO anon;
GRANT ALL ON FUNCTION public.record_hub_donation(p_campaign uuid, p_hub uuid, p_user uuid, p_amount integer, p_fee integer, p_message text, p_anon boolean, p_pi text, p_gift_aid boolean, p_title text, p_first text, p_last text, p_address text, p_postcode text) TO authenticated;
GRANT ALL ON FUNCTION public.record_hub_donation(p_campaign uuid, p_hub uuid, p_user uuid, p_amount integer, p_fee integer, p_message text, p_anon boolean, p_pi text, p_gift_aid boolean, p_title text, p_first text, p_last text, p_address text, p_postcode text) TO service_role;


--
-- Name: FUNCTION reserve_ticket_slots(p_type_id uuid, p_quantity integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.reserve_ticket_slots(p_type_id uuid, p_quantity integer) TO anon;
GRANT ALL ON FUNCTION public.reserve_ticket_slots(p_type_id uuid, p_quantity integer) TO authenticated;
GRANT ALL ON FUNCTION public.reserve_ticket_slots(p_type_id uuid, p_quantity integer) TO service_role;


--
-- Name: FUNCTION search_memories(q text, result_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.search_memories(q text, result_limit integer) TO anon;
GRANT ALL ON FUNCTION public.search_memories(q text, result_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.search_memories(q text, result_limit integer) TO service_role;


--
-- Name: FUNCTION set_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_updated_at() TO service_role;


--
-- Name: FUNCTION should_notify(p_user_id uuid, p_module text, p_urgent boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.should_notify(p_user_id uuid, p_module text, p_urgent boolean) TO anon;
GRANT ALL ON FUNCTION public.should_notify(p_user_id uuid, p_module text, p_urgent boolean) TO authenticated;
GRANT ALL ON FUNCTION public.should_notify(p_user_id uuid, p_module text, p_urgent boolean) TO service_role;


--
-- Name: FUNCTION spik_normalise_origin_usage(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.spik_normalise_origin_usage() TO anon;
GRANT ALL ON FUNCTION public.spik_normalise_origin_usage() TO authenticated;
GRANT ALL ON FUNCTION public.spik_normalise_origin_usage() TO service_role;


--
-- Name: FUNCTION tg_application_event(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_application_event() TO anon;
GRANT ALL ON FUNCTION public.tg_application_event() TO authenticated;
GRANT ALL ON FUNCTION public.tg_application_event() TO service_role;


--
-- Name: FUNCTION tg_decrement_unit_stock(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_decrement_unit_stock() TO anon;
GRANT ALL ON FUNCTION public.tg_decrement_unit_stock() TO authenticated;
GRANT ALL ON FUNCTION public.tg_decrement_unit_stock() TO service_role;


--
-- Name: FUNCTION tg_events_sync_hidden(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_events_sync_hidden() TO anon;
GRANT ALL ON FUNCTION public.tg_events_sync_hidden() TO authenticated;
GRANT ALL ON FUNCTION public.tg_events_sync_hidden() TO service_role;


--
-- Name: FUNCTION tg_hub_member_join_status(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_hub_member_join_status() TO anon;
GRANT ALL ON FUNCTION public.tg_hub_member_join_status() TO authenticated;
GRANT ALL ON FUNCTION public.tg_hub_member_join_status() TO service_role;


--
-- Name: FUNCTION tg_hub_members_guard(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_hub_members_guard() TO anon;
GRANT ALL ON FUNCTION public.tg_hub_members_guard() TO authenticated;
GRANT ALL ON FUNCTION public.tg_hub_members_guard() TO service_role;


--
-- Name: FUNCTION tg_hub_owner_membership(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_hub_owner_membership() TO anon;
GRANT ALL ON FUNCTION public.tg_hub_owner_membership() TO authenticated;
GRANT ALL ON FUNCTION public.tg_hub_owner_membership() TO service_role;


--
-- Name: FUNCTION tg_job_application_count(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_job_application_count() TO anon;
GRANT ALL ON FUNCTION public.tg_job_application_count() TO authenticated;
GRANT ALL ON FUNCTION public.tg_job_application_count() TO service_role;


--
-- Name: FUNCTION tg_job_application_touch(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_job_application_touch() TO anon;
GRANT ALL ON FUNCTION public.tg_job_application_touch() TO authenticated;
GRANT ALL ON FUNCTION public.tg_job_application_touch() TO service_role;


--
-- Name: FUNCTION tg_jobs_touch(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_jobs_touch() TO anon;
GRANT ALL ON FUNCTION public.tg_jobs_touch() TO authenticated;
GRANT ALL ON FUNCTION public.tg_jobs_touch() TO service_role;


--
-- Name: FUNCTION tg_memory_child_count(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_memory_child_count() TO anon;
GRANT ALL ON FUNCTION public.tg_memory_child_count() TO authenticated;
GRANT ALL ON FUNCTION public.tg_memory_child_count() TO service_role;


--
-- Name: FUNCTION tg_memory_comment_count(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_memory_comment_count() TO anon;
GRANT ALL ON FUNCTION public.tg_memory_comment_count() TO authenticated;
GRANT ALL ON FUNCTION public.tg_memory_comment_count() TO service_role;


--
-- Name: FUNCTION tg_memory_media_count(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_memory_media_count() TO anon;
GRANT ALL ON FUNCTION public.tg_memory_media_count() TO authenticated;
GRANT ALL ON FUNCTION public.tg_memory_media_count() TO service_role;


--
-- Name: FUNCTION tg_memory_reaction_count(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_memory_reaction_count() TO anon;
GRANT ALL ON FUNCTION public.tg_memory_reaction_count() TO authenticated;
GRANT ALL ON FUNCTION public.tg_memory_reaction_count() TO service_role;


--
-- Name: FUNCTION tg_profiles_lock_sensitive(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_profiles_lock_sensitive() TO anon;
GRANT ALL ON FUNCTION public.tg_profiles_lock_sensitive() TO authenticated;
GRANT ALL ON FUNCTION public.tg_profiles_lock_sensitive() TO service_role;


--
-- Name: FUNCTION tg_seed_business_addons(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_seed_business_addons() TO anon;
GRANT ALL ON FUNCTION public.tg_seed_business_addons() TO authenticated;
GRANT ALL ON FUNCTION public.tg_seed_business_addons() TO service_role;


--
-- Name: FUNCTION tg_set_business_slug(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_set_business_slug() TO anon;
GRANT ALL ON FUNCTION public.tg_set_business_slug() TO authenticated;
GRANT ALL ON FUNCTION public.tg_set_business_slug() TO service_role;


--
-- Name: FUNCTION tg_spik_sync_computed_fields(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_spik_sync_computed_fields() TO anon;
GRANT ALL ON FUNCTION public.tg_spik_sync_computed_fields() TO authenticated;
GRANT ALL ON FUNCTION public.tg_spik_sync_computed_fields() TO service_role;


--
-- Name: FUNCTION tg_validate_vessel_edit(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_validate_vessel_edit() TO anon;
GRANT ALL ON FUNCTION public.tg_validate_vessel_edit() TO authenticated;
GRANT ALL ON FUNCTION public.tg_validate_vessel_edit() TO service_role;


--
-- Name: FUNCTION tg_vessel_comment_count(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_vessel_comment_count() TO anon;
GRANT ALL ON FUNCTION public.tg_vessel_comment_count() TO authenticated;
GRANT ALL ON FUNCTION public.tg_vessel_comment_count() TO service_role;


--
-- Name: FUNCTION tg_worker_profile_touch(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.tg_worker_profile_touch() TO anon;
GRANT ALL ON FUNCTION public.tg_worker_profile_touch() TO authenticated;
GRANT ALL ON FUNCTION public.tg_worker_profile_touch() TO service_role;


--
-- Name: FUNCTION validate_and_checkin_ticket(p_raw_token text, p_event_id uuid, p_scanner_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_and_checkin_ticket(p_raw_token text, p_event_id uuid, p_scanner_id uuid) TO anon;
GRANT ALL ON FUNCTION public.validate_and_checkin_ticket(p_raw_token text, p_event_id uuid, p_scanner_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.validate_and_checkin_ticket(p_raw_token text, p_event_id uuid, p_scanner_id uuid) TO service_role;


--
-- Name: FUNCTION validate_and_checkin_ticket_by_id(p_ticket_id uuid, p_event_id uuid, p_scanner_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_and_checkin_ticket_by_id(p_ticket_id uuid, p_event_id uuid, p_scanner_id uuid) TO anon;
GRANT ALL ON FUNCTION public.validate_and_checkin_ticket_by_id(p_ticket_id uuid, p_event_id uuid, p_scanner_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.validate_and_checkin_ticket_by_id(p_ticket_id uuid, p_event_id uuid, p_scanner_id uuid) TO service_role;


--
-- Name: FUNCTION validate_backup_code(p_backup_code text, p_event_id uuid, p_scanner_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_backup_code(p_backup_code text, p_event_id uuid, p_scanner_id uuid) TO anon;
GRANT ALL ON FUNCTION public.validate_backup_code(p_backup_code text, p_event_id uuid, p_scanner_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.validate_backup_code(p_backup_code text, p_event_id uuid, p_scanner_id uuid) TO service_role;


--
-- Name: FUNCTION vessel_edit_col_cast(p_table text, p_column text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.vessel_edit_col_cast(p_table text, p_column text) TO anon;
GRANT ALL ON FUNCTION public.vessel_edit_col_cast(p_table text, p_column text) TO authenticated;
GRANT ALL ON FUNCTION public.vessel_edit_col_cast(p_table text, p_column text) TO service_role;


--
-- Name: FUNCTION vessel_edit_conf_col(p_table text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.vessel_edit_conf_col(p_table text) TO anon;
GRANT ALL ON FUNCTION public.vessel_edit_conf_col(p_table text) TO authenticated;
GRANT ALL ON FUNCTION public.vessel_edit_conf_col(p_table text) TO service_role;


--
-- Name: FUNCTION vote_vessel_edit(p_proposal uuid, p_vote text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.vote_vessel_edit(p_proposal uuid, p_vote text) TO anon;
GRANT ALL ON FUNCTION public.vote_vessel_edit(p_proposal uuid, p_vote text) TO authenticated;
GRANT ALL ON FUNCTION public.vote_vessel_edit(p_proposal uuid, p_vote text) TO service_role;


--
-- Name: FUNCTION wallet_credit(p_user uuid, p_amount integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.wallet_credit(p_user uuid, p_amount integer) TO anon;
GRANT ALL ON FUNCTION public.wallet_credit(p_user uuid, p_amount integer) TO authenticated;
GRANT ALL ON FUNCTION public.wallet_credit(p_user uuid, p_amount integer) TO service_role;


--
-- Name: FUNCTION wallet_debit(p_user uuid, p_spend integer, p_cashback integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.wallet_debit(p_user uuid, p_spend integer, p_cashback integer) TO anon;
GRANT ALL ON FUNCTION public.wallet_debit(p_user uuid, p_spend integer, p_cashback integer) TO authenticated;
GRANT ALL ON FUNCTION public.wallet_debit(p_user uuid, p_spend integer, p_cashback integer) TO service_role;


--
-- Name: TABLE admin_config; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_config TO anon;
GRANT ALL ON TABLE public.admin_config TO authenticated;
GRANT ALL ON TABLE public.admin_config TO service_role;


--
-- Name: TABLE application_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.application_events TO anon;
GRANT ALL ON TABLE public.application_events TO authenticated;
GRANT ALL ON TABLE public.application_events TO service_role;


--
-- Name: TABLE book_availability_rules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.book_availability_rules TO anon;
GRANT ALL ON TABLE public.book_availability_rules TO authenticated;
GRANT ALL ON TABLE public.book_availability_rules TO service_role;


--
-- Name: TABLE book_bookings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.book_bookings TO anon;
GRANT ALL ON TABLE public.book_bookings TO authenticated;
GRANT ALL ON TABLE public.book_bookings TO service_role;


--
-- Name: TABLE book_gifts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.book_gifts TO anon;
GRANT ALL ON TABLE public.book_gifts TO authenticated;
GRANT ALL ON TABLE public.book_gifts TO service_role;


--
-- Name: TABLE book_services; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.book_services TO anon;
GRANT ALL ON TABLE public.book_services TO authenticated;
GRANT ALL ON TABLE public.book_services TO service_role;


--
-- Name: TABLE book_slot_overrides; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.book_slot_overrides TO anon;
GRANT ALL ON TABLE public.book_slot_overrides TO authenticated;
GRANT ALL ON TABLE public.book_slot_overrides TO service_role;


--
-- Name: TABLE book_unit_items; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.book_unit_items TO anon;
GRANT ALL ON TABLE public.book_unit_items TO authenticated;
GRANT ALL ON TABLE public.book_unit_items TO service_role;


--
-- Name: TABLE book_unit_purchases; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.book_unit_purchases TO anon;
GRANT ALL ON TABLE public.book_unit_purchases TO authenticated;
GRANT ALL ON TABLE public.book_unit_purchases TO service_role;


--
-- Name: TABLE business_addons; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.business_addons TO anon;
GRANT ALL ON TABLE public.business_addons TO authenticated;
GRANT ALL ON TABLE public.business_addons TO service_role;


--
-- Name: TABLE business_alert_access; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.business_alert_access TO anon;
GRANT ALL ON TABLE public.business_alert_access TO authenticated;
GRANT ALL ON TABLE public.business_alert_access TO service_role;


--
-- Name: TABLE business_claims; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.business_claims TO anon;
GRANT ALL ON TABLE public.business_claims TO authenticated;
GRANT ALL ON TABLE public.business_claims TO service_role;


--
-- Name: TABLE business_discount_grants; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.business_discount_grants TO anon;
GRANT ALL ON TABLE public.business_discount_grants TO authenticated;
GRANT ALL ON TABLE public.business_discount_grants TO service_role;


--
-- Name: TABLE compliance_log; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.compliance_log TO anon;
GRANT ALL ON TABLE public.compliance_log TO authenticated;
GRANT ALL ON TABLE public.compliance_log TO service_role;


--
-- Name: TABLE cruise_visits; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cruise_visits TO anon;
GRANT ALL ON TABLE public.cruise_visits TO authenticated;
GRANT ALL ON TABLE public.cruise_visits TO service_role;


--
-- Name: TABLE cruise_day_summary; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cruise_day_summary TO anon;
GRANT ALL ON TABLE public.cruise_day_summary TO authenticated;
GRANT ALL ON TABLE public.cruise_day_summary TO service_role;


--
-- Name: TABLE cruise_ships; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cruise_ships TO anon;
GRANT ALL ON TABLE public.cruise_ships TO authenticated;
GRANT ALL ON TABLE public.cruise_ships TO service_role;


--
-- Name: TABLE cv_documents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.cv_documents TO anon;
GRANT ALL ON TABLE public.cv_documents TO authenticated;
GRANT ALL ON TABLE public.cv_documents TO service_role;


--
-- Name: TABLE delivery_categories; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.delivery_categories TO anon;
GRANT ALL ON TABLE public.delivery_categories TO authenticated;
GRANT ALL ON TABLE public.delivery_categories TO service_role;


--
-- Name: TABLE delivery_fees; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.delivery_fees TO anon;
GRANT ALL ON TABLE public.delivery_fees TO authenticated;
GRANT ALL ON TABLE public.delivery_fees TO service_role;


--
-- Name: TABLE delivery_pricing_config; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.delivery_pricing_config TO anon;
GRANT ALL ON TABLE public.delivery_pricing_config TO authenticated;
GRANT ALL ON TABLE public.delivery_pricing_config TO service_role;


--
-- Name: TABLE delivery_requests; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.delivery_requests TO anon;
GRANT ALL ON TABLE public.delivery_requests TO authenticated;
GRANT ALL ON TABLE public.delivery_requests TO service_role;


--
-- Name: TABLE driver_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.driver_profiles TO anon;
GRANT ALL ON TABLE public.driver_profiles TO authenticated;
GRANT ALL ON TABLE public.driver_profiles TO service_role;


--
-- Name: TABLE email_log; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.email_log TO anon;
GRANT ALL ON TABLE public.email_log TO authenticated;
GRANT ALL ON TABLE public.email_log TO service_role;


--
-- Name: TABLE email_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.email_settings TO anon;
GRANT ALL ON TABLE public.email_settings TO authenticated;
GRANT ALL ON TABLE public.email_settings TO service_role;


--
-- Name: TABLE email_templates; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.email_templates TO anon;
GRANT ALL ON TABLE public.email_templates TO authenticated;
GRANT ALL ON TABLE public.email_templates TO service_role;


--
-- Name: TABLE event_checkins; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.event_checkins TO anon;
GRANT ALL ON TABLE public.event_checkins TO authenticated;
GRANT ALL ON TABLE public.event_checkins TO service_role;


--
-- Name: TABLE event_ticket_orders; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.event_ticket_orders TO anon;
GRANT ALL ON TABLE public.event_ticket_orders TO authenticated;
GRANT ALL ON TABLE public.event_ticket_orders TO service_role;


--
-- Name: TABLE event_ticket_types; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.event_ticket_types TO anon;
GRANT ALL ON TABLE public.event_ticket_types TO authenticated;
GRANT ALL ON TABLE public.event_ticket_types TO service_role;


--
-- Name: TABLE event_tickets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.event_tickets TO anon;
GRANT ALL ON TABLE public.event_tickets TO authenticated;
GRANT ALL ON TABLE public.event_tickets TO service_role;


--
-- Name: TABLE event_updates; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.event_updates TO anon;
GRANT ALL ON TABLE public.event_updates TO authenticated;
GRANT ALL ON TABLE public.event_updates TO service_role;


--
-- Name: TABLE events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.events TO anon;
GRANT ALL ON TABLE public.events TO authenticated;
GRANT ALL ON TABLE public.events TO service_role;


--
-- Name: TABLE game_shetland_places; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.game_shetland_places TO anon;
GRANT ALL ON TABLE public.game_shetland_places TO authenticated;
GRANT ALL ON TABLE public.game_shetland_places TO service_role;


--
-- Name: TABLE games_scores; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.games_scores TO anon;
GRANT ALL ON TABLE public.games_scores TO authenticated;
GRANT ALL ON TABLE public.games_scores TO service_role;


--
-- Name: TABLE games_user_stats; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.games_user_stats TO anon;
GRANT ALL ON TABLE public.games_user_stats TO authenticated;
GRANT ALL ON TABLE public.games_user_stats TO service_role;


--
-- Name: TABLE hub_campaigns; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.hub_campaigns TO anon;
GRANT ALL ON TABLE public.hub_campaigns TO authenticated;
GRANT ALL ON TABLE public.hub_campaigns TO service_role;


--
-- Name: TABLE hub_documents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.hub_documents TO anon;
GRANT ALL ON TABLE public.hub_documents TO authenticated;
GRANT ALL ON TABLE public.hub_documents TO service_role;


--
-- Name: TABLE hub_donations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.hub_donations TO anon;
GRANT ALL ON TABLE public.hub_donations TO authenticated;
GRANT ALL ON TABLE public.hub_donations TO service_role;


--
-- Name: TABLE hub_members; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.hub_members TO anon;
GRANT ALL ON TABLE public.hub_members TO authenticated;
GRANT ALL ON TABLE public.hub_members TO service_role;


--
-- Name: TABLE hub_membership_types; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.hub_membership_types TO anon;
GRANT ALL ON TABLE public.hub_membership_types TO authenticated;
GRANT ALL ON TABLE public.hub_membership_types TO service_role;


--
-- Name: TABLE hubs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.hubs TO anon;
GRANT ALL ON TABLE public.hubs TO authenticated;
GRANT ALL ON TABLE public.hubs TO service_role;


--
-- Name: TABLE job_applications; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.job_applications TO anon;
GRANT ALL ON TABLE public.job_applications TO authenticated;
GRANT ALL ON TABLE public.job_applications TO service_role;


--
-- Name: TABLE jobs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.jobs TO anon;
GRANT ALL ON TABLE public.jobs TO authenticated;
GRANT ALL ON TABLE public.jobs TO service_role;


--
-- Name: TABLE local_boost_purchases; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.local_boost_purchases TO anon;
GRANT ALL ON TABLE public.local_boost_purchases TO authenticated;
GRANT ALL ON TABLE public.local_boost_purchases TO service_role;


--
-- Name: TABLE local_business_codes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.local_business_codes TO anon;
GRANT ALL ON TABLE public.local_business_codes TO authenticated;
GRANT ALL ON TABLE public.local_business_codes TO service_role;


--
-- Name: TABLE local_business_follows; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.local_business_follows TO anon;
GRANT ALL ON TABLE public.local_business_follows TO authenticated;
GRANT ALL ON TABLE public.local_business_follows TO service_role;


--
-- Name: TABLE local_businesses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.local_businesses TO anon;
GRANT ALL ON TABLE public.local_businesses TO authenticated;
GRANT ALL ON TABLE public.local_businesses TO service_role;


--
-- Name: TABLE local_loyalty_cards; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.local_loyalty_cards TO anon;
GRANT ALL ON TABLE public.local_loyalty_cards TO authenticated;
GRANT ALL ON TABLE public.local_loyalty_cards TO service_role;


--
-- Name: TABLE local_loyalty_programs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.local_loyalty_programs TO anon;
GRANT ALL ON TABLE public.local_loyalty_programs TO authenticated;
GRANT ALL ON TABLE public.local_loyalty_programs TO service_role;


--
-- Name: TABLE local_loyalty_transactions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.local_loyalty_transactions TO anon;
GRANT ALL ON TABLE public.local_loyalty_transactions TO authenticated;
GRANT ALL ON TABLE public.local_loyalty_transactions TO service_role;


--
-- Name: TABLE local_offer_redemptions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.local_offer_redemptions TO anon;
GRANT ALL ON TABLE public.local_offer_redemptions TO authenticated;
GRANT ALL ON TABLE public.local_offer_redemptions TO service_role;


--
-- Name: TABLE local_offers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.local_offers TO anon;
GRANT ALL ON TABLE public.local_offers TO authenticated;
GRANT ALL ON TABLE public.local_offers TO service_role;


--
-- Name: TABLE local_wallet_balances; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.local_wallet_balances TO anon;
GRANT ALL ON TABLE public.local_wallet_balances TO authenticated;
GRANT ALL ON TABLE public.local_wallet_balances TO service_role;


--
-- Name: TABLE local_wallet_transactions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.local_wallet_transactions TO anon;
GRANT ALL ON TABLE public.local_wallet_transactions TO authenticated;
GRANT ALL ON TABLE public.local_wallet_transactions TO service_role;


--
-- Name: TABLE measurements; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.measurements TO anon;
GRANT ALL ON TABLE public.measurements TO authenticated;
GRANT ALL ON TABLE public.measurements TO service_role;


--
-- Name: TABLE media_assets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.media_assets TO anon;
GRANT ALL ON TABLE public.media_assets TO authenticated;
GRANT ALL ON TABLE public.media_assets TO service_role;


--
-- Name: TABLE memories; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.memories TO anon;
GRANT ALL ON TABLE public.memories TO authenticated;
GRANT ALL ON TABLE public.memories TO service_role;


--
-- Name: TABLE memory_comments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.memory_comments TO anon;
GRANT ALL ON TABLE public.memory_comments TO authenticated;
GRANT ALL ON TABLE public.memory_comments TO service_role;


--
-- Name: TABLE memory_image_pin_suggestions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.memory_image_pin_suggestions TO anon;
GRANT ALL ON TABLE public.memory_image_pin_suggestions TO authenticated;
GRANT ALL ON TABLE public.memory_image_pin_suggestions TO service_role;


--
-- Name: TABLE memory_media; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.memory_media TO anon;
GRANT ALL ON TABLE public.memory_media TO authenticated;
GRANT ALL ON TABLE public.memory_media TO service_role;


--
-- Name: TABLE memory_reactions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.memory_reactions TO anon;
GRANT ALL ON TABLE public.memory_reactions TO authenticated;
GRANT ALL ON TABLE public.memory_reactions TO service_role;


--
-- Name: TABLE notices; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notices TO anon;
GRANT ALL ON TABLE public.notices TO authenticated;
GRANT ALL ON TABLE public.notices TO service_role;


--
-- Name: TABLE notification_log; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notification_log TO anon;
GRANT ALL ON TABLE public.notification_log TO authenticated;
GRANT ALL ON TABLE public.notification_log TO service_role;


--
-- Name: TABLE notification_preferences; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notification_preferences TO anon;
GRANT ALL ON TABLE public.notification_preferences TO authenticated;
GRANT ALL ON TABLE public.notification_preferences TO service_role;


--
-- Name: TABLE oneshetland_feed; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.oneshetland_feed TO anon;
GRANT ALL ON TABLE public.oneshetland_feed TO authenticated;
GRANT ALL ON TABLE public.oneshetland_feed TO service_role;


--
-- Name: TABLE owners; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.owners TO anon;
GRANT ALL ON TABLE public.owners TO authenticated;
GRANT ALL ON TABLE public.owners TO service_role;


--
-- Name: TABLE ownership_periods; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ownership_periods TO anon;
GRANT ALL ON TABLE public.ownership_periods TO authenticated;
GRANT ALL ON TABLE public.ownership_periods TO service_role;


--
-- Name: TABLE partner_alerts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.partner_alerts TO anon;
GRANT ALL ON TABLE public.partner_alerts TO authenticated;
GRANT ALL ON TABLE public.partner_alerts TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.profiles TO anon;
GRANT ALL ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;


--
-- Name: TABLE regions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.regions TO anon;
GRANT ALL ON TABLE public.regions TO authenticated;
GRANT ALL ON TABLE public.regions TO service_role;


--
-- Name: TABLE registrations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.registrations TO anon;
GRANT ALL ON TABLE public.registrations TO authenticated;
GRANT ALL ON TABLE public.registrations TO service_role;


--
-- Name: TABLE runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.runs TO anon;
GRANT ALL ON TABLE public.runs TO authenticated;
GRANT ALL ON TABLE public.runs TO service_role;


--
-- Name: TABLE saved_addresses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.saved_addresses TO anon;
GRANT ALL ON TABLE public.saved_addresses TO authenticated;
GRANT ALL ON TABLE public.saved_addresses TO service_role;


--
-- Name: TABLE saved_jobs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.saved_jobs TO anon;
GRANT ALL ON TABLE public.saved_jobs TO authenticated;
GRANT ALL ON TABLE public.saved_jobs TO service_role;


--
-- Name: TABLE shift_alerts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.shift_alerts TO anon;
GRANT ALL ON TABLE public.shift_alerts TO authenticated;
GRANT ALL ON TABLE public.shift_alerts TO service_role;


--
-- Name: TABLE shift_applications; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.shift_applications TO anon;
GRANT ALL ON TABLE public.shift_applications TO authenticated;
GRANT ALL ON TABLE public.shift_applications TO service_role;


--
-- Name: TABLE shift_availability; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.shift_availability TO anon;
GRANT ALL ON TABLE public.shift_availability TO authenticated;
GRANT ALL ON TABLE public.shift_availability TO service_role;


--
-- Name: TABLE shift_check_ins; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.shift_check_ins TO anon;
GRANT ALL ON TABLE public.shift_check_ins TO authenticated;
GRANT ALL ON TABLE public.shift_check_ins TO service_role;


--
-- Name: TABLE shift_employer_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.shift_employer_profiles TO anon;
GRANT ALL ON TABLE public.shift_employer_profiles TO authenticated;
GRANT ALL ON TABLE public.shift_employer_profiles TO service_role;


--
-- Name: TABLE shift_payments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.shift_payments TO anon;
GRANT ALL ON TABLE public.shift_payments TO authenticated;
GRANT ALL ON TABLE public.shift_payments TO service_role;


--
-- Name: TABLE shift_qualifications; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.shift_qualifications TO anon;
GRANT ALL ON TABLE public.shift_qualifications TO authenticated;
GRANT ALL ON TABLE public.shift_qualifications TO service_role;


--
-- Name: TABLE shift_reviews; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.shift_reviews TO anon;
GRANT ALL ON TABLE public.shift_reviews TO authenticated;
GRANT ALL ON TABLE public.shift_reviews TO service_role;


--
-- Name: TABLE shift_worker_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.shift_worker_profiles TO anon;
GRANT ALL ON TABLE public.shift_worker_profiles TO authenticated;
GRANT ALL ON TABLE public.shift_worker_profiles TO service_role;


--
-- Name: TABLE shifts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.shifts TO anon;
GRANT ALL ON TABLE public.shifts TO authenticated;
GRANT ALL ON TABLE public.shifts TO service_role;


--
-- Name: TABLE ship_positions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ship_positions TO anon;
GRANT ALL ON TABLE public.ship_positions TO authenticated;
GRANT ALL ON TABLE public.ship_positions TO service_role;


--
-- Name: TABLE source_documents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.source_documents TO anon;
GRANT ALL ON TABLE public.source_documents TO authenticated;
GRANT ALL ON TABLE public.source_documents TO service_role;


--
-- Name: TABLE source_records; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.source_records TO anon;
GRANT ALL ON TABLE public.source_records TO authenticated;
GRANT ALL ON TABLE public.source_records TO service_role;


--
-- Name: TABLE spik_dictionary; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.spik_dictionary TO anon;
GRANT ALL ON TABLE public.spik_dictionary TO authenticated;
GRANT ALL ON TABLE public.spik_dictionary TO service_role;


--
-- Name: TABLE spik_suggestions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.spik_suggestions TO anon;
GRANT ALL ON TABLE public.spik_suggestions TO authenticated;
GRANT ALL ON TABLE public.spik_suggestions TO service_role;


--
-- Name: TABLE vessel_comments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vessel_comments TO anon;
GRANT ALL ON TABLE public.vessel_comments TO authenticated;
GRANT ALL ON TABLE public.vessel_comments TO service_role;


--
-- Name: TABLE vessel_edit_votes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vessel_edit_votes TO anon;
GRANT ALL ON TABLE public.vessel_edit_votes TO authenticated;
GRANT ALL ON TABLE public.vessel_edit_votes TO service_role;


--
-- Name: TABLE vessel_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vessel_events TO anon;
GRANT ALL ON TABLE public.vessel_events TO authenticated;
GRANT ALL ON TABLE public.vessel_events TO service_role;


--
-- Name: TABLE vessel_media_links; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vessel_media_links TO anon;
GRANT ALL ON TABLE public.vessel_media_links TO authenticated;
GRANT ALL ON TABLE public.vessel_media_links TO service_role;


--
-- Name: TABLE vessel_names; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vessel_names TO anon;
GRANT ALL ON TABLE public.vessel_names TO authenticated;
GRANT ALL ON TABLE public.vessel_names TO service_role;


--
-- Name: TABLE vessel_relationships; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vessel_relationships TO anon;
GRANT ALL ON TABLE public.vessel_relationships TO authenticated;
GRANT ALL ON TABLE public.vessel_relationships TO service_role;


--
-- Name: TABLE vessel_source_links; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vessel_source_links TO anon;
GRANT ALL ON TABLE public.vessel_source_links TO authenticated;
GRANT ALL ON TABLE public.vessel_source_links TO service_role;


--
-- Name: TABLE vessels; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vessels TO anon;
GRANT ALL ON TABLE public.vessels TO authenticated;
GRANT ALL ON TABLE public.vessels TO service_role;


--
-- Name: TABLE vessel_search; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vessel_search TO anon;
GRANT ALL ON TABLE public.vessel_search TO authenticated;
GRANT ALL ON TABLE public.vessel_search TO service_role;


--
-- Name: TABLE vessel_timeline; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.vessel_timeline TO anon;
GRANT ALL ON TABLE public.vessel_timeline TO authenticated;
GRANT ALL ON TABLE public.vessel_timeline TO service_role;


--
-- Name: TABLE waiting_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.waiting_events TO anon;
GRANT ALL ON TABLE public.waiting_events TO authenticated;
GRANT ALL ON TABLE public.waiting_events TO service_role;


--
-- Name: TABLE worker_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.worker_profiles TO anon;
GRANT ALL ON TABLE public.worker_profiles TO authenticated;
GRANT ALL ON TABLE public.worker_profiles TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict KKGIjwdlA8I5QVvRKzQV78KqOpzMh0xzyEVvFTCytipYLFSIgHGMiIj5pu8E1SO

