/**
 * local-business-detail.tsx
 * Customer-facing business profile: info, follow, loyalty card, active offers.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { track } from '@/lib/analytics';
import { formatDay, hoursExpired } from '@/lib/opening-hours';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import {
  fetchBusiness, fetchLoyaltyProgram, fetchMyLoyaltyCard,
  fetchBusinessOffers, isFollowing, followBusiness, unfollowBusiness,
  redeemReward, redeemOffer, fetchMyRedeemedOfferIds,
  CATEGORY_LABELS, CATEGORY_ICONS,
  formatOfferDiscount, daysRemaining, ladderState,
  type LocalBusiness, type LoyaltyProgram, type LoyaltyCard, type LocalOffer,
} from '@/lib/local-api';
import { fetchPublishedEvents, formatShortDate, formatTime, type OsEvent } from '@/lib/events-api';
import {
  isBookableLive, fetchBusinessUnitItems, fetchBusinessServices,
  formatPence, formatDuration,
  type BookUnitItem, type BookService,
} from '@/lib/book-api';
import { supabase } from '@/lib/supabase';
import { fetchShopProducts, type Product as ShopProduct } from '@/lib/products-api';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useGoToSignIn } from '@/hooks/useGoToSignIn';
import { addRecentlyViewed, businessResult } from '@/lib/search';
import { BusinessLocationMap } from '@/components/BusinessLocationMap';
import { useAlert } from '@/components/BrandedAlert';
import { tierUnlocks, TIER_FEATURES, TIER_LABEL, type ListingFeature } from '@/lib/listing-tiers';

const S = SECTIONS.local;

// Generic banner colour per business category — used when a business hasn't
// uploaded their own cover photo, so even a free listing looks intentional.
const CATEGORY_BANNER: Record<string, string> = {
  food_drink:    '#C2410C', // warm terracotta
  retail:        '#7C3AED', // violet
  services:      '#0E7490', // teal
  tourism:       '#15803D', // green
  accommodation: '#4338CA', // indigo
  other:         '#475569', // slate
};

/**
 * Turn a logo's dominant colour into a page accent that's always legible with
 * white text — light/pale colours get darkened toward their hue so buttons and
 * chips stay readable. Returns null for invalid input (caller falls back).
 */
