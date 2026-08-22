/**
 * lib/products-api.ts — Shop Shetland (commerce) API for the app.
 * Mirrors the web's lib/shop-data.ts + shop actions. Buyer reads are public
 * (RLS); merchant writes ride the owner RLS policies; checkout goes through
 * the create-product-order-intent edge function.
 */

import { supabase } from './supabase';
import { settleSavedCardPayment, type PaymentStart } from './stripe-sca';

export type StockMode = 'tracked' | 'made_to_order' | 'one_off';

export type Product = {
  id: string;
  business_id: string;
  title: string;
  description: string | null;
  category: string | null;
  price_pence: number;
  compare_at_pence: number | null;
  photos: string[];
  stock_mode: StockMode;
  stock: number | null;
  reserved: number;
  lead_time_days: number | null;
  collect_only: boolean;
  free_uk_post: boolean;
  is_active: boolean;
  sold_at: string | null;
  created_at: string;
};

export type ProductVariant = {
  id: string;
  product_id: string;
  name: string;
  price_delta_pence: number;
  stock: number | null;
  reserved: number;
  position: number;
  is_active: boolean;
};

export type BusinessShipping = {
  business_id: string;
  collect_enabled: boolean;
  collect_note: string | null;
  post_enabled: boolean;
  post_shetland_pence: number | null;
  post_uk_pence: number | null;
  post_per_extra_item_pence: number;
  free_over_pence: number | null;
  fetch_enabled: boolean;
};

export type ProductOrder = {
  id: string;
  business_id: string;
  buyer_id: string;
  status: string;
  fulfilment: 'collect' | 'post' | 'fetch';
  items_pence: number;
  shipping_pence: number;
  total_pence: number;
  delivery_name: string | null;
  delivery_address: string | null;
  delivery_postcode: string | null;
  contact_phone: string | null;
  buyer_note: string | null;
  tracking_ref: string | null;
  created_at: string;
  paid_at: string | null;
  items?: { title: string; variant_name: string | null; qty: number; unit_pence: number }[];
};

export const PRODUCT_CATEGORIES: { value: string; label: string }[] = [
  { value: 'knitwear', label: 'Knitwear' },
  { value: 'craft', label: 'Craft' },
  { value: 'art', label: 'Art & prints' },
  { value: 'food_drink', label: 'Food & drink' },
  { value: 'home', label: 'Home' },
  { value: 'beauty', label: 'Health & beauty' },
  { value: 'outdoor', label: 'Outdoor' },
  { value: 'books_music', label: 'Books & music' },
  { value: 'other', label: 'Other' },
];

export const BUYER_STATUS_LABEL: Record<string, string> = {
  paid: 'Order received',
  accepted: 'Being prepared',
  ready: 'Ready to collect',
  handed_over: 'On its way',
  posted: 'In the post',
  completed: 'Done',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};

/** Decode an edge-function error into something readable (same as local-api). */
async function fnErr(error: unknown, fallback: string): Promise<Error> {
  try {
    const ctx = (error as { context?: Response }).context;
    if (ctx) {
      const body = await ctx.json();
      if (body?.error) return new Error(body.error);
    }
  } catch { /* fall through */ }
  return error instanceof Error ? error : new Error(fallback);
}

export function availableQty(p: Product, v?: ProductVariant | null): number {
  if (!p.is_active || p.sold_at) return 0;
  if (p.stock_mode === 'made_to_order') return 99;
  if (p.stock_mode === 'one_off') return p.reserved > 0 ? 0 : 1;
  if (v && v.stock != null) return Math.max(0, v.stock - v.reserved);
  if (p.stock == null) return 99;
  return Math.max(0, p.stock - p.reserved);
}

