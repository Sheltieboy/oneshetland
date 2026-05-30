/**
 * (tabs)/local.tsx — OneShetland Local hub
 *
 * Landing for the Local section: wallet snapshot, quick actions,
 * featured businesses, latest offers, and the user's loyalty cards.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Image, ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { TabScreenHeader } from '@/components/TabScreenHeader';
import {
  fetchActiveBusinesses, fetchActiveOffers, fetchMyLoyaltyCards,
  fetchWalletBalance, fetchMyBusinesses,
  formatPence, formatOfferDiscount, daysRemaining,
  CATEGORY_LABELS, CATEGORY_ICONS,
  type LocalBusiness, type LocalOffer, type LoyaltyCard,
} from '@/lib/local-api';
import { fetchMyBookings, isBookableLive, type BookBooking } from '@/lib/book-api';

const S = SECTIONS.local;

export default function LocalHub() {
  const router      = useRouter();
  const { profile } = useAuth();

  const [businesses,  setBusinesses]  = useState<LocalBusiness[]>([]);
  const [offers,      setOffers]      = useState<LocalOffer[]>([]);
  const [cards,       setCards]       = useState<LoyaltyCard[]>([]);
  const [balance,     setBalance]     = useState<number>(0);
  const [myBizCount,  setMyBizCount]  = useState<number>(0);
  const [bookings,    setBookings]    = useState<BookBooking[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);

  const load = useCallback(async () => {
    try {
      const [biz, ofs, cds, bal, mine, bks] = await Promise.all([
        fetchActiveBusinesses().catch(() => []),
        fetchActiveOffers().catch(() => []),
        profile ? fetchMyLoyaltyCards(profile.id).catch(() => []) : Promise.resolve([]),
        profile ? fetchWalletBalance(profile.id).catch(() => 0)   : Promise.resolve(0),
        profile ? fetchMyBusinesses(profile.id).catch(() => [])   : Promise.resolve([]),
        profile ? fetchMyBookings(profile.id).catch(() => [])     : Promise.resolve([] as BookBooking[]),
      ]);
      setBusinesses(biz);
      setOffers(ofs);
      setCards(cds);
      setBalance(bal);
      setMyBizCount(mine.length);
      setBookings(bks);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile?.id]);

  useEffect(() => { load(); }, [load]);

  const featured     = businesses.filter(b => b.is_verified).slice(0, 6);
  const bookableNow  = businesses.filter(isBookableLive).slice(0, 6);
  const allCount     = businesses.length;
  const latestOffers = offers.slice(0, 4);

  const now = Date.now();
  const upcomingBookings = bookings
    .filter(b => b.status !== 'cancelled' && new Date(b.starts_at).getTime() >= now)
    .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime());

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <TabScreenHeader
        section={S}
        right={
          <View style={[styles.headerBadge, { backgroundColor: S.color + '22' }]}>
            <View style={[styles.headerBadgeDot, { backgroundColor: S.color }]} />
            <Text style={[styles.headerBadgeText, { color: S.color }]}>Live</Text>
          </View>
        }
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
      >

        {/* ── Wallet snapshot ── */}
        <TouchableOpacity
          style={styles.walletCard}
          onPress={() => router.push('/local-wallet')}
          activeOpacity={0.9}
        >
          <View style={styles.walletTop}>
            <View>
              <Text style={styles.walletLabel}>Local Wallet</Text>
              <Text style={styles.walletBalance}>{formatPence(balance)}</Text>
            </View>
            <View style={styles.walletIconWrap}>
              <FontAwesome5 name="wallet" size={20} color="#fff" solid />
            </View>
          </View>
          <View style={styles.walletActions}>
            <View style={styles.walletAction}>
              <FontAwesome5 name="plus" size={11} color="#fff" />
              <Text style={styles.walletActionText}>Top up</Text>
            </View>
            <View style={styles.walletActionDivider} />
            <View style={styles.walletAction}>
              <FontAwesome5 name="qrcode" size={11} color="#fff" />
              <Text style={styles.walletActionText}>Pay at till</Text>
            </View>
          </View>
        </TouchableOpacity>

        {/* ── Quick action tiles ── */}
        <View style={styles.actionTiles}>
          <ActionTile
            icon="search"
            label="Browse"
            sub={`${allCount} local${allCount !== 1 ? 's' : ''}`}
            onPress={() => router.push('/local-businesses-browse')}
          />
          <ActionTile
            icon="calendar-check"
            label="Book"
            sub={upcomingBookings.length > 0
              ? `${upcomingBookings.length} upcoming · browse`
              : 'Find a slot'}
            onPress={() => router.push('/local-bookable-browse')}
          />
          <ActionTile
            icon="stamp"
            label="Stamps"
            sub={cards.length > 0 ? `${cards.length} card${cards.length !== 1 ? 's' : ''}` : 'Collect'}
            onPress={() => router.push('/local-my-cards')}
          />
          <ActionTile
            icon="tags"
            label="Offers"
            sub={`${offers.length} active`}
            onPress={() => router.push('/local-offers')}
          />
          <ActionTile
            icon="qrcode"
            label="Scan"
            sub="Stamp or pay"
            onPress={() => router.push('/local-stamp-scanner')}
          />
        </View>

        {/* ── Upcoming bookings strip ── */}
        {upcomingBookings.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Your bookings</Text>
              <TouchableOpacity onPress={() => router.push('/local-my-bookings')}>
                <Text style={[styles.sectionLink, { color: S.color }]}>See all →</Text>
              </TouchableOpacity>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hStripContent}>
              {upcomingBookings.slice(0, 5).map(b => <MiniBookingCard key={b.id} booking={b} />)}
            </ScrollView>
          </View>
        )}

        {/* ── Bookable now (only when there's something to surface) ── */}
        {bookableNow.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Bookable now</Text>
              <TouchableOpacity onPress={() => router.push('/local-bookable-browse')}>
                <Text style={[styles.sectionLink, { color: S.color }]}>See all →</Text>
              </TouchableOpacity>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hStripContent}>
              {bookableNow.map(b => <MiniBookableCard key={b.id} business={b} />)}
            </ScrollView>
          </View>
        )}

        {/* ── My loyalty cards strip (if user has any) ── */}
        {cards.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Your cards</Text>
              <TouchableOpacity onPress={() => router.push('/local-my-cards')}>
                <Text style={[styles.sectionLink, { color: S.color }]}>See all →</Text>
              </TouchableOpacity>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hStripContent}>
              {cards.slice(0, 5).map(c => <MiniLoyaltyCard key={c.id} card={c} />)}
            </ScrollView>
          </View>
        )}

        {/* ── Latest offers ── */}
        {latestOffers.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Latest offers</Text>
              <TouchableOpacity onPress={() => router.push('/local-offers')}>
                <Text style={[styles.sectionLink, { color: S.color }]}>All offers →</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.offerList}>
              {latestOffers.map(o => <OfferCard key={o.id} offer={o} />)}
            </View>
          </View>
        )}

        {/* ── Featured businesses ── */}
        {featured.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Featured locals</Text>
              <TouchableOpacity onPress={() => router.push('/local-businesses-browse')}>
                <Text style={[styles.sectionLink, { color: S.color }]}>Browse all →</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.businessList}>
              {featured.map(b => <BusinessCard key={b.id} business={b} />)}
            </View>
          </View>
        )}

        {/* ── Empty state ── */}
        {!loading && businesses.length === 0 && (
          <View style={styles.empty}>
            <View style={[styles.emptyIcon, { backgroundColor: S.light }]}>
              <FontAwesome5 name="store" size={28} color={S.color} solid />
            </View>
            <Text style={styles.emptyTitle}>No businesses yet</Text>
            <Text style={styles.emptyText}>
              Be the first to list your shop, café or pub.
            </Text>
          </View>
        )}

        {/* ── Business owner CTA ── */}
        <View style={styles.bizCta}>
          {myBizCount > 0 ? (
            <TouchableOpacity
              style={[styles.bizCtaBtn, { borderColor: S.color }]}
              onPress={() => router.push('/local-business-dashboard')}
              activeOpacity={0.8}
            >
              <FontAwesome5 name="store" size={13} color={S.color} solid />
              <Text style={[styles.bizCtaText, { color: S.color }]}>Manage my business{myBizCount > 1 ? 'es' : ''}</Text>
              <FontAwesome5 name="chevron-right" size={11} color={S.color} />
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.bizCtaPrompt}
              onPress={() => {
                Haptics.selectionAsync();
                // Bounce to sign-in if not authenticated — passing the register
                // path as the "next" so we return after sign-in.
                if (!profile) {
                  router.push({ pathname: '/(auth)/sign-in', params: { next: '/local-business-register' } });
                } else {
                  router.push('/local-business-register');
                }
              }}
              activeOpacity={0.8}
            >
              <View style={[styles.bizCtaIcon, { backgroundColor: S.color }]}>
                <FontAwesome5 name="store" size={13} color="#fff" solid />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.bizCtaPromptTitle}>Run a Shetland business?</Text>
                <Text style={styles.bizCtaPromptSub}>
                  {profile ? 'List free in under 2 minutes' : 'Sign in to list yours'}
                </Text>
              </View>
              <FontAwesome5 name="chevron-right" size={12} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        {loading && (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <ActivityIndicator color={S.color} />
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ActionTile({ icon, label, sub, onPress }: {
  icon: string; label: string; sub: string; onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.actionTile}
      onPress={() => { Haptics.selectionAsync(); onPress(); }}
      activeOpacity={0.85}
    >
      <View style={[styles.actionTileIcon, { backgroundColor: S.color + '18' }]}>
        <FontAwesome5 name={icon as any} size={14} color={S.color} solid />
      </View>
      <Text style={styles.actionTileLabel}>{label}</Text>
      <Text style={styles.actionTileSub}>{sub}</Text>
    </TouchableOpacity>
  );
}

function MiniBookableCard({ business }: { business: LocalBusiness }) {
  const router = useRouter();
  return (
    <TouchableOpacity
      style={styles.miniBookable}
      onPress={() => router.push({ pathname: '/local-business-detail', params: { id: business.id } })}
      activeOpacity={0.85}
    >
      {business.logo_url ? (
        <Image source={{ uri: business.logo_url }} style={styles.miniBookableLogo} />
      ) : (
        <View style={[styles.miniBookableLogo, { backgroundColor: S.light, alignItems: 'center', justifyContent: 'center' }]}>
          <FontAwesome5 name={CATEGORY_ICONS[business.category] as any} size={20} color={S.color} solid />
        </View>
      )}
      <View style={styles.miniBookableTextBlock}>
        <Text style={styles.miniBookableName} numberOfLines={1}>{business.name}</Text>
        <Text style={styles.miniBookableCategory} numberOfLines={1}>{CATEGORY_LABELS[business.category]}</Text>
      </View>
      <View style={styles.miniBookableTag}>
        <FontAwesome5 name="calendar-check" size={9} color={S.color} solid />
        <Text style={[styles.miniBookableTagText, { color: S.color }]}>Book</Text>
      </View>
    </TouchableOpacity>
  );
}

function MiniBookingCard({ booking }: { booking: BookBooking }) {
  const router = useRouter();
  const starts = new Date(booking.starts_at);
  const today  = new Date(); today.setHours(0,0,0,0);
  const startDay = new Date(starts); startDay.setHours(0,0,0,0);
  const daysOff  = Math.round((startDay.getTime() - today.getTime()) / 86_400_000);
  const dayLabel =
    daysOff === 0 ? 'Today' :
    daysOff === 1 ? 'Tomorrow' :
    starts.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  return (
    <TouchableOpacity
      style={styles.miniBooking}
      onPress={() => router.push('/local-my-bookings')}
      activeOpacity={0.85}
    >
      <View style={styles.miniBookingTop}>
        <FontAwesome5 name="calendar-check" size={11} color={S.color} solid />
        <Text style={[styles.miniBookingDay, { color: S.color }]}>{dayLabel}</Text>
      </View>
      <Text style={styles.miniBookingTime}>
        {starts.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}
      </Text>
      <Text style={styles.miniBookingBiz} numberOfLines={1}>
        {booking.business?.name ?? 'Booking'}
      </Text>
      <Text style={styles.miniBookingSvc} numberOfLines={1}>
        {booking.service?.name ?? ''}
      </Text>
    </TouchableOpacity>
  );
}

function MiniLoyaltyCard({ card }: { card: LoyaltyCard }) {
  const router = useRouter();
  const program = card.program;
  const isStamp = program?.type === 'stamps';
  const stamps   = card.stamps_collected;
  const needed   = program?.stamps_required ?? 10;
  const progress = Math.min(1, stamps / needed);

  return (
    <TouchableOpacity
      style={styles.miniCard}
      onPress={() => router.push({ pathname: '/local-business-detail', params: { id: card.business_id } })}
      activeOpacity={0.85}
    >
      <Text style={styles.miniCardName} numberOfLines={1}>
        {card.business?.name ?? 'Local'}
      </Text>
      {isStamp ? (
        <>
          <Text style={styles.miniCardCount}>
            <Text style={[styles.miniCardCountNum, { color: S.color }]}>{stamps}</Text>
            <Text style={styles.miniCardCountRest}> / {needed}</Text>
          </Text>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { backgroundColor: S.color, width: `${progress * 100}%` }]} />
          </View>
        </>
      ) : (
        <>
          <Text style={styles.miniCardCount}>
            <Text style={[styles.miniCardCountNum, { color: S.color }]}>{card.points_balance}</Text>
            <Text style={styles.miniCardCountRest}> points</Text>
          </Text>
        </>
      )}
    </TouchableOpacity>
  );
}