function readableAccent(hex?: string | null): string | null {
  if (!hex || !/^#?[0-9a-fA-F]{6}/.test(hex)) return null;
  const m = hex.replace('#', '').slice(0, 6);
  let r = parseInt(m.slice(0, 2), 16);
  let g = parseInt(m.slice(2, 4), 16);
  let b = parseInt(m.slice(4, 6), 16);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum > 0.6) {
    const f = 0.6 / lum; // scale toward black until white text is readable
    r = Math.round(r * f); g = Math.round(g * f); b = Math.round(b * f);
  }
  const h = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export default function BusinessDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { profile } = useAuth();
  const { isTablet } = useAppLayout();
  const { alert } = useAlert();
  const goToSignIn = useGoToSignIn();

  const [business, setBusiness] = useState<LocalBusiness | null>(null);
  const [program,  setProgram]  = useState<LoyaltyProgram | null>(null);
  const [card,     setCard]     = useState<LoyaltyCard | null>(null);
  const [offers,   setOffers]   = useState<LocalOffer[]>([]);
  const [redeemedIds, setRedeemedIds] = useState<Set<string>>(new Set());
  const [following, setFollowing] = useState(false);
  const [loading,  setLoading]  = useState(true);
  const [busy,     setBusy]     = useState(false);
  // Open shifts posted as this business — surfaced as a section on the profile.
  const [openShifts, setOpenShifts] = useState<Array<{
    id: string;
    title: string;
    category: string | null;
    urgency: string | null;
    pay_type: string | null;
    pay_amount: number | null;
    start_at: string | null;
  }>>([]);
  const [unitItems, setUnitItems]   = useState<BookUnitItem[]>([]);
  const [services, setServices]     = useState<BookService[]>([]);
  const [upcomingEvents, setUpcomingEvents] = useState<OsEvent[]>([]);
  const [shopProducts, setShopProducts] = useState<ShopProduct[]>([]);


  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [b, p, o, s, units, svcs, evs] = await Promise.all([
        fetchBusiness(id),
        fetchLoyaltyProgram(id),
        fetchBusinessOffers(id),
        // Open shifts posted as this business
        supabase
          .from('shifts')
          .select('id, title, category, urgency, pay_type, pay_amount, start_at')
          .eq('posted_as_business_id', id)
          .eq('status', 'open')
          .order('start_at', { ascending: true, nullsFirst: false })
          .limit(5)
          .then(({ data }) => data ?? [], () => [] as any[]),
        fetchBusinessUnitItems(id, false).catch(() => [] as BookUnitItem[]),
        fetchBusinessServices(id, false).catch(() => [] as BookService[]),
        fetchPublishedEvents({ businessId: id, limit: 5 }).catch(() => [] as OsEvent[]),
      ]);
      // Shop products load separately (non-blocking, fails soft).
      fetchShopProducts(id).then(setShopProducts).catch(() => {});
      setBusiness(b);
      if (b) addRecentlyViewed(businessResult(b));
      setProgram(p);
      setOffers(o);
      setOpenShifts(s as any[]);
      setUnitItems(units);
      setServices(svcs);
      setUpcomingEvents(evs);

      if (profile) {
        const [c, isF, ids] = await Promise.all([
          fetchMyLoyaltyCard(profile.id, id),
          isFollowing(profile.id, id),
          fetchMyRedeemedOfferIds(profile.id),
        ]);
        setCard(c);
        setFollowing(isF);
        setRedeemedIds(new Set(ids));
      }
    } finally {
      setLoading(false);
    }
  }, [id, profile?.id]);

  useEffect(() => { load(); }, [load]);

  // Analytics: business profile view (powers the seller dashboard's view count).
  useEffect(() => {
    if (business?.id) track('content_viewed', { objectType: 'business', objectId: business.id, businessId: business.id });
  }, [business?.id]);

  const handleFollowToggle = async () => {
    if (!profile || !business) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (following) {
      await unfollowBusiness(profile.id, business.id);
      setFollowing(false);
    } else {
      await followBusiness(profile.id, business.id);
      setFollowing(true);
    }
  };

  // Redemption now goes through the staff-verified backbone: the customer opens
  // a "show at till" screen (code + QR), staff confirm, and only then does it
  // count. No balance changes here.
  const handleRedeemReward = () => {
    if (!card) return;
    router.push({ pathname: '/local-redeem', params: { kind: 'reward', ref_id: card.id } });
  };

  const handleRedeemOffer = (offer: LocalOffer) => {
    if (!profile) { goToSignIn(`/local-business-detail?id=${id}`); return; }
    router.push({ pathname: '/local-redeem', params: { kind: 'offer', ref_id: offer.id } });
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      </SafeAreaView>
    );
  }

  if (!business) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}>
          <Text style={styles.errorText}>Business not found.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const isOwner = profile?.id === business.owner_id;
  // Page accent: derived from the logo colour (contrast-safe), else the
  // Marketplace violet. Used for chips, badges, buttons and icons below.
  const accent = readableAccent(business.brand_color) ?? S.color;

  // Tier gating — a richer listing for higher subscription tiers. Governs
  // DISPLAY only (no selling here — App Store compliance).
  const tier = business.subscription_tier;
  const shows = (f: ListingFeature) => tierUnlocks(tier, f);
  const showCover = shows('coverPhoto');

  // Owner-only upgrade hint: shown to the business owner viewing their own
  // listing when a higher tier would surface content they can add. No price,
  // no buy button — points at the web dashboard (in-app selling is disallowed).
  const upgradeHint: { feature: string; tier: string } | null = (() => {
    if (!isOwner) return null;
    const candidates: { feature: ListingFeature; label: string }[] = [
      { feature: 'gallery',       label: 'a photo gallery' },
      { feature: 'description',   label: 'an "about" description' },
      { feature: 'coverPhoto',    label: 'a cover photo' },
      { feature: 'offers',        label: 'offers on your listing' },
    ];
    const locked = candidates.find(c => !shows(c.feature));
    if (!locked) return null;
    return { feature: locked.label, tier: TIER_LABEL[TIER_FEATURES[locked.feature]] };
  })();
  const stamps  = card?.stamps_collected ?? 0;
  const ladder  = ladderState(program, stamps, card?.tiers_redeemed_upto ?? 0);
  const needed  = ladder ? ladder.top : (program?.stamps_required ?? 10);
  const progress = Math.min(1, stamps / needed);
  const rewardReady = program?.type === 'stamps' && (ladder ? !!ladder.ready : stamps >= needed);

  // ── Hero (always full-bleed) ───────────────────────────────────────────────
  const heroSection = (
    <View style={[styles.hero, { borderBottomColor: accent }]}>
          {/* Banner — own cover photo, else logo-tinted, else category-themed */}
          <View style={[styles.banner, { backgroundColor: business.brand_color || CATEGORY_BANNER[business.category] || CATEGORY_BANNER.other }]}>
            {showCover && business.cover_url ? (
              <Image source={{ uri: business.cover_url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
            ) : (
              <FontAwesome5
                name={CATEGORY_ICONS[business.category] as any}
                size={130}
                color="rgba(255,255,255,0.14)"
                solid
                style={styles.bannerWatermark}
              />
            )}
            <View style={styles.bannerScrim} />

            <TouchableOpacity
              style={styles.backBtnOverlay}
              onPress={() => {
                if (router.canGoBack()) router.back();
                else router.replace('/(tabs)/local');
              }}
              hitSlop={12}
            >
              <FontAwesome5 name="chevron-left" size={13} color="#fff" />
              <Text style={styles.backTextOverlay}>Back</Text>
            </TouchableOpacity>
          </View>

          {/* Identity — logo overlaps the banner, name + category + follow */}
          <View style={styles.heroBody}>
            <View style={styles.heroTop}>
              {business.logo_url ? (
                <Image source={{ uri: business.logo_url }} style={styles.heroLogo} resizeMode="contain" />
              ) : (
                <View style={[styles.heroLogo, styles.heroLogoFallback, { backgroundColor: CATEGORY_BANNER[business.category] ?? CATEGORY_BANNER.other }]}>
                  <FontAwesome5 name={CATEGORY_ICONS[business.category] as any} size={30} color="#fff" solid />
                </View>
              )}

              {!isOwner && profile && (
                <TouchableOpacity
                  style={[styles.followBtn, { backgroundColor: accent }, following && { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: accent }]}
                  onPress={handleFollowToggle}
                  activeOpacity={0.85}
                >
                  <FontAwesome5 name={following ? 'check' : 'plus'} size={11} color={following ? accent : '#fff'} />
                  <Text style={[styles.followBtnText, { color: following ? accent : '#fff' }]}>
                    {following ? 'Following' : 'Follow'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.heroNameRow}>
              <Text style={styles.heroName} numberOfLines={2}>{business.name}</Text>
              {business.is_verified && (
                <FontAwesome5 name="check-circle" size={16} color={accent} solid />
              )}
            </View>

            <View style={[styles.heroCategoryChip, { backgroundColor: accent + '14' }]}>
              <FontAwesome5 name={CATEGORY_ICONS[business.category] as any} size={10} color={accent} solid />
              <Text style={[styles.heroCategoryChipText, { color: accent }]}>{CATEGORY_LABELS[business.category]}</Text>
            </View>
          </View>
        </View>
  );

  // ── Book now (OneShetland Book) ────────────────────────────────────────────
  const bookCtaSection = shows('bookable') && isBookableLive(business) ? (
          <View style={styles.section}>
            <TouchableOpacity
              style={styles.bookCtaBtn}
              onPress={() => router.push({ pathname: '/local-book-business', params: { businessId: business.id } })}
              activeOpacity={0.85}
            >
              <View style={styles.bookCtaIcon}>
                <FontAwesome5 name="calendar-check" size={14} color="#fff" solid />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.bookCtaTitle}>Book now</Text>
                <Text style={styles.bookCtaSub}>See live availability and reserve in seconds</Text>
              </View>
              <FontAwesome5 name="chevron-right" size={12} color="#fff" />
            </TouchableOpacity>
          </View>
  ) : null;

  // ── Tickets & passes (non-time-based unit items) ───────────────────────────
  const ticketsSection = shows('passesOnListing') && unitItems.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Tickets &amp; passes</Text>
            <View style={{ gap: 10 }}>
              {unitItems.map(it => {
                const soldOut = it.stock !== null && it.stock <= 0;
                return (
                  <View key={it.id} style={styles.unitCard}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.unitName}>{it.name}</Text>
                      {it.description ? (
                        <Text style={styles.unitDesc} numberOfLines={2}>{it.description}</Text>
                      ) : null}
                      <View style={styles.unitMetaRow}>
                        <Text style={[styles.unitPrice, { color: accent }]}>{formatPence(it.price_pence)}</Text>
                        {it.uses_per_purchase > 1 && (
                          <Text style={styles.unitMetaText}>· {it.uses_per_purchase} uses</Text>
                        )}
                        {it.valid_days !== null && (
                          <Text style={styles.unitMetaText}>· {it.valid_days}d valid</Text>
                        )}
                        {it.stock !== null && it.stock <= 10 && it.stock > 0 && (
                          <Text style={[styles.unitMetaText, { color: colors.error }]}>· {it.stock} left</Text>
                        )}
                      </View>
                    </View>
                    <View style={styles.unitBtnCol}>
                      <TouchableOpacity
                        style={[
                          styles.unitBuyBtn,
                          { backgroundColor: soldOut ? colors.border : accent },
                        ]}
                        onPress={() => router.push({ pathname: '/local-buy-unit', params: { itemId: it.id } })}
                        disabled={soldOut}
                        activeOpacity={0.85}
                      >
                        <Text style={[styles.unitBuyText, soldOut && { color: colors.textMuted }]}>
                          {soldOut ? 'Sold out' : 'Buy'}
                        </Text>
                      </TouchableOpacity>
                      {!soldOut && (
                        <TouchableOpacity
                          style={[styles.unitGiftBtn, { borderColor: accent }]}
                          onPress={() => router.push({ pathname: '/local-gift', params: { kind: 'unit', itemId: it.id } })}
                          activeOpacity={0.85}
                        >
                          <FontAwesome5 name="gift" size={10} color={accent} solid />
                          <Text style={[styles.unitGiftText, { color: accent }]}>Gift</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
  ) : null;

  // ── Description ────────────────────────────────────────────────────────────
  const descriptionSection = shows('description') && business.description ? (
          <View style={styles.section}>
            <Text style={styles.descText}>{business.description}</Text>
          </View>
  ) : null;

  // ── Loyalty card ───────────────────────────────────────────────────────────
  const loyaltySection = shows('loyalty') && program ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Loyalty</Text>
            <View style={styles.loyaltyCard}>
              {program.type === 'stamps' ? (
                <>
                  <Text style={styles.loyaltyReward}>{ladder ? 'Rewards ladder' : (program.stamp_reward ?? 'Loyalty reward')}</Text>
                  <Text style={styles.loyaltyCount}>
                    <Text style={[styles.loyaltyCountNum, { color: accent }]}>{stamps}</Text>
                    <Text style={styles.loyaltyCountRest}> / {needed} stamps</Text>
                  </Text>
                  <View style={styles.stampGrid}>
                    {Array.from({ length: needed }).map((_, i) => {
                      const filled = i < stamps;
                      return (
                        <View
                          key={i}
                          style={[styles.stamp, filled ? { backgroundColor: accent, borderColor: accent } : { borderColor: colors.border }]}
                        >
                          {filled && <FontAwesome5 name="check" size={10} color="#fff" />}
                        </View>
                      );
                    })}
                  </View>

                  {/* Ladder rungs — claimed / ready / still to reach */}
                  {ladder && (
                    <View style={styles.ladderList}>
                      {ladder.tiers.map((t) => {
                        const claimed = (card?.tiers_redeemed_upto ?? 0) >= t.stamps;
                        const isReady = ladder.ready?.stamps === t.stamps;
                        const toGo = t.stamps - stamps;
                        return (
                          <View key={t.stamps} style={styles.ladderRow}>
                            <View style={[styles.ladderDot, { backgroundColor: claimed || isReady ? accent : accent + '22' }]}>
                              <FontAwesome5 name={claimed ? 'check' : 'star'} size={9} color={claimed || isReady ? '#fff' : accent} solid />
                            </View>
                            <Text style={[styles.ladderReward, claimed && { textDecorationLine: 'line-through', color: colors.textLight }]} numberOfLines={1}>
                              {t.reward}
                            </Text>
                            <Text style={[styles.ladderStatus, { color: isReady ? accent : colors.textLight }]}>
                              {claimed ? 'Claimed' : isReady ? 'Ready' : `${t.stamps} stamps${toGo > 0 ? ` · ${toGo} to go` : ''}`}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                  )}

                  {!rewardReady && needed - stamps > 0 && needed - stamps <= 2 && (
                    <View style={[styles.nudge, { backgroundColor: accent + '14' }]}>
                      <Text style={[styles.nudgeText, { color: accent }]}>
                        ✨ Just {needed - stamps} more {needed - stamps === 1 ? 'stamp' : 'stamps'}{(ladder?.next?.reward ?? program.stamp_reward) ? ` for ${ladder?.next?.reward ?? program.stamp_reward}` : ' to your reward'}!
                      </Text>
                    </View>
                  )}
                  {rewardReady && (
                    <TouchableOpacity
                      style={[styles.redeemBtn, { backgroundColor: accent }, busy && { opacity: 0.7 }]}
                      onPress={handleRedeemReward}
                      disabled={busy}
                      activeOpacity={0.85}
                    >
                      <FontAwesome5 name="gift" size={13} color="#fff" solid />
                      <Text style={styles.redeemBtnText}>Redeem {ladder?.ready ? ladder.ready.reward : 'reward'}</Text>
                    </TouchableOpacity>
                  )}
                </>
              ) : (
                <>
                  <Text style={styles.loyaltyReward}>
                    Earn {program.points_per_pound} points per £1 · {program.points_for_pound} points = £1 off
                  </Text>
                  <Text style={styles.loyaltyCount}>
                    <Text style={[styles.loyaltyCountNum, { color: accent }]}>{card?.points_balance ?? 0}</Text>
                    <Text style={styles.loyaltyCountRest}> points</Text>
                  </Text>
                  {(() => {
                    const per = program.points_for_pound ?? 100;
                    const bal = card?.points_balance ?? 0;
                    if (bal <= 0 || bal >= per) return null;
                    return (
                      <View style={[styles.nudge, { backgroundColor: accent + '14' }]}>
                        <Text style={[styles.nudgeText, { color: accent }]}>
                          ✨ Just {per - bal} more {per - bal === 1 ? 'point' : 'points'} for £1 off
                        </Text>
                      </View>
                    );
                  })()}
                  {(() => {
                    const per = program.points_for_pound ?? 100;
                    const spend = Math.floor((card?.points_balance ?? 0) / per) * per;
                    if (!card || spend < per) return null;
                    return (
                      <TouchableOpacity
                        style={[styles.redeemBtn, { backgroundColor: accent }]}
                        onPress={() => router.push({ pathname: '/local-redeem', params: { kind: 'points', ref_id: card.id, amount: String(spend) } })}
                      >
                        <FontAwesome5 name="tag" size={11} color="#fff" solid />
                        <Text style={styles.redeemBtnText}>Redeem £{(spend / per).toFixed(spend % per === 0 ? 0 : 2)} off</Text>
                      </TouchableOpacity>
                    );
                  })()}
                </>
              )}
              <TouchableOpacity
                style={styles.collectBtn}
                onPress={() => { if (!profile) { goToSignIn(`/local-business-detail?id=${id}`); return; } router.push('/local-stamp-scanner'); }}
                activeOpacity={0.8}
              >
                <FontAwesome5 name="qrcode" size={11} color={accent} />
                <Text style={[styles.collectBtnText, { color: accent }]}>Collect a stamp</Text>
              </TouchableOpacity>
            </View>
          </View>
  ) : null;

  // ── Offers ─────────────────────────────────────────────────────────────────
  const offersSection = shows('offers') && offers.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Current offers</Text>
            <View style={{ gap: 8 }}>
              {offers.map(o => {
                const claimed = redeemedIds.has(o.id);
                return (
                  <View key={o.id} style={styles.offerRow}>
                    <View style={[styles.offerBadge, { backgroundColor: accent }]}>
                      <Text style={styles.offerBadgeText}>{formatOfferDiscount(o)}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.offerTitle}>{o.title}</Text>
                      {o.description && (
                        <Text style={styles.offerDesc} numberOfLines={2}>{o.description}</Text>
                      )}
                      <Text style={styles.offerExpiry}>
                        Ends in {daysRemaining(o.valid_until)} day{daysRemaining(o.valid_until) !== 1 ? 's' : ''}
                      </Text>
                    </View>
                    {!isOwner && (
                      claimed ? (
                        <View style={styles.offerClaimed}>
                          <FontAwesome5 name="check" size={10} color={colors.success} />
                          <Text style={styles.offerClaimedText}>Claimed</Text>
                        </View>
                      ) : (
                        <TouchableOpacity
                          style={[styles.offerClaimBtn, { backgroundColor: accent }]}
                          onPress={() => handleRedeemOffer(o)}
                          disabled={busy}
                        >
                          <Text style={styles.offerClaimBtnText}>Claim</Text>
                        </TouchableOpacity>
                      )
                    )}
                  </View>
                );
              })}
            </View>
          </View>
  ) : null;

  // ── Open shifts posted by this business ────────────────────────────────────
  const hiringSection = shows('hiring') && openShifts.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Hiring now</Text>
            <View style={{ gap: 8 }}>
              {openShifts.map(s => {
                const payLabel = s.pay_type === 'volunteer'
                  ? 'Voluntary'
                  : s.pay_type === 'fixed' && s.pay_amount
                    ? `£${s.pay_amount.toFixed(2)} total`
                    : s.pay_type === 'hourly' && s.pay_amount
                      ? `£${s.pay_amount.toFixed(2)}/hr`
                      : s.pay_type === 'negotiable' ? 'Pay negotiable'
                      : s.pay_type === 'discuss'   ? 'Pay to discuss'
                      : null;

                const urgencyColor = s.urgency === 'asap'      ? '#DC2626'
                                   : s.urgency === 'today'     ? colors.shifts
                                   : s.urgency === 'this_week' ? '#10B981'
                                                                : colors.textMuted;
                const urgencyLabel = s.urgency === 'asap'      ? 'ASAP'
                                   : s.urgency === 'today'     ? 'Today'
                                   : s.urgency === 'this_week' ? 'This week'
                                   : s.urgency === 'planned'   ? 'Planned'
                                                                : null;

                return (
                  <TouchableOpacity
                    key={s.id}
                    style={styles.shiftRow}
                    onPress={() => router.push({ pathname: '/shift-detail', params: { id: s.id } })}
                    activeOpacity={0.85}
                  >
                    <View style={[styles.shiftIcon, { backgroundColor: colors.shifts + '20' }]}>
                      <FontAwesome5 name="briefcase" size={13} color={colors.shifts} solid />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.shiftTitle} numberOfLines={1}>{s.title}</Text>
                      <View style={styles.shiftMetaRow}>
                        {urgencyLabel && (
                          <View style={[styles.urgencyPill, { backgroundColor: urgencyColor + '20' }]}>
                            <Text style={[styles.urgencyPillText, { color: urgencyColor }]}>{urgencyLabel}</Text>
                          </View>
                        )}
                        {payLabel && <Text style={styles.shiftMetaText}>{payLabel}</Text>}
                      </View>
                    </View>
                    <FontAwesome5 name="chevron-right" size={11} color={colors.textLight} />
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
  ) : null;

  // ── Upcoming events (when events add-on enabled) ───────────────────────────
  const eventsSection = shows('events') && upcomingEvents.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Upcoming events</Text>
            <View style={{ gap: 8 }}>
              {upcomingEvents.map(ev => (
                <TouchableOpacity
                  key={ev.id}
                  style={styles.eventRow}
                  onPress={() => router.push({ pathname: '/events/[id]', params: { id: ev.id } })}
                  activeOpacity={0.85}
                >
                  <View style={[styles.eventDatePill, { backgroundColor: SECTIONS.events.color }]}>
                    <Text style={styles.eventDateDay}>{new Date(ev.starts_at).getDate()}</Text>
                    <Text style={styles.eventDateMonth}>
                      {new Date(ev.starts_at).toLocaleString('en-GB', { month: 'short' }).toUpperCase()}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.eventTitle} numberOfLines={1}>{ev.title}</Text>
                    <Text style={styles.eventMeta}>{formatShortDate(ev.starts_at)} · {formatTime(ev.starts_at)}</Text>
                  </View>
                  {ev.has_tickets ? (
                    <TouchableOpacity
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 4,
                               backgroundColor: SECTIONS.events.color, borderRadius: 999,
                               paddingHorizontal: 10, paddingVertical: 5 }}
                      onPress={e => { e.stopPropagation?.(); router.push({ pathname: '/event-ticket-checkout', params: { id: ev.id } }); }}
                      hitSlop={8}
                    >
                      <FontAwesome5 name="ticket-alt" size={9} color="#fff" solid />
                      <Text style={{ fontSize: 11, fontWeight: '800', color: '#fff' }}>Tickets</Text>
                    </TouchableOpacity>
                  ) : (
                    <FontAwesome5 name="chevron-right" size={11} color={colors.textLight} />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </View>
  ) : null;

  // ── Services catalogue (when Services add-on enabled) ──────────────────────
  const servicesSection = shows('services') && services.length > 0 ? (() => {
          const bookable = isBookableLive(business);
          return (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Services</Text>
              <View style={{ gap: 8 }}>
                {services.map(svc => {
                  const priceLabel = svc.price_pence > 0 ? formatPence(svc.price_pence) : 'On request';
                  const Row: any = bookable ? TouchableOpacity : View;
                  return (
                    <Row
                      key={svc.id}
                      style={styles.serviceRow}
                      {...(bookable
                        ? {
                            activeOpacity: 0.85,
                            onPress: () => router.push({
                              pathname: '/local-book-business',
                              params: { businessId: business.id, serviceId: svc.id },
                            }),
                          }
                        : {})}
                    >
                      <View style={[styles.serviceIcon, { backgroundColor: accent + '14' }]}>
                        <FontAwesome5 name="tools" size={13} color={accent} solid />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.serviceName}>{svc.name}</Text>
                        {svc.description ? (
                          <Text style={styles.serviceDesc} numberOfLines={2}>{svc.description}</Text>
                        ) : null}
                        <Text style={styles.serviceMeta}>
                          {formatDuration(svc.duration_minutes)}  ·  {priceLabel}
                        </Text>
                      </View>
                      {bookable ? (
                        <View style={[styles.serviceBookBtn, { backgroundColor: accent }]}>
                          <Text style={styles.serviceBookBtnText}>Book</Text>
                        </View>
                      ) : (
                        <Text style={[styles.servicePrice, { color: accent }]}>{priceLabel}</Text>
                      )}
                    </Row>
                  );
                })}
              </View>
            </View>
          );
        })() : null;

  // ── Shop — real products for sale (Shop Shetland) ──────────────────────────
  const shopSection = shopProducts.length > 0 ? (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Shop</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm }}>
        {shopProducts.map((p) => (
          <TouchableOpacity
            key={p.id}
            style={{ width: '47%', backgroundColor: colors.cardBackground, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' }}
            activeOpacity={0.85}
            onPress={() => router.push({ pathname: '/product-detail', params: { id: p.id } } as never)}
          >
            {p.photos[0] ? (
              <Image source={{ uri: p.photos[0] }} style={{ width: '100%', aspectRatio: 1 }} />
            ) : (
              <View style={{ width: '100%', aspectRatio: 1, backgroundColor: accent + '14', alignItems: 'center', justifyContent: 'center' }}>
                <FontAwesome5 name="shopping-bag" size={22} color={accent} />
              </View>
            )}
            <View style={{ padding: spacing.sm }}>
              <Text numberOfLines={1} style={{ fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary }}>{p.title}</Text>
              <Text style={{ fontSize: fontSize.sm, fontWeight: '800', color: accent }}>{formatPence(p.price_pence)}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  ) : null;

  // ── Info ───────────────────────────────────────────────────────────────────
  // ── Opening hours (rendered inside the Info section) ─────────────────────────
  const openingHoursSection = (() => {
    const oh = business.opening_hours;
    if (!oh) return null;
    const days: { key: keyof typeof oh; label: string }[] = [
      { key: 'mon', label: 'Mon' }, { key: 'tue', label: 'Tue' }, { key: 'wed', label: 'Wed' },
      { key: 'thu', label: 'Thu' }, { key: 'fri', label: 'Fri' }, { key: 'sat', label: 'Sat' },
      { key: 'sun', label: 'Sun' },
    ];
    if (days.every(d => !oh[d.key])) return null;
    const todayIdx = (new Date().getDay() + 6) % 7; // Mon=0 … Sun=6
    return (
      <View style={styles.hoursCard}>
        <Text style={styles.hoursHeading}>Opening hours</Text>
        {/* Seasonal hours we know have run out. Shown rather than hidden —
            they're still the best guide anyone has to what this place does —
            but never presented as current. Mirrors the web. */}
        {hoursExpired(business.opening_hours_until, new Date()) && (
          <Text style={styles.hoursStale}>
            These were the summer hours, which ran to{' '}
            {new Date(business.opening_hours_until!).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}.
            Check before you go.
          </Text>
        )}
        {days.map((d, i) => {
          const val = oh[d.key];
          if (!val) return null;
          const shown = formatDay(val);
          const isToday = i === todayIdx;
          return (
            <View key={d.key} style={styles.hoursRow}>
              <Text style={[styles.hoursDay, isToday && { color: accent, fontWeight: '800' }]}>
                {d.label}{isToday ? ' · Today' : ''}
              </Text>
              <Text style={[styles.hoursTime, isToday && { color: accent, fontWeight: '800' }]}>{shown}</Text>
            </View>
          );
        })}
      </View>
    );
  })();

  const infoSection = (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Info</Text>
          {shows('mapPin') && (
            <BusinessLocationMap
              lat={business.lat}
              lng={business.lng}
              name={business.name}
              address={business.address}
              color={accent}
            />
          )}
          <View style={styles.infoCard}>
            <InfoRow icon="map-marker-alt" label="Address" value={business.address} accentColor={accent} />
            {business.phone && (
              <>
                <View style={styles.infoDivider} />
                <InfoRow
                  icon="phone" label="Phone" value={business.phone}
                  onPress={() => { track('contact_clicked', { objectType: 'business', objectId: business.id, businessId: business.id, props: { method: 'phone' } }); Linking.openURL(`tel:${business.phone}`); }}
                  accentColor={accent}
                />
              </>
            )}
            {shows('extraContacts') && business.website && (
              <>
                <View style={styles.infoDivider} />
                <InfoRow
                  icon="globe" label="Website" value={business.website}
                  onPress={() => { track('contact_clicked', { objectType: 'business', objectId: business.id, businessId: business.id, props: { method: 'website' } }); Linking.openURL(business.website!); }}
                  accentColor={accent}
                />
              </>
            )}
            {shows('wallet') && business.accepts_wallet && (
              <>
                <View style={styles.infoDivider} />
                <InfoRow
                  icon="wallet"
                  label="Local Wallet"
                  value={(business.cashback_percent ?? 0) > 0
                    ? `Pay with wallet · ${business.cashback_percent}% cashback`
                    : 'Pay with wallet'}
                  accentColor={accent}
                />
              </>
            )}
          </View>
          {openingHoursSection}
        </View>
  );

  // ── Claim this business (unclaimed seeded listings) ──────────────────────────
  const claimSection = (!business.is_claimed && !isOwner) ? (
          <View style={styles.section}>
            <View style={[styles.claimCard, { borderColor: accent }]}>
              <View style={[styles.claimIcon, { backgroundColor: accent }]}>
                <FontAwesome5 name="store" size={16} color="#fff" solid />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.claimTitle}>Is this your business?</Text>
                <Text style={styles.claimBody}>
                  Claim this free listing to update your details, add offers and reach locals.
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.claimBtn, { backgroundColor: accent }]}
                onPress={() => {
                  Haptics.selectionAsync();
                  if (!profile) { goToSignIn(`/local-business-detail?id=${id}`); return; }
                  router.push(`/business-claim?id=${business.id}`);
                }}
                activeOpacity={0.85}
              >
                <Text style={styles.claimBtnText}>Claim</Text>
              </TouchableOpacity>
            </View>
          </View>
  ) : null;

  // ── Owner manage ───────────────────────────────────────────────────────────
  const ownerSection = isOwner ? (
          <View style={styles.section}>
            <TouchableOpacity
              style={[styles.ownerBtn, { backgroundColor: accent }]}
              onPress={() => router.push('/local-business-dashboard')}
              activeOpacity={0.85}
            >
              <FontAwesome5 name="cog" size={13} color="#fff" solid />
              <Text style={styles.ownerBtnText}>Manage business</Text>
            </TouchableOpacity>
          </View>
  ) : null;

  // ── Owner upgrade hint (owner-only, no price/buy — points at web dashboard) ─
  const upgradeHintSection = upgradeHint ? (
          <View style={styles.section}>
            <TouchableOpacity
              style={styles.upgradeHint}
              onPress={() => router.push('/local-business-dashboard')}
              activeOpacity={0.85}
            >
              <FontAwesome5 name="unlock-alt" size={13} color={accent} solid />
              <Text style={styles.upgradeHintText}>
                Upgrade to {upgradeHint.tier} to show {upgradeHint.feature} on your listing.
                {' '}Manage your plan on the web dashboard.
              </Text>
            </TouchableOpacity>
          </View>
  ) : null;

  // ── Compose ────────────────────────────────────────────────────────────────
  // Phone: single stacked column. Tablet: showcase content in a wide main
  // column, with contact/info + hiring in a fixed-width sidebar, all centred
  // within a max-width container so tiles never stretch edge-to-edge.
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {heroSection}

        <View style={[styles.body, isTablet && styles.bodyTablet]}>
          {isTablet ? (
            <View style={styles.columns}>
              <View style={styles.mainCol}>
                {claimSection}
                {bookCtaSection}
                {descriptionSection}
                {servicesSection}
                {ticketsSection}
                {offersSection}
                {shopSection}
                {loyaltySection}
                {eventsSection}
              </View>
              <View style={styles.sideCol}>
                {infoSection}
                {hiringSection}
                {upgradeHintSection}
                {ownerSection}
              </View>
            </View>
          ) : (
            <>
              {claimSection}
              {bookCtaSection}
              {ticketsSection}
              {descriptionSection}
              {loyaltySection}
              {offersSection}
              {shopSection}
              {hiringSection}
              {eventsSection}
              {servicesSection}
              {infoSection}
              {upgradeHintSection}
              {ownerSection}
            </>
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function InfoRow({ icon, label, value, onPress, accentColor = S.color }: {
  icon: string; label: string; value: string; onPress?: () => void; accentColor?: string;
}) {
  const Wrap: any = onPress ? TouchableOpacity : View;
  return (
    <Wrap style={styles.infoRow} onPress={onPress} activeOpacity={0.7}>
      <View style={[styles.infoIcon, { backgroundColor: accentColor + '18' }]}>
        <FontAwesome5 name={icon as any} size={12} color={accentColor} solid />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={[styles.infoValue, onPress && { color: accentColor }]}>{value}</Text>
      </View>
      {onPress && <FontAwesome5 name="external-link-alt" size={10} color={colors.textLight} />}
    </Wrap>
  );
}

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: colors.navy },
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content: { paddingBottom: 40 },

  // Post-hero body. Phone: pass-through. Tablet: centred max-width canvas.
  body: {},
  bodyTablet: {
    width: '100%', maxWidth: 1100, alignSelf: 'center',
    paddingHorizontal: spacing.lg, paddingTop: spacing.sm,
  },
  columns: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xl },
  mainCol: { flex: 1, minWidth: 0 },
  sideCol: { width: 320 },
  center:  { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: colors.textMuted, fontSize: fontSize.md },

  hero: {
    backgroundColor: colors.screenBackground,
    borderBottomWidth: 3, borderBottomColor: S.color,
  },
  banner: {
    width: '100%', height: 168,
    overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
  },
  bannerWatermark: {
    position: 'absolute', right: -10, bottom: -16,
    transform: [{ rotate: '-12deg' }],
  },
  bannerScrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.12)',
  },
  backBtnOverlay: {
    position: 'absolute', top: spacing.sm, left: spacing.md,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(0,0,0,0.38)',
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.full,
  },
  backTextOverlay: { color: '#fff', fontSize: fontSize.sm, fontWeight: '700' },

  heroBody: {
    paddingHorizontal: spacing.lg, paddingBottom: spacing.lg,
  },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  heroLogo: {
    width: 84, height: 84, borderRadius: radius.lg, marginTop: -42,
    borderWidth: 4, borderColor: colors.screenBackground,
    backgroundColor: '#fff', padding: 6,
  },
  heroLogoFallback: { alignItems: 'center', justifyContent: 'center' },
  heroNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 12 },
  heroName: { color: colors.textPrimary, fontSize: 24, fontWeight: '900', lineHeight: 28, flexShrink: 1 },
  heroCategoryChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    backgroundColor: S.color + '14', paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: radius.full, marginTop: 8,
  },
  heroCategoryChipText: { color: S.color, fontSize: fontSize.xs, fontWeight: '800' },

  followBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 10, borderRadius: radius.full,
    backgroundColor: S.color, paddingHorizontal: 18,
  },
  followBtnText: { fontSize: fontSize.xs, fontWeight: '800' },

  bookCtaBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#10B981', borderRadius: radius.lg,
    padding: spacing.md,
    shadowColor: '#10B981', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10, elevation: 4,
  },
  bookCtaIcon:  { width: 38, height: 38, borderRadius: radius.md, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  bookCtaTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '900' },
  bookCtaSub:   { color: 'rgba(255,255,255,0.85)', fontSize: fontSize.xs, fontWeight: '600', marginTop: 1 },

  // Unit items (tickets, class packs, day passes)
  unitCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: spacing.md, borderWidth: 1, borderColor: colors.border,
  },
  unitName:    { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  unitDesc:    { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 3, lineHeight: 17 },
  unitMetaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 6 },
  unitPrice:   { fontSize: fontSize.sm, fontWeight: '900' },
  unitMetaText:{ fontSize: 11, color: colors.textMuted, fontWeight: '600' },
  unitBtnCol:  { gap: 6, alignItems: 'stretch' },
  unitBuyBtn:  { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.md, alignItems: 'center' },
  unitBuyText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  unitGiftBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: radius.md, borderWidth: 1 },
  unitGiftText:{ fontSize: 11, fontWeight: '800' },

  section:      { paddingHorizontal: spacing.md, marginTop: spacing.lg },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginBottom: 10 },
  descText:     { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 22 },

  // Loyalty
  loyaltyCard: {
    backgroundColor: '#fff', borderRadius: radius.xl,
    padding: spacing.md, gap: 10,
    borderWidth: 1.5, borderColor: S.color + '33',
  },
  loyaltyReward:    { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  loyaltyCount:     { fontSize: fontSize.md },
  loyaltyCountNum:  { fontSize: 22, fontWeight: '900' },
  loyaltyCountRest: { color: colors.textMuted, fontSize: fontSize.xs, fontWeight: '600' },

  stampGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 4 },
  stamp: {
    width: 28, height: 28, borderRadius: 14, borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },

  redeemBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, borderRadius: radius.md, marginTop: 4,
  },
  redeemBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  nudge: { borderRadius: radius.md, paddingVertical: 8, paddingHorizontal: 12, marginTop: 8 },
  nudgeText: { fontSize: fontSize.xs, fontWeight: '800', textAlign: 'center' },
  ladderList: { marginTop: 12, gap: 8 },
  ladderRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ladderDot: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  ladderReward: { flex: 1, fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  ladderStatus: { fontSize: 11, fontWeight: '800' },

  collectBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 10, marginTop: 4,
    backgroundColor: S.light, borderRadius: radius.md,
  },
  collectBtnText: { fontSize: fontSize.xs, fontWeight: '800' },

  // Offer rows
  offerRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 12, borderWidth: 1, borderColor: colors.border,
  },
  offerBadge: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: radius.md, minWidth: 64, alignItems: 'center' },
  offerBadgeText: { color: '#fff', fontSize: 11, fontWeight: '900', textAlign: 'center' },
  offerTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  offerDesc:  { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1, lineHeight: 16 },
  offerExpiry:{ fontSize: 10, color: colors.textLight, fontWeight: '600', marginTop: 4 },
  // Services on detail page
  serviceRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 12, borderWidth: 1, borderColor: colors.border,
  },
  serviceIcon: {
    width: 38, height: 38, borderRadius: radius.md,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  serviceName:  { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  serviceDesc:  { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1, lineHeight: 16 },
  serviceMeta:  { fontSize: 11, color: colors.textLight, fontWeight: '600', marginTop: 4 },
  servicePrice: { fontSize: fontSize.sm, fontWeight: '900' },
  serviceBookBtn: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.md, flexShrink: 0,
  },
  serviceBookBtnText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  // Shifts on detail page
  shiftRow:        { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border },
  shiftIcon:       { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  shiftTitle:      { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  shiftMetaRow:    { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  urgencyPill:     { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.full },
  urgencyPillText: { fontSize: 9, fontWeight: '900', letterSpacing: 0.5, textTransform: 'uppercase' },
  shiftMetaText:   { fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '700' },

  offerClaimBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.full },
  offerClaimBtnText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  offerClaimed: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.successLight, paddingHorizontal: 8, paddingVertical: 6, borderRadius: radius.full },
  offerClaimedText: { fontSize: 10, fontWeight: '700', color: colors.success },

  // Info
  infoCard: {
    backgroundColor: '#fff', borderRadius: radius.xl,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  },
  infoRow:  { flexDirection: 'row', alignItems: 'center', gap: 12, padding: spacing.md },
  infoDivider: { height: 1, backgroundColor: colors.border, marginHorizontal: spacing.md },
  infoIcon: { width: 32, height: 32, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  infoLabel:{ fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600', marginBottom: 1 },
  infoValue:{ fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '700' },

  ownerBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingVertical: 14, borderRadius: radius.lg,
  },
  ownerBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  // Owner-only upgrade hint (no price/buy button — compliance)
  upgradeHint: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed',
    padding: spacing.md,
  },
  upgradeHintText: { flex: 1, fontSize: fontSize.xs, color: colors.textMuted, fontWeight: '600', lineHeight: 17 },

  // Claim-this-business banner
  claimCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1.5,
    padding: spacing.md,
  },
  claimIcon: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
  },
  claimTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  claimBody:  { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, lineHeight: 17 },
  claimBtn:   { paddingHorizontal: 18, paddingVertical: 10, borderRadius: radius.md },
  claimBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  // Opening hours
  hoursCard: {
    marginTop: spacing.sm, backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md,
  },
  hoursStale: {
    marginTop: 6, marginBottom: 4, paddingHorizontal: 10, paddingVertical: 8,
    borderRadius: radius.sm, backgroundColor: colors.warningLight,
    fontSize: fontSize.xs, lineHeight: 16, color: colors.warningDark,
  },
  hoursHeading: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, marginBottom: 8 },
  hoursRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  hoursDay:  { fontSize: fontSize.sm, color: colors.textMuted },
  hoursTime: { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '600' },

  // Add-on placeholder sections
  addonPlaceholderRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  addonPlaceholderIcon:{ width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  addonPlaceholderSub: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },

  eventRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, padding: 10,
  },
  eventDatePill: {
    width: 36, alignItems: 'center', borderRadius: radius.sm, paddingVertical: 4, flexShrink: 0,
  },
  eventDateDay:   { color: '#fff', fontSize: fontSize.md, fontWeight: '900', lineHeight: 18 },
  eventDateMonth: { color: 'rgba(255,255,255,0.8)', fontSize: 9, fontWeight: '700' },
  eventTitle:     { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  eventMeta:      { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
});