export function shippingQuote(
  ship: BusinessShipping | null,
  itemsPence: number,
  totalQty: number,
  postcode: string,
  allFreeUkPost: boolean,
): number {
  if (!ship?.post_enabled) return 0;
  if (allFreeUkPost) return 0;
  const isShetland = postcode.trim().toUpperCase().startsWith('ZE');
  const base = isShetland ? (ship.post_shetland_pence ?? ship.post_uk_pence ?? 0) : (ship.post_uk_pence ?? 0);
  let quote = base + (ship.post_per_extra_item_pence ?? 0) * Math.max(0, totalQty - 1);
  if (ship.free_over_pence && itemsPence >= ship.free_over_pence) quote = 0;
  return quote;
}

/* ── Buyer reads ─────────────────────────────────────────────────────────── */

export async function fetchShopProducts(businessId: string): Promise<Product[]> {
  const { data, error } = await supabase
    .from('products').select('*')
    .eq('business_id', businessId).eq('is_active', true)
    .order('created_at', { ascending: false }).limit(60);
  if (error) throw error;
  return (data ?? []) as Product[];
}

/** A product's category value — the set is PRODUCT_CATEGORIES above. */
export type ProductCategory = string;

export type BrowseProduct = Product & { business_name: string };
export type BrowseSort = 'newest' | 'price_low' | 'price_high';

/**
 * Everything on sale across Shetland, for the standalone Shop surface.
 *
 * Sold-out one-offs are excluded (`sold_at`), and so are products whose shop
 * has been deactivated — the join can't filter that server-side without an
 * inner-join hint, so the rows are dropped here and the page asks for a few
 * more than it needs.
 */
export async function browseProducts(opts: {
  category?: ProductCategory | null;
  query?: string;
  sort?: BrowseSort;
  limit?: number;
  offset?: number;
} = {}): Promise<BrowseProduct[]> {
  const { category = null, query = '', sort = 'newest', limit = 24, offset = 0 } = opts;

  let q = supabase
    .from('products')
    .select('*, business:local_businesses!inner(name, is_active)')
    .eq('is_active', true)
    .is('sold_at', null)
    .eq('business.is_active', true);

  if (category) q = q.eq('category', category);
  if (query.trim()) {
    const safe = query.trim().replace(/[%,]/g, ' ');
    q = q.or(`title.ilike.%${safe}%,description.ilike.%${safe}%`);
  }

  if (sort === 'price_low') q = q.order('price_pence', { ascending: true });
  else if (sort === 'price_high') q = q.order('price_pence', { ascending: false });
  else q = q.order('created_at', { ascending: false });

  const { data, error } = await q.range(offset, offset + limit - 1);
  if (error) throw error;

  return ((data ?? []) as Record<string, unknown>[]).map((p) => {
    const biz = (Array.isArray(p.business) ? p.business[0] : p.business) as { name?: string } | null;
    const { business: _drop, ...rest } = p;
    return { ...(rest as unknown as Product), business_name: biz?.name ?? 'A Shetland shop' };
  });
}

export async function fetchProduct(id: string): Promise<{ product: Product; variants: ProductVariant[]; shipping: BusinessShipping | null; businessName: string } | null> {
  const { data: product } = await supabase.from('products').select('*').eq('id', id).maybeSingle();
  if (!product) return null;
  const [{ data: variants }, { data: shipping }, { data: biz }] = await Promise.all([
    supabase.from('product_variants').select('*').eq('product_id', id).eq('is_active', true).order('position'),
    supabase.from('business_shipping').select('*').eq('business_id', product.business_id).maybeSingle(),
    supabase.from('local_businesses').select('name').eq('id', product.business_id).maybeSingle(),
  ]);
  return {
    product: product as Product,
    variants: (variants ?? []) as ProductVariant[],
    shipping: (shipping ?? null) as BusinessShipping | null,
    businessName: biz?.name ?? 'this shop',
  };
}

/* ── Checkout ────────────────────────────────────────────────────────────── */

export type ProductOrderResult = {
  charged?: boolean;
  clientSecret?: string;
  order_id: string;
  balance_pence?: number;
};