function OfferCard({ offer }: { offer: LocalOffer }) {
  const router = useRouter();
  const days = daysRemaining(offer.valid_until);
  return (
    <TouchableOpacity
      style={styles.offerCard}
      onPress={() => router.push({ pathname: '/local-business-detail', params: { id: offer.business_id } })}
      activeOpacity={0.85}
    >
      <View style={styles.offerCardLeft}>
        <View style={[styles.offerDiscount, { backgroundColor: S.color }]}>
          <Text style={styles.offerDiscountText}>{formatOfferDiscount(offer)}</Text>
        </View>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.offerTitle} numberOfLines={1}>{offer.title}</Text>
        {offer.business && (
          <Text style={styles.offerBusiness} numberOfLines={1}>{offer.business.name}</Text>
        )}
        <Text style={styles.offerExpiry}>
          {days === 0 ? 'Ends today' : `${days} day${days !== 1 ? 's' : ''} left`}
        </Text>
      </View>
      <FontAwesome5 name="chevron-right" size={12} color={colors.textLight} />
    </TouchableOpacity>
  );
}

function BusinessCard({ business }: { business: LocalBusiness }) {
  const router = useRouter();
  return (
    <TouchableOpacity
      style={styles.businessCard}
      onPress={() => router.push({ pathname: '/local-business-detail', params: { id: business.id } })}
      activeOpacity={0.85}
    >
      {business.logo_url ? (
        <Image source={{ uri: business.logo_url }} style={styles.businessLogo} />
      ) : (
        <View style={[styles.businessLogo, { backgroundColor: S.light, alignItems: 'center', justifyContent: 'center' }]}>
          <FontAwesome5 name={CATEGORY_ICONS[business.category] as any} size={18} color={S.color} solid />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <View style={styles.businessNameRow}>
          <Text style={styles.businessName} numberOfLines={1}>{business.name}</Text>
          {business.is_verified && (
            <FontAwesome5 name="check-circle" size={11} color={S.color} solid />
          )}
        </View>
        <Text style={styles.businessCategory}>{CATEGORY_LABELS[business.category]}</Text>
        <Text style={styles.businessAddress} numberOfLines={1}>{business.address}</Text>
      </View>
    </TouchableOpacity>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: colors.navy },
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content: { paddingBottom: 60 },

  headerBadge:     { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.full },
  headerBadgeDot:  { width: 6, height: 6, borderRadius: 3 },
  headerBadgeText: { fontSize: 11, fontWeight: '700' },

  // Wallet card
  walletCard: {
    marginHorizontal: spacing.md, marginTop: spacing.md,
    backgroundColor: S.color, borderRadius: radius.xl,
    padding: spacing.md, gap: 12,
    shadowColor: S.color, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 12, elevation: 4,
  },
  walletTop:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  walletLabel:     { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  walletBalance:   { color: '#fff', fontSize: 28, fontWeight: '900', marginTop: 2 },
  walletIconWrap:  { width: 48, height: 48, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  walletActions:   { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: radius.md, padding: 8 },
  walletAction:    { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 4 },
  walletActionText:{ color: '#fff', fontSize: fontSize.xs, fontWeight: '700' },
  walletActionDivider: { width: 1, height: 18, backgroundColor: 'rgba(255,255,255,0.2)' },

  // Action tiles
  actionTiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: spacing.md, paddingTop: spacing.md },
  actionTile: {
    width: '22%', backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 10, alignItems: 'center', gap: 4, minHeight: 86,
    borderWidth: 1, borderColor: colors.border,
  },
  actionTileIcon:  { width: 32, height: 32, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  actionTileLabel: { fontSize: fontSize.xs, fontWeight: '800', color: colors.textPrimary },
  actionTileSub:   { fontSize: 9, color: colors.textMuted, fontWeight: '600' },

  // Section
  section:       { paddingHorizontal: spacing.md, marginTop: spacing.lg },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  sectionTitle:  { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  sectionLink:   { fontSize: fontSize.sm, fontWeight: '700' },

  // Horizontal strip
  hStripContent: { gap: 10, paddingRight: spacing.md },

  // Mini bookable-business card
  miniBookable: {
    width: 180, backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 10, gap: 8,
    borderWidth: 1, borderColor: S.color + '30',
    flexDirection: 'row', alignItems: 'center',
    shadowColor: S.color, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 1,
  },
  miniBookableLogo:     { width: 38, height: 38, borderRadius: radius.md },
  miniBookableTextBlock:{ flex: 1, minWidth: 0 },
  miniBookableName:     { fontSize: fontSize.xs, fontWeight: '800', color: colors.textPrimary },
  miniBookableCategory: { fontSize: 10, color: colors.textMuted, fontWeight: '600', marginTop: 1 },
  miniBookableTag:      { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: S.light, paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.full },
  miniBookableTagText:  { fontSize: 10, fontWeight: '800' },

  // Mini booking card
  miniBooking: {
    width: 170, backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 12, gap: 3,
    borderWidth: 1, borderColor: S.color + '30',
    shadowColor: S.color, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 6, elevation: 2,
  },
  miniBookingTop:  { flexDirection: 'row', alignItems: 'center', gap: 5 },
  miniBookingDay:  { fontSize: 10, fontWeight: '900', letterSpacing: 0.5, textTransform: 'uppercase' },
  miniBookingTime: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary, letterSpacing: -0.5, marginTop: 2 },
  miniBookingBiz:  { fontSize: fontSize.xs, color: colors.textPrimary, fontWeight: '700' },
  miniBookingSvc:  { fontSize: 11, color: colors.textMuted, fontWeight: '600' },

  // Mini loyalty card
  miniCard: {
    width: 150, backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 12, gap: 6,
    borderWidth: 1, borderColor: colors.border,
  },
  miniCardName:      { fontSize: fontSize.xs, fontWeight: '800', color: colors.textPrimary },
  miniCardCount:     { fontSize: fontSize.sm },
  miniCardCountNum:  { fontSize: fontSize.lg, fontWeight: '900' },
  miniCardCountRest: { color: colors.textMuted, fontSize: fontSize.xs, fontWeight: '600' },
  progressTrack: { height: 4, backgroundColor: colors.border, borderRadius: 2, overflow: 'hidden' },
  progressFill:  { height: 4, borderRadius: 2 },

  // Offer card
  offerList: { gap: 8 },
  offerCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 12, borderWidth: 1, borderColor: colors.border,
  },
  offerCardLeft:    { width: 64 },
  offerDiscount:    { paddingHorizontal: 8, paddingVertical: 10, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  offerDiscountText:{ color: '#fff', fontSize: 11, fontWeight: '900', textAlign: 'center' },
  offerTitle:       { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  offerBusiness:    { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
  offerExpiry:      { fontSize: 10, color: colors.textLight, marginTop: 3, fontWeight: '600' },

  // Business card
  businessList: { gap: 8 },
  businessCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 12, borderWidth: 1, borderColor: colors.border,
  },
  businessLogo:   { width: 48, height: 48, borderRadius: radius.md },
  businessNameRow:{ flexDirection: 'row', alignItems: 'center', gap: 6 },
  businessName:   { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary, flexShrink: 1 },
  businessCategory:{ fontSize: 10, color: S.color, fontWeight: '700', marginTop: 1 },
  businessAddress:{ fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },

  // Empty
  empty:      { alignItems: 'center', padding: spacing.xl, gap: 8, marginTop: spacing.lg },
  emptyIcon:  { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginTop: 4 },
  emptyText:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },

  // Business owner CTA
  bizCta: { marginHorizontal: spacing.md, marginTop: spacing.xl },
  bizCtaBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingVertical: 14, borderRadius: radius.lg,
    backgroundColor: S.light, borderWidth: 1.5,
  },
  bizCtaText: { fontSize: fontSize.sm, fontWeight: '800' },
  bizCtaPrompt: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 14, borderWidth: 1, borderColor: colors.border,
  },
  bizCtaIcon: { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  bizCtaPromptTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  bizCtaPromptSub:   { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1 },
});
