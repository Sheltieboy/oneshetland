/**
 * local-business-detail.tsx
 * Customer-facing business profile: info, follow, loyalty card, active offers.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  ActivityIndicator, Alert, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
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
  formatOfferDiscount, daysRemaining,
  type LocalBusiness, type LoyaltyProgram, type LoyaltyCard, type LocalOffer,
} from '@/lib/local-api';
import { isBookableLive } from '@/lib/book-api';
import { supabase } from '@/lib/supabase';

const S = SECTIONS.local;

export default function BusinessDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { profile } = useAuth();

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

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [b, p, o, s] = await Promise.all([
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
          .then(({ data }) => data ?? [])
          .catch(() => [] as any[]),
      ]);
      setBusiness(b);
      setProgram(p);
      setOffers(o);
      setOpenShifts(s as any[]);

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

  const handleRedeemReward = async () => {
    if (!card) return;
    Alert.alert(
      'Redeem reward?',
      'Show this to staff to claim. The card will reset to 0 stamps once redeemed.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Redeem', onPress: async () => {
          setBusy(true);
          try {
            await redeemReward(card.id);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            await load();
            Alert.alert('Redeemed!', 'Show staff your card. Enjoy 🎉');
          } catch (e: any) {
            Alert.alert('Error', e.message);
          } finally {
            setBusy(false);
          }
        }},
      ],
    );
  };

  const handleRedeemOffer = async (offer: LocalOffer) => {
    Alert.alert(
      'Claim this offer?',
      `Show staff to use "${offer.title}". You can only use this offer once.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Claim', onPress: async () => {
          setBusy(true);
          try {
            await redeemOffer(offer.id);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            await load();
          } catch (e: any) {
            Alert.alert('Error', e.message);
          } finally {
            setBusy(false);
          }
        }},
      ],
    );
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
  const stamps  = card?.stamps_collected ?? 0;
  const needed  = program?.stamps_required ?? 10;
  const progress = Math.min(1, stamps / needed);
  const rewardReady = program?.type === 'stamps' && stamps >= needed;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>

        {/* ── Hero ── */}
        <View style={[styles.hero, { borderBottomColor: S.color }]}>
          <TouchableOpacity
            style={styles.backBtn}
            onPress={() => {
              if (router.canGoBack()) router.back();
              else router.replace('/(tabs)/local');
            }}
            hitSlop={12}
          >
            <FontAwesome5 name="chevron-left" size={13} color={S.color} />
            <Text style={[styles.backText, { color: S.color }]}>Local</Text>
          </TouchableOpacity>

          <View style={styles.heroTop}>
            {business.logo_url ? (
              <Image source={{ uri: business.logo_url }} style={styles.heroLogo} />
            ) : (
              <View style={[styles.heroLogo, { backgroundColor: S.color + '33', alignItems: 'center', justifyContent: 'center' }]}>
                <FontAwesome5 name={CATEGORY_ICONS[business.category] as any} size={26} color={S.color} solid />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <View style={styles.heroNameRow}>
                <Text style={styles.heroName} numberOfLines={2}>{business.name}</Text>
                {business.is_verified && (
                  <FontAwesome5 name="check-circle" size={14} color={S.color} solid />
                )}
              </View>
              <Text style={styles.heroCategory}>{CATEGORY_LABELS[business.category]}</Text>
            </View>
          </View>

          {!isOwner && profile && (
            <TouchableOpacity
              style={[styles.followBtn, following && { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: S.color }]}
              onPress={handleFollowToggle}
              activeOpacity={0.85}
            >
              <FontAwesome5 name={following ? 'check' : 'plus'} size={11} color={following ? S.color : '#fff'} />
              <Text style={[styles.followBtnText, { color: following ? S.color : '#fff' }]}>
                {following ? 'Following' : 'Follow'}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── Book now (OneShetland Book) ── */}
        {/* Shown to everyone (incl. owner — useful for previewing the profile) */}
        {isBookableLive(business) && (
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
        )}

        {/* ── Description ── */}
        {business.description && (
          <View style={styles.section}>
            <Text style={styles.descText}>{business.description}</Text>
          </View>
        )}

        {/* ── Loyalty card ── */}
        {program && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Loyalty</Text>
            <View style={styles.loyaltyCard}>
              {program.type === 'stamps' ? (
                <>
                  <Text style={styles.loyaltyReward}>{program.stamp_reward ?? 'Loyalty reward'}</Text>
                  <Text style={styles.loyaltyCount}>
                    <Text style={[styles.loyaltyCountNum, { color: S.color }]}>{stamps}</Text>
                    <Text style={styles.loyaltyCountRest}> / {needed} stamps</Text>
                  </Text>
                  <View style={styles.stampGrid}>
                    {Array.from({ length: needed }).map((_, i) => {
                      const filled = i < stamps;
                      return (
                        <View
                          key={i}
                          style={[styles.stamp, filled ? { backgroundColor: S.color, borderColor: S.color } : { borderColor: colors.border }]}
                        >
                          {filled && <FontAwesome5 name="check" size={10} color="#fff" />}
                        </View>
                      );
                    })}
                  </View>
                  {rewardReady && (
                    <TouchableOpacity
                      style={[styles.redeemBtn, { backgroundColor: S.color }, busy && { opacity: 0.7 }]}
                      onPress={handleRedeemReward}
                      disabled={busy}
                      activeOpacity={0.85}
                    >
                      <FontAwesome5 name="gift" size={13} color="#fff" solid />
                      <Text style={styles.redeemBtnText}>Redeem reward</Text>
                    </TouchableOpacity>
                  )}
                </>
              ) : (
                <>
                  <Text style={styles.loyaltyReward}>
                    Earn {program.points_per_pound} points per £1 · {program.points_for_pound} points = £1 off
                  </Text>
                  <Text style={styles.loyaltyCount}>
                    <Text style={[styles.loyaltyCountNum, { color: S.color }]}>{card?.points_balance ?? 0}</Text>
                    <Text style={styles.loyaltyCountRest}> points</Text>
                  </Text>
                </>
              )}
              <TouchableOpacity
                style={styles.collectBtn}
                onPress={() => router.push('/local-stamp-scanner')}
                activeOpacity={0.8}
              >
                <FontAwesome5 name="qrcode" size={11} color={S.color} />
                <Text style={[styles.collectBtnText, { color: S.color }]}>Collect a stamp</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Offers ── */}
        {offers.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Current offers</Text>
            <View style={{ gap: 8 }}>
              {offers.map(o => {
                const claimed = redeemedIds.has(o.id);
                return (
                  <View key={o.id} style={styles.offerRow}>
                    <View style={[styles.offerBadge, { backgroundColor: S.color }]}>
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
                          style={[styles.offerClaimBtn, { backgroundColor: S.color }]}
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
        )}

        {/* ── Open shifts posted by this business ── */}
        {openShifts.length > 0 && (
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
        )}

        {/* ── Info ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Info</Text>
          <View style={styles.infoCard}>
            <InfoRow icon="map-marker-alt" label="Address" value={business.address} />
            {business.phone && (
              <>
                <View style={styles.infoDivider} />
                <InfoRow
                  icon="phone" label="Phone" value={business.phone}
                  onPress={() => Linking.openURL(`tel:${business.phone}`)}
                />
              </>
            )}
            {business.website && (
              <>
                <View style={styles.infoDivider} />
                <InfoRow
                  icon="globe" label="Website" value={business.website}
                  onPress={() => Linking.openURL(business.website!)}
                />
              </>
            )}
            {business.accepts_wallet && (
              <>
                <View style={styles.infoDivider} />
                <InfoRow
                  icon="wallet"
                  label="Local Wallet"
                  value={(business.cashback_percent ?? 0) > 0
                    ? `Pay with wallet · ${business.cashback_percent}% cashback`
                    : 'Pay with wallet'}
                />
              </>
            )}
          </View>
        </View>

        {isOwner && (
          <View style={styles.section}>
            <TouchableOpacity
              style={[styles.ownerBtn, { backgroundColor: S.color }]}
              onPress={() => router.push('/local-business-dashboard')}
              activeOpacity={0.85}
            >
              <FontAwesome5 name="cog" size={13} color="#fff" solid />
              <Text style={styles.ownerBtnText}>Manage business</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function InfoRow({ icon, label, value, onPress }: {
  icon: string; label: string; value: string; onPress?: () => void;
}) {
  const Wrap: any = onPress ? TouchableOpacity : View;
  return (
    <Wrap style={styles.infoRow} onPress={onPress} activeOpacity={0.7}>
      <View style={[styles.infoIcon, { backgroundColor: S.color + '18' }]}>
        <FontAwesome5 name={icon as any} size={12} color={S.color} solid />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={[styles.infoValue, onPress && { color: S.color }]}>{value}</Text>
      </View>
      {onPress && <FontAwesome5 name="external-link-alt" size={10} color={colors.textLight} />}
    </Wrap>
  );
}

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: colors.screenBackground },
  scroll:  { flex: 1 },
  content: { paddingBottom: 40 },
  center:  { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: colors.textMuted, fontSize: fontSize.md },

  hero: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.lg,
    gap: 14, borderBottomWidth: 3,
  },
  backBtn:  { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  backText: { fontSize: fontSize.sm, fontWeight: '700' },
  heroTop:  { flexDirection: 'row', gap: 14, alignItems: 'center' },
  heroLogo: { width: 72, height: 72, borderRadius: radius.lg },
  heroNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  heroName: { color: '#fff', fontSize: 22, fontWeight: '900', lineHeight: 26, flexShrink: 1 },
  heroCategory: { color: 'rgba(255,255,255,0.55)', fontSize: fontSize.xs, fontWeight: '600', marginTop: 2 },

  followBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 10, borderRadius: radius.full,
    backgroundColor: S.color, alignSelf: 'flex-start', paddingHorizontal: 16,
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
});
