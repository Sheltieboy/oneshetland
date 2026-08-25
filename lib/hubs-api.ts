/**
 * hubs-api.ts
 * OneShetland Hubs — community organisations with a public page + member area.
 * Phase 1: hubs, membership (member/committee/owner, open/approval join), and
 * notices (public + member-only) shared with the homepage noticeboard.
 */

import { supabase } from './supabase';
import { settleSavedCardPayment, type PaymentStart } from './stripe-sca';

// ── Types ──────────────────────────────────────────────────────────────────────

export type HubType =
  | 'club' | 'sports' | 'youth' | 'hall' | 'charity'
  | 'society' | 'volunteer' | 'arts' | 'community' | 'other';

export type HubRole   = 'member' | 'committee' | 'owner';
export type HubStatus = 'pending' | 'active' | 'rejected' | 'left';
export type JoinMode  = 'open' | 'approval';
export type NoticeVisibility = 'public' | 'members' | 'committee';

export const HUB_TYPE_LABELS: Record<HubType, string> = {
  club:      'Club',
  sports:    'Sports club',
  // "Youth organisation", not "Youth group" — the Hub belongs to the org and is
  // run by its adult leaders. Accounts are 18+, so this must not read as an
  // invitation for under-18s. Kept in step with the web (lib/hubs-data.ts).
  youth:     'Youth organisation',
  hall:      'Hall / committee',
  charity:   'Charity',
  society:   'Society',
  volunteer: 'Volunteer group',
  arts:      'Arts & culture',
  community: 'Community group',
  other:     'Organisation',
};

export const HUB_TYPE_ICONS: Record<HubType, string> = {
  club:      'users',
  sports:    'futbol',
  youth:     'child',
  hall:      'landmark',
  charity:   'hand-holding-heart',
  society:   'book',
  volunteer: 'hands-helping',
  arts:      'palette',
  community: 'people-carry',
  other:     'sitemap',
};

export interface Hub {
  id:            string;
  owner_id:      string;
  name:          string;
  slug:          string | null;
  type:          HubType;
  description:   string | null;
  logo_url:      string | null;
  cover_url:     string | null;
  brand_color:   string | null;
  contact_email: string | null;
  contact_phone: string | null;
  website:       string | null;
  area:          string | null;
  join_mode:     JoinMode;
  is_active:     boolean;
  is_verified:   boolean;
  // Paid membership / Stripe Connect (migration 067)
  stripe_account_id:   string | null;
  payout_enabled:      boolean;
  memberships_enabled: boolean;
  directory_enabled:   boolean;
  is_charity:          boolean;
  charity_number:      string | null;
  created_at:    string;
  // computed
  member_count?: number;
}

export type MembershipPeriod = 'once' | 'month' | 'year';

export interface HubMembershipType {
  id:          string;
  hub_id:      string;
  name:        string;
  description: string | null;
  price_pence: number;          // 0 = free tier
  period:      MembershipPeriod;
  benefits:    string | null;
  is_active:   boolean;
  sort_order:  number;
  created_at:  string;
}

export interface HubMember {
  id:        string;
  hub_id:    string;
  user_id:   string;
  role:      HubRole;
  status:    HubStatus;
  joined_at: string;
  // Paid membership (migration 067)
  membership_type_id?:       string | null;
  member_no?:                string | null;
  paid_until?:               string | null;   // null = free / no expiry
  last_payment_pence?:       number | null;
  stripe_payment_intent_id?: string | null;
  // joined
  profile?:         { full_name: string | null; avatar_url: string | null } | null;
  membership_type?: Pick<HubMembershipType, 'id' | 'name' | 'price_pence' | 'period'> | null;
  hub?:             Pick<Hub, 'id' | 'name' | 'brand_color' | 'logo_url' | 'type'> | null;
}

