-- Drop-off region the buyer picks at checkout for a Fetch shop order. Drivers'
-- runs are matched on destination_region_id, so a spawned delivery_request
-- without a region could never be covered by a run — the buyer has to tell us
-- the area, a postcode can't (ZE1/ZE2 span the whole of Shetland).

alter table public.product_orders
  add column if not exists delivery_region_slug text;