export async function createProductOrder(body: {
  business_id: string;
  items: { product_id: string; variant_id?: string | null; qty: number }[];
  fulfilment: 'collect' | 'post' | 'fetch';
  delivery?: { name: string; address: string; postcode: string; phone?: string };
  note?: string;
  pay_with?: 'card' | 'wallet';
  use_saved_card?: boolean;
}): Promise<ProductOrderResult> {
  const { data, error } = await supabase.functions.invoke('create-product-order-intent', { body });
  if (error) throw await fnErr(error, "Couldn't start the order");
  if (data?.error) throw new Error(data.error);

  // A saved-card charge the issuer wants authenticated is PAUSED, not failed.
  // Finish that same PaymentIntent here so every screen sees a settled result
  // and no second intent is ever created. The PaymentSheet path is untouched:
  // it has no `status`, so this returns straight through.
  const settled = await settleSavedCardPayment(data as PaymentStart);
  if (settled.outcome === 'cancelled') throw new Error('Payment cancelled — nothing was charged.');
  if (settled.outcome === 'failed') throw new Error(settled.message);
  if (settled.outcome === 'succeeded') return { ...data, charged: true } as ProductOrderResult;
  return data as ProductOrderResult;
}

export async function fetchMyOrders(): Promise<ProductOrder[]> {
  const { data, error } = await supabase
    .from('product_orders')
    .select('*, items:product_order_items(title, variant_name, qty, unit_pence)')
    .neq('status', 'pending').neq('status', 'expired')
    .order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return (data ?? []) as ProductOrder[];
}

export type FreshProduct = {
  id: string;
  title: string;
  price_pence: number;
  photo: string;
  business_name: string;
};

/** Newest products across every shop — the app-Home discovery rail. */
export async function fetchFreshProducts(limit = 10): Promise<FreshProduct[]> {
  try {
    const { data } = await supabase
      .from('products')
      .select('id, title, price_pence, photos, business:local_businesses(name, is_active)')
      .eq('is_active', true)
      .is('sold_at', null)
      .order('created_at', { ascending: false })
      .limit(24);
    const out: FreshProduct[] = [];
    for (const p of (data ?? []) as Record<string, unknown>[]) {
      const biz = (Array.isArray(p.business) ? (p.business as Record<string, unknown>[])[0] : p.business) as { name?: string; is_active?: boolean } | null;
      const photo = (p.photos as string[])?.[0];
      if (!biz?.is_active || !biz.name || !photo) continue;
      out.push({ id: p.id as string, title: p.title as string, price_pence: p.price_pence as number, photo, business_name: biz.name });
      if (out.length >= limit) break;
    }
    return out;
  } catch { return []; }
}

export type ProductThumbs = { photos: string[]; count: number };

/** One batched query: product thumbs for a set of businesses (≤3 photos + count). */
export async function fetchProductThumbs(businessIds: string[]): Promise<Record<string, ProductThumbs>> {
  const out: Record<string, ProductThumbs> = {};
  if (!businessIds.length) return out;
  try {
    const { data } = await supabase
      .from('products')
      .select('business_id, photos')
      .in('business_id', [...new Set(businessIds)])
      .eq('is_active', true)
      .is('sold_at', null)
      .order('created_at', { ascending: false })
      .limit(200);
    for (const p of (data ?? []) as { business_id: string; photos: string[] }[]) {
      const photo = p.photos?.[0];
      const entry = (out[p.business_id] ??= { photos: [], count: 0 });
      entry.count += 1;
      if (photo && entry.photos.length < 3) entry.photos.push(photo);
    }
    for (const k of Object.keys(out)) if (out[k].photos.length === 0) delete out[k];
  } catch { /* decorative — never break a listing */ }
  return out;
}

/* ── Merchant ────────────────────────────────────────────────────────────── */

export async function fetchMerchantProducts(businessId: string): Promise<Product[]> {
  const { data, error } = await supabase
    .from('products').select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Product[];
}