/** Is a membership currently valid? Free = always (while active); paid = not expired. */
export function isMembershipActive(m: Pick<HubMember, 'status' | 'paid_until'>): boolean {
  if (m.status !== 'active') return false;
  if (!m.paid_until) return true;
  return new Date(m.paid_until).getTime() > Date.now();
}

export interface HubNotice {
  id:               string;
  publisher_hub_id: string | null;
  publisher_business_id: string | null;
  publisher_user_id:     string | null;
  title:            string;
  body:             string | null;
  severity:         'urgent' | 'community' | 'info';
  visibility:       NoticeVisibility;
  image_url:        string | null;
  category:         string | null;
  locality:         string | null;
  is_pinned:        boolean;
  expires_at:       string | null;
  published_at:     string;
  created_at:       string;
  campaign_id?:     string | null;
  // joined: live progress for a campaign-linked notice
  campaign?:        Pick<HubCampaign, 'id' | 'title' | 'raised_pence' | 'goal_pence' | 'donor_count' | 'ends_at' | 'status'> | null;
  // joined when fetched via fetchPublicNotices
  hub?:             { id: string; name: string; logo_url: string | null; slug: string | null } | null;
}

// ── Slug ────────────────────────────────────────────────────────────────────────

export function slugifyHub(name: string): string {
  return name.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ── Hubs CRUD ────────────────────────────────────────────────────────────────────

export async function fetchActiveHubs(type?: HubType): Promise<Hub[]> {
  let q = supabase.from('hubs').select('*')
    .eq('is_active', true)
    .order('is_verified', { ascending: false })
    .order('created_at', { ascending: false });
  if (type) q = q.eq('type', type);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Hub[];
}

export async function fetchHub(id: string): Promise<Hub | null> {
  const { data, error } = await supabase.from('hubs').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data ?? null) as Hub | null;
}

export async function fetchHubBySlug(slug: string): Promise<Hub | null> {
  const { data, error } = await supabase.from('hubs').select('*').eq('slug', slug).maybeSingle();
  if (error) throw error;
  return (data ?? null) as Hub | null;
}

export async function fetchMyHubs(userId: string): Promise<Hub[]> {
  // Hubs I own or help run.
  const { data: mem } = await supabase
    .from('hub_members')
    .select('hub_id')
    .eq('user_id', userId)
    .in('role', ['owner', 'committee'])
    .eq('status', 'active');
  const ids = (mem ?? []).map(m => m.hub_id);
  if (ids.length === 0) return [];
  const { data, error } = await supabase.from('hubs').select('*').in('id', ids);
  if (error) throw error;
  return (data ?? []) as Hub[];
}

export interface HubInput {
  name: string;
  type: HubType;
  description?: string | null;
  logo_url?: string | null;
  cover_url?: string | null;
  brand_color?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  website?: string | null;
  area?: string | null;
  join_mode?: JoinMode;
  directory_enabled?: boolean;
  is_charity?: boolean;
  charity_number?: string | null;
}

export async function createHub(userId: string, input: HubInput): Promise<Hub> {
  const slug = slugifyHub(input.name) || `hub-${Date.now()}`;
  const { data, error } = await supabase
    .from('hubs')
    .insert({ owner_id: userId, slug, join_mode: input.join_mode ?? 'approval', ...input })
    .select('*')
    .single();
  if (error) throw error;
  return data as Hub;
}

export async function updateHub(id: string, patch: Partial<HubInput & { is_active: boolean }>): Promise<void> {
  const { error } = await supabase.from('hubs').update(patch).eq('id', id);
  if (error) throw error;
}

// ── Notifications (slice 5) ───────────────────────────────────────────────────

/** Fire-and-forget push for a hub membership event. */
export function notifyHub(event: 'join_request' | 'membership_paid' | 'approved', hubId: string, userId: string): void {
  supabase.functions.invoke('notify-hub', { body: { event, hub_id: hubId, user_id: userId } }).catch(() => {});
}

// ── Membership ───────────────────────────────────────────────────────────────────

