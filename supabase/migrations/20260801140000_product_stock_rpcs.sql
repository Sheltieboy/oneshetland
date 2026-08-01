-- Atomic stock lifecycle for product checkout. Reservation happens at intent
-- time so two buyers can never both pay for the last item; commit happens on
-- payment; release on expiry/cancel. Service-role only — clients never touch
-- stock directly.

create or replace function public.reserve_product_stock(p_product uuid, p_variant uuid, p_qty int)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare ok boolean;
begin
  if p_qty is null or p_qty < 1 then return false; end if;

  if p_variant is not null then
    update product_variants v set reserved = v.reserved + p_qty
    where v.id = p_variant and v.product_id = p_product and v.is_active
      and (v.stock is null or v.stock - v.reserved >= p_qty)
    returning true into ok;
    if not coalesce(ok, false) then return false; end if;
  end if;

  ok := null;
  update products p set reserved = p.reserved + p_qty
  where p.id = p_product and p.is_active and p.sold_at is null
    and (
      p.stock_mode = 'made_to_order'
      or (p.stock_mode = 'one_off' and p_qty = 1 and p.reserved = 0)
      or (p.stock_mode = 'tracked' and (p.stock is null or p.stock - p.reserved >= p_qty))
    )
  returning true into ok;

  if not coalesce(ok, false) then
    if p_variant is not null then
      update product_variants set reserved = greatest(0, reserved - p_qty) where id = p_variant;
    end if;
    return false;
  end if;
  return true;
end
$$;

create or replace function public.release_product_stock(p_product uuid, p_variant uuid, p_qty int)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_qty is null or p_qty < 1 then return; end if;
  update products set reserved = greatest(0, reserved - p_qty) where id = p_product;
  if p_variant is not null then
    update product_variants set reserved = greatest(0, reserved - p_qty) where id = p_variant;
  end if;
end
$$;

create or replace function public.commit_product_stock(p_product uuid, p_variant uuid, p_qty int)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_qty is null or p_qty < 1 then return; end if;
  update products set
    reserved = greatest(0, reserved - p_qty),
    stock    = case when stock_mode = 'tracked' and stock is not null
                    then greatest(0, stock - p_qty) else stock end,
    sold_at  = case when stock_mode = 'one_off' then now() else sold_at end,
    is_active = case when stock_mode = 'one_off' then false else is_active end
  where id = p_product;
  if p_variant is not null then
    update product_variants set
      reserved = greatest(0, reserved - p_qty),
      stock    = case when stock is not null then greatest(0, stock - p_qty) else stock end
    where id = p_variant;
  end if;
end
$$;

revoke all on function public.reserve_product_stock(uuid, uuid, int) from public, anon, authenticated;
revoke all on function public.release_product_stock(uuid, uuid, int) from public, anon, authenticated;
revoke all on function public.commit_product_stock(uuid, uuid, int) from public, anon, authenticated;

-- Analytics: register the purchase event so it's stamped as a conversion.
insert into public.analytics_event_defs (event_name, is_conversion, category, description) values
  ('product_order_paid', true, 'sales', 'Paid for a product order (server-logged)')
on conflict (event_name) do nothing;