export async function fetchProductVariants(productIds: string[]): Promise<Record<string, ProductVariant[]>> {
  if (!productIds.length) return {};
  const { data } = await supabase.from('product_variants').select('*').in('product_id', productIds).order('position');
  const out: Record<string, ProductVariant[]> = {};
  for (const v of (data ?? []) as ProductVariant[]) (out[v.product_id] ??= []).push(v);
  return out;
}

export type ProductUpsertInput = {
  id?: string;
  business_id: string;
  title: string;
  description: string | null;
  category: string | null;
  price_pence: number;
  photos: string[];
  stock_mode: StockMode;
  stock: number | null;
  lead_time_days: number | null;
  collect_only: boolean;
  free_uk_post: boolean;
  is_active: boolean;
};

export async function upsertProduct(input: ProductUpsertInput, variants: { id?: string; name: string; price_delta_pence: number; stock: number | null }[]): Promise<string> {
  const { id, ...row } = input;
  let productId = id;
  if (productId) {
    const { error } = await supabase.from('products').update(row).eq('id', productId);
    if (error) throw error;
  } else {
    const { data, error } = await supabase.from('products').insert(row).select('id').single();
    if (error) throw error;
    productId = (data as { id: string }).id;
  }
  // Replace-all keeps the merchant mental model simple.
  const keep = variants.filter((v) => v.id).map((v) => v.id as string);
  const { data: existing } = await supabase.from('product_variants').select('id').eq('product_id', productId);
  const gone = (existing ?? []).map((e) => e.id).filter((x) => !keep.includes(x));
  if (gone.length) await supabase.from('product_variants').delete().in('id', gone);
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    if (!v.name.trim()) continue;
    const vrow = { product_id: productId, name: v.name.trim(), price_delta_pence: v.price_delta_pence, stock: v.stock, position: i, is_active: true };
    if (v.id) { const { error } = await supabase.from('product_variants').update(vrow).eq('id', v.id); if (error) throw error; }
    else { const { error } = await supabase.from('product_variants').insert(vrow); if (error) throw error; }
  }
  return productId;
}

export async function setProductActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('products').update({ is_active: active }).eq('id', id);
  if (error) throw error;
}

export async function deleteProduct(id: string): Promise<void> {
  const { error } = await supabase.from('products').delete().eq('id', id);
  if (error) throw error;
}

export async function fetchShipping(businessId: string): Promise<BusinessShipping | null> {
  const { data } = await supabase.from('business_shipping').select('*').eq('business_id', businessId).maybeSingle();
  return (data ?? null) as BusinessShipping | null;
}

export async function saveShipping(row: BusinessShipping): Promise<void> {
  const { error } = await supabase.from('business_shipping').upsert(row);
  if (error) throw error;
}

export async function fetchBusinessOrders(businessId: string): Promise<ProductOrder[]> {
  const { data, error } = await supabase
    .from('product_orders')
    .select('*, items:product_order_items(title, variant_name, qty, unit_pence)')
    .eq('business_id', businessId)
    .neq('status', 'pending').neq('status', 'expired')
    .order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  return (data ?? []) as ProductOrder[];
}

export async function updateOrderStatus(orderId: string, to: string, trackingRef?: string): Promise<void> {
  const patch: Record<string, unknown> = { status: to };
  const stamp = new Date().toISOString();
  if (to === 'accepted') patch.accepted_at = stamp;
  if (to === 'ready') patch.ready_at = stamp;
  if (to === 'posted') { patch.posted_at = stamp; if (trackingRef?.trim()) patch.tracking_ref = trackingRef.trim(); }
  if (to === 'completed') patch.completed_at = stamp;
  const { error } = await supabase.from('product_orders').update(patch).eq('id', orderId);
  if (error) throw error;
  // Tell the buyer their order moved — fire-and-forget.
  supabase.functions.invoke('notify-product-order', { body: { order_id: orderId, status: to } }).catch(() => {});
}