export async function fetchMyMembership(hubId: string, userId: string): Promise<HubMember | null> {
  const { data } = await supabase
    .from('hub_members')
    .select('*')
    .eq('hub_id', hubId)
    .eq('user_id', userId)
    .maybeSingle();
  return (data ?? null) as HubMember | null;
}

/**
 * Join (or re-join) a hub on a FREE basis. Status is decided server-side by the
 * hub's join_mode. Optionally records which (free) membership tier was chosen.
 * Paid tiers go through startHubMembershipPayment instead.
 */
export async function joinHub(hubId: string, userId: string, membershipTypeId?: string | null): Promise<HubMember> {
  const { data, error } = await supabase
    .from('hub_members')
    .upsert(
      { hub_id: hubId, user_id: userId, role: 'member', membership_type_id: membershipTypeId ?? null },
      { onConflict: 'hub_id,user_id' },
    )
    .select('*')
    .single();
  if (error) throw error;
  const member = data as HubMember;
  // Approval-mode hubs: ping admins about the pending request.
  if (member.status === 'pending') notifyHub('join_request', hubId, userId);
  return member;
}

// ── Paid membership (slice 2c) ────────────────────────────────────────────────

/**
 * Flat platform fee per paid membership, for DISPLAY only. The server is the
 * source of truth (admin_config 'fees.hub_membership.flat_pence'); keep this in
 * sync if you change that value.
 */
export const HUB_MEMBERSHIP_FEE_PENCE = 50;

export interface MembershipPaymentStart {
  charged?:          boolean;
  payment_intent_id: string;
  clientSecret?:     string;
}

/** Start payment for a paid membership tier (off-session if useSavedCard). */
export async function startHubMembershipPayment(
  membershipTypeId: string,
  useSavedCard = true,
): Promise<MembershipPaymentStart> {
  const { data, error } = await supabase.functions.invoke('create-hub-membership-intent', {
    body: { membership_type_id: membershipTypeId, use_saved_card: useSavedCard },
  });
  if (error) {
    let msg = error.message;
    try { const body = await (error as any).context?.json(); if (body?.error) msg = body.error; } catch { /* */ }
    throw new Error(msg);
  }

  // A saved-card charge the issuer wants authenticated is PAUSED, not failed.
  // Finish that same PaymentIntent here so every screen sees a settled result
  // and no second intent is created. The PaymentSheet path has no `status`, so
  // it returns straight through unchanged.
  const settled = await settleSavedCardPayment(data as PaymentStart);
  if (settled.outcome === 'cancelled') throw new Error('Payment cancelled — nothing was charged.');
  if (settled.outcome === 'failed') throw new Error(settled.message);
  if (settled.outcome === 'succeeded') return { ...data, charged: true } as MembershipPaymentStart;
  return data as MembershipPaymentStart;
}

/** Activate the membership after the PaymentIntent succeeds. Idempotent. */
export async function confirmHubMembership(
  paymentIntentId: string,
): Promise<{ ok: boolean; member_no: string | null; paid_until: string | null }> {
  const { data, error } = await supabase.functions.invoke('confirm-hub-membership', {
    body: { payment_intent_id: paymentIntentId },
  });
  if (error) {
    let msg = error.message;
    try { const body = await (error as any).context?.json(); if (body?.error) msg = body.error; } catch { /* */ }
    throw new Error(msg);
  }
  return data;
}

export async function leaveHub(hubId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('hub_members')
    .delete()
    .eq('hub_id', hubId)
    .eq('user_id', userId);
  if (error) throw error;
}

/** A user's own hub memberships (for the digital member-card list in My Wallet). */
export async function fetchMyHubMemberships(userId: string): Promise<HubMember[]> {
  const { data, error } = await supabase
    .from('hub_members')
    .select('*, hub:hubs ( id, name, brand_color, logo_url, type ), membership_type:hub_membership_types ( id, name, price_pence, period )')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('joined_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as HubMember[];
}

export async function fetchHubMembers(hubId: string, status?: HubStatus): Promise<HubMember[]> {
  let q = supabase
    .from('hub_members')
    .select('*, profile:profiles ( full_name, avatar_url )')
    .eq('hub_id', hubId)
    .order('joined_at', { ascending: true });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as HubMember[];
}

export async function fetchMemberCount(hubId: string): Promise<number> {
  // Count currently-valid memberships: active, and either free (no expiry) or
  // not yet expired. Lapsed paid memberships are not counted.
  const now = new Date().toISOString();
  const { count } = await supabase
    .from('hub_members')
    .select('id', { count: 'exact', head: true })
    .eq('hub_id', hubId)
    .eq('status', 'active')
    .or(`paid_until.is.null,paid_until.gt.${now}`);
  return count ?? 0;
}

export async function approveMember(memberId: string): Promise<void> {
  const { data, error } = await supabase
    .from('hub_members')
    .update({ status: 'active' })
    .eq('id', memberId)
    .select('hub_id, user_id')
    .single();
  if (error) throw error;
  // Tell the member they're in (notify-hub already supports 'approved').
  if (data) notifyHub('approved', data.hub_id, data.user_id);
}

export async function rejectMember(memberId: string): Promise<void> {
  const { error } = await supabase.from('hub_members').update({ status: 'rejected' }).eq('id', memberId);
  if (error) throw error;
}

export async function setMemberRole(memberId: string, role: HubRole): Promise<void> {
  const { error } = await supabase.from('hub_members').update({ role }).eq('id', memberId);
  if (error) throw error;
}

// ── Notices ──────────────────────────────────────────────────────────────────────

export interface NoticeInput {
  title: string;
  body?: string | null;
  image_url?: string | null;
  category?: string | null;
  visibility?: NoticeVisibility;
  locality?: string | null;
  expires_at?: string | null;
  campaign_id?: string | null;
  event_id?: string | null;
}

/** Post a notice as a hub. */
export async function createHubNotice(hubId: string, input: NoticeInput): Promise<HubNotice> {
  const { data, error } = await supabase
    .from('notices')
    .insert({
      publisher_hub_id: hubId,
      severity: 'community',
      visibility: input.visibility ?? 'public',
      title: input.title,
      body: input.body ?? null,
      image_url: input.image_url ?? null,
      category: input.category ?? null,
      locality: input.locality ?? null,
      expires_at: input.expires_at ?? null,
      campaign_id: input.campaign_id ?? null,
      event_id: input.event_id ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;

  // Let active members know (fire-and-forget).
  supabase.functions
    .invoke('notify-hub-content', { body: { event: 'notice', hub_id: hubId, ref_id: (data as HubNotice).id, title: input.title } })
    .catch(() => {});

  return data as HubNotice;
}

/** Post a notice as a business. */
export async function createBusinessNotice(businessId: string, input: NoticeInput): Promise<HubNotice> {
  const { data, error } = await supabase
    .from('notices')
    .insert({
      publisher_business_id: businessId,
      severity: 'community',
      visibility: 'public',
      title: input.title,
      body: input.body ?? null,
      image_url: input.image_url ?? null,
      category: input.category ?? null,
      locality: input.locality ?? null,
      expires_at: input.expires_at ?? null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as HubNotice;
}

/** Notices for a hub's page. RLS returns public ones to anyone, members-only to members. */
export async function fetchHubNotices(hubId: string, limit = 30): Promise<HubNotice[]> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('notices')
    .select('*, campaign:hub_campaigns ( id, title, raised_pence, goal_pence, donor_count, ends_at, status )')
    .eq('publisher_hub_id', hubId)
    .eq('is_hidden', false)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order('is_pinned', { ascending: false })
    .order('published_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as HubNotice[];
}

export async function deleteNotice(noticeId: string): Promise<void> {
  const { error } = await supabase.from('notices').delete().eq('id', noticeId);
  if (error) throw error;
}

// ── Fundraising (campaigns + donations) ───────────────────────────────────────

export interface HubCampaign {
  id:           string;
  hub_id:       string;
  title:        string;
  story:        string | null;
  goal_pence:   number;
  raised_pence: number;
  donor_count:  number;
  cover_url:    string | null;
  status:       'active' | 'closed';
  ends_at:      string | null;
  created_at:   string;
}

export interface CampaignInput {
  title: string;
  story?: string | null;
  goal_pence: number;
  cover_url?: string | null;
  ends_at?: string | null;
}

export interface GiftAidDeclaration {
  title?: string | null;
  first_name: string;
  last_name: string;
  address: string;
  postcode: string;
}

export interface DonorWallEntry {
  name: string;
  amount_pence: number;
  message: string | null;
  gift_aid: boolean;
  is_anonymous: boolean;
  created_at: string;
}

export interface HubDonation {
  id: string;
  campaign_id: string;
  hub_id: string;
  donor_user_id: string | null;
  amount_pence: number;
  message: string | null;
  is_anonymous: boolean;
  gift_aid: boolean;
  ga_title: string | null;
  ga_first_name: string | null;
  ga_last_name: string | null;
  ga_address: string | null;
  ga_postcode: string | null;
  created_at: string;
}

export async function fetchHubCampaigns(hubId: string, includeClosed = true): Promise<HubCampaign[]> {
  let q = supabase.from('hub_campaigns').select('*').eq('hub_id', hubId)
    .order('status', { ascending: true }).order('created_at', { ascending: false });
  if (!includeClosed) q = q.eq('status', 'active');
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as HubCampaign[];
}

export async function fetchActiveCampaign(hubId: string): Promise<HubCampaign | null> {
  const { data } = await supabase.from('hub_campaigns').select('*')
    .eq('hub_id', hubId).eq('status', 'active')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  return (data ?? null) as HubCampaign | null;
}

export async function fetchCampaign(id: string): Promise<HubCampaign | null> {
  const { data, error } = await supabase.from('hub_campaigns').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data ?? null) as HubCampaign | null;
}

export async function createCampaign(hubId: string, input: CampaignInput): Promise<HubCampaign> {
  const { data, error } = await supabase.from('hub_campaigns')
    .insert({ hub_id: hubId, ...input }).select('*').single();
  if (error) throw error;
  return data as HubCampaign;
}

export async function updateCampaign(id: string, patch: Partial<CampaignInput & { status: 'active' | 'closed' }>): Promise<void> {
  const { error } = await supabase.from('hub_campaigns').update(patch).eq('id', id);
  if (error) throw error;
}

/** Public donor wall (safe fields only). */
export async function fetchCampaignDonors(campaignId: string): Promise<DonorWallEntry[]> {
  const { data, error } = await supabase.rpc('get_campaign_donors', { p_campaign: campaignId });
  if (error) throw error;
  return (data ?? []) as DonorWallEntry[];
}

/** Admin: all donations for a hub (for export + Gift Aid claim file). */
export async function fetchHubDonations(hubId: string, giftAidOnly = false): Promise<HubDonation[]> {
  let q = supabase.from('hub_donations').select('*').eq('hub_id', hubId).order('created_at', { ascending: false });
  if (giftAidOnly) q = q.eq('gift_aid', true);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as HubDonation[];
}

export interface DonationStart { charged?: boolean; payment_intent_id: string; clientSecret?: string; }

/** Start a donation payment (off-session if useSavedCard). */
/**
 * `attemptId` is the reference for ONE deliberate donation — it goes into the
 * Stripe idempotency key, so a retry reaches the same PaymentIntent and a second
 * donation reaches a new one.
 *
 * The donor's anonymity, message and Gift Aid go with the INTENT, not the later
 * confirmation. They used to travel only in the confirm call, so a Stripe
 * webhook that arrived first recorded the donation without them.
 */
/**
 * Can this campaign still take a donation? Mirrors the server rule in
 * campaign_donation_eligibility — active, and not past its end date. The
 * backend is authoritative; this only decides whether to offer the button, so
 * a finished campaign stops inviting money it will then refuse.
 */
export function campaignAcceptsDonations(
  c: { status?: string | null; ends_at?: string | null } | null | undefined,
): boolean {
  if (!c || c.status !== 'active') return false;
  return !c.ends_at || new Date(c.ends_at).getTime() > Date.now();
}

export async function startHubDonation(
  campaignId: string,
  amountPence: number,
  attemptId: string,
  opts: { useSavedCard?: boolean; coverFees?: boolean; message?: string; anonymous?: boolean; giftAid?: GiftAidDeclaration | null } = {},
): Promise<DonationStart> {
  const { data, error } = await supabase.functions.invoke('create-hub-donation-intent', {
    body: {
      campaign_id: campaignId, amount_pence: amountPence,
      client_request_id: attemptId,
      use_saved_card: opts.useSavedCard ?? true, cover_fees: opts.coverFees ?? false,
      message: opts.message ?? null, anonymous: opts.anonymous ?? false,
      gift_aid: opts.giftAid ?? null,
    },
  });
  if (error) {
    let msg = error.message;
    try { const b = await (error as any).context?.json(); if (b?.error) msg = b.error; } catch { /* */ }
    throw new Error(msg);
  }

  // A saved-card charge the issuer wants authenticated is PAUSED, not failed.
  // Finish that same PaymentIntent here so every screen sees a settled result
  // and no second intent is ever created. The PaymentSheet path is untouched:
  // it has no `status`, so this returns straight through.
  const settled = await settleSavedCardPayment(data as PaymentStart);
  if (settled.outcome === 'cancelled') throw new Error('Payment cancelled — nothing was charged.');
  if (settled.outcome === 'failed') throw new Error(settled.message);
  if (settled.outcome === 'succeeded') return { ...data, charged: true } as DonationStart;
  return data as DonationStart;
}

/** Confirm a donation after payment — records it + the Gift Aid declaration. */
/**
 * The fast answer for a donor watching the screen. It no longer carries their
 * choices — the server already holds them against the attempt, which is what
 * lets the webhook fulfil correctly without this call happening at all.
 */
export async function confirmHubDonation(paymentIntentId: string): Promise<{ ok: boolean; already?: boolean }> {
  const { data, error } = await supabase.functions.invoke('confirm-hub-donation', {
    body: { payment_intent_id: paymentIntentId },
  });
  if (error) {
    let msg = error.message;
    try { const b = await (error as any).context?.json(); if (b?.error) msg = b.error; } catch { /* */ }
    throw new Error(msg);
  }
  return data;
}

// ── Member comms (slice 7) ────────────────────────────────────────────────────

/** Message all active members of a hub (admin only). */
export async function broadcastToHub(
  hubId: string,
  input: { title: string; message: string; channel: 'push' | 'email' | 'both' },
): Promise<{ ok: boolean; push: number; email: number; members: number }> {
  const { data, error } = await supabase.functions.invoke('hub-broadcast', {
    body: { hub_id: hubId, title: input.title, message: input.message, channel: input.channel },
  });
  if (error) {
    let msg = error.message;
    try { const body = await (error as any).context?.json(); if (body?.error) msg = body.error; } catch { /* */ }
    throw new Error(msg);
  }
  return data;
}

// ── Member directory (slice 6) ────────────────────────────────────────────────

export interface HubDirectoryEntry {
  user_id: string;
  name:    string;
  role:    HubRole;
  tier:    string;
}

/** Privacy-safe member directory (names + role + tier only; members-only). */
export async function fetchHubDirectory(hubId: string): Promise<HubDirectoryEntry[]> {
  const { data, error } = await supabase.rpc('get_hub_directory', { p_hub: hubId });
  if (error) throw error;
  return (data ?? []) as HubDirectoryEntry[];
}

// ── Documents (slice 6) ───────────────────────────────────────────────────────

export interface HubDocument {
  id:         string;
  hub_id:     string;
  title:      string;
  url:        string;
  visibility: NoticeVisibility;
  created_at: string;
}

export async function fetchHubDocuments(hubId: string): Promise<HubDocument[]> {
  const { data, error } = await supabase
    .from('hub_documents')
    .select('*')
    .eq('hub_id', hubId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as HubDocument[];
}

export async function createHubDocument(
  hubId: string,
  input: { title: string; url: string; visibility?: NoticeVisibility },
): Promise<HubDocument> {
  const { data, error } = await supabase
    .from('hub_documents')
    .insert({ hub_id: hubId, title: input.title, url: input.url, visibility: input.visibility ?? 'members' })
    .select('*')
    .single();
  if (error) throw error;
  return data as HubDocument;
}

export async function deleteHubDocument(id: string): Promise<void> {
  const { error } = await supabase.from('hub_documents').delete().eq('id', id);
  if (error) throw error;
}

// ── Membership types / tiers (migration 067) ──────────────────────────────────

export interface MembershipTypeInput {
  name: string;
  description?: string | null;
  price_pence?: number;
  period?: MembershipPeriod;
  benefits?: string | null;
  sort_order?: number;
}

/** Active membership types for a hub, cheapest first. Public read. */
export async function fetchHubMembershipTypes(hubId: string, includeInactive = false): Promise<HubMembershipType[]> {
  let q = supabase
    .from('hub_membership_types')
    .select('*')
    .eq('hub_id', hubId)
    .order('sort_order', { ascending: true })
    .order('price_pence', { ascending: true });
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as HubMembershipType[];
}

export async function createMembershipType(hubId: string, input: MembershipTypeInput): Promise<HubMembershipType> {
  const { data, error } = await supabase
    .from('hub_membership_types')
    .insert({ hub_id: hubId, ...input })
    .select('*')
    .single();
  if (error) throw error;
  return data as HubMembershipType;
}

export async function updateMembershipType(id: string, patch: Partial<MembershipTypeInput & { is_active: boolean }>): Promise<void> {
  const { error } = await supabase.from('hub_membership_types').update(patch).eq('id', id);
  if (error) throw error;
}

export async function deleteMembershipType(id: string): Promise<void> {
  // Soft-delete so existing members keep their type reference.
  const { error } = await supabase.from('hub_membership_types').update({ is_active: false }).eq('id', id);
  if (error) throw error;
}

/**
 * Start (or resume) the hub's Stripe Connect onboarding. Returns a URL the
 * owner opens in a browser; payout_enabled flips via the webhook once done.
 */
export async function createHubOnboardingLink(hubId: string): Promise<{ url: string }> {
  const { data, error } = await supabase.functions.invoke('hub-onboard', { body: { hub_id: hubId } });
  if (error) {
    let msg = error.message;
    try { const body = await (error as any).context?.json(); if (body?.error) msg = body.error; } catch { /* */ }
    throw new Error(msg);
  }
  return data as { url: string };
}

/** Period → human label, e.g. "£20 / year". */
export function formatMembershipPrice(pricePence: number, period: MembershipPeriod): string {
  if (pricePence === 0) return 'Free';
  const price = `£${(pricePence / 100).toFixed(2).replace(/\.00$/, '')}`;
  switch (period) {
    case 'once':  return `${price} one-off`;
    case 'month': return `${price} / month`;
    case 'year':  return `${price} / year`;
  }
}

export async function fetchPublicNotices(limit = 10): Promise<HubNotice[]> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('notices')
    .select('*, hub:hubs(id,name,logo_url,slug)')
    .eq('visibility', 'public')
    .eq('is_hidden', false)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order('published_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as HubNotice[];
}
