/**
 * local-loyalty-hub.tsx — "Shop Local Shetland": the island-wide loyalty hub.
 * App mirror of the web /loyalty page. Reached from the Local feed, framed as
 * Local's flagship rewards showcase (parent + flagship child), not a peer tab.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Image, RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import {
  fetchActiveOffers, fetchLoyaltyBusinesses,
  formatOfferDiscount, CATEGORY_ICONS,
  type LocalOffer, type LoyaltyHubBusiness,
} from '@/lib/local-api';
import { isBookableLive } from '@/lib/book-api';

const S = SECTIONS.local;

/** Plain-English summary of what a loyalty card earns. */
function rewardLine(p: LoyaltyHubBusiness['program']): string {
  if (p.type === 'points') {
    const per = p.points_for_pound ?? 100;
    const rate = p.points_per_pound ?? 1;
    return `Earn ${rate} point${rate === 1 ? '' : 's'} per £1 · ${per} points = £1 off`;
  }
  const n = p.stamps_required ?? 10;
  const reward = p.stamp_reward?.trim();
  return reward ? `Collect ${n} stamps → ${reward}` : `Collect ${n} stamps for a reward`;
}

/** Best-effort Shetland locality from a free-text address. */
function localityOf(address: string | null): string | null {
  if (!address) return null;
  const drop = /^(uk|u\.k\.|united kingdom|great britain|gb|scotland|shetland|shetland islands|ze\d?\s*\d?[a-z]{0,2})$/i;
  const parts = address.split(',').map(s => s.trim()).filter(s => s && !drop.test(s));
  return parts.length ? parts[parts.length - 1] : null;
}

const HOW = [
  { icon: 'mobile-alt', title: 'Show your phone', body: 'Open OneShetland at the till — no card to forget or lose.' },
  { icon: 'star',       title: 'Collect as you spend', body: 'A tap adds a stamp or points at any taking-part shop.' },
  { icon: 'gift',       title: 'Redeem in seconds', body: 'Staff scan your code and your reward is applied on the spot.' },
] as const;

export default function LoyaltyHubScreen() {
  const router = useRouter();
  const { screenWidth } = useAppLayout();
  const [offers, setOffers] = useState<LocalOffer[]>([]);
  const [businesses, setBusinesses] = useState<LoyaltyHubBusiness[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [o, b] = await Promise.all([fetchActiveOffers(), fetchLoyaltyBusinesses()]);
      setOffers(o);
      setBusinesses(b);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const areas = new Set(
    businesses.map(b => localityOf(b.business.address)).filter(Boolean) as string[],
  );
  const stats: { n: number | string; label: string }[] = [
    { n: businesses.length, label: businesses.length === 1 ? 'business\nrewarding you' : 'businesses\nrewarding you' },
    { n: offers.length, label: offers.length === 1 ? 'live deal' : 'live deals' },
    { n: areas.size || '—', label: 'corners of\nShetland' },
  ];

  return (
    <ScreenScaffold
      header={<ScreenHeader title="Shop Local Shetland" accent={S.color} onBack={() => router.back()} />}
    >
      {loading ? (
        <LoadingState accent={S.color} />
      ) : (
        <ScrollView
          contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
        >
          {/* Hero */}
          <View style={[styles.hero, { backgroundColor: S.color }]}>
            <Text style={styles.heroKicker}>SHOP LOCAL SHETLAND</Text>
            <Text style={styles.heroTitle}>One card for every shop in Shetland</Text>
            <Text style={styles.heroBody}>
              Collect stamps, earn points and unlock deals at Shetland businesses — all in
              one place, no wallet full of paper cards.
            </Text>
            <View style={styles.statRow}>
              {stats.map(s => (
                <View key={s.label} style={styles.statBox}>
                  <Text style={styles.statNum}>{s.n}</Text>
                  <Text style={styles.statLabel}>{s.label}</Text>
                </View>
              ))}
            </View>
          </View>

          {/* How it works */}
          <View style={styles.howWrap}>
            {HOW.map(h => (
              <View key={h.title} style={styles.howCard}>
                <View style={[styles.howIcon, { backgroundColor: S.light }]}>
                  <FontAwesome5 name={h.icon} size={14} color={S.color} solid />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.howTitle}>{h.title}</Text>
                  <Text style={styles.howBody}>{h.body}</Text>
                </View>
              </View>
            ))}
          </View>

          {/* Live deals */}
          {offers.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Live deals across Shetland</Text>
              {offers.map(o => (
                <TouchableOpacity
                  key={o.id}
                  style={styles.dealCard}
                  activeOpacity={0.85}
                  onPress={() => {
                    if (o.business && isBookableLive(o.business)) {
                      router.push({ pathname: '/local-book-business', params: { businessId: o.business_id } });
                    } else {
                      router.push({ pathname: '/local-business-detail', params: { id: o.business_id } });
                    }
                  }}
                >
                  <View style={[styles.discount, { backgroundColor: S.color }]}>
                    <Text style={styles.discountText}>{formatOfferDiscount(o)}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.dealTitle} numberOfLines={1}>{o.title}</Text>
                    {o.business && <Text style={styles.dealBiz}>{o.business.name}</Text>}
                  </View>
                  <FontAwesome5 name="chevron-right" size={11} color={colors.textLight} />
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Businesses running loyalty */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Places that reward your loyalty</Text>
            {businesses.length === 0 ? (
              <Text style={styles.empty}>
                The first Shetland loyalty cards are coming soon. Check back shortly.
              </Text>
            ) : (
              businesses.map(({ business, program }) => {
                const locality = localityOf(business.address);
                return (
                  <TouchableOpacity
                    key={business.id}
                    style={styles.bizCard}
                    activeOpacity={0.85}
                    onPress={() => router.push({ pathname: '/local-business-detail', params: { id: business.id } })}
                  >
                    <View style={[styles.bizLogo, { backgroundColor: (business.brand_color ?? S.color) + '1A' }]}>
                      {business.logo_url ? (
                        <Image source={{ uri: business.logo_url }} style={styles.bizLogoImg} />
                      ) : (
                        <FontAwesome5 name={CATEGORY_ICONS[business.category] ?? 'store'} size={15} color={business.brand_color ?? S.color} />
                      )}
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={styles.bizTitleRow}>
                        <Text style={styles.bizName} numberOfLines={1}>{business.name}</Text>
                        <View style={[styles.typePill, { backgroundColor: S.light }]}>
                          <Text style={[styles.typePillText, { color: S.color }]}>
                            {program.type === 'points' ? 'Points' : 'Stamps'}
                          </Text>
                        </View>
                      </View>
                      <Text style={styles.bizReward}>{rewardLine(program)}</Text>
                      {locality && <Text style={styles.bizLocality}>{locality}</Text>}
                    </View>
                  </TouchableOpacity>
                );
              })
            )}
          </View>

          {/* My cards shortcut */}
          <TouchableOpacity
            style={styles.myCardsBtn}
            activeOpacity={0.85}
            onPress={() => router.push('/local-my-cards')}
          >
            <FontAwesome5 name="id-card" size={13} color={S.color} solid />
            <Text style={[styles.myCardsText, { color: S.color }]}>My loyalty cards</Text>
            <FontAwesome5 name="chevron-right" size={11} color={S.color} />
          </TouchableOpacity>
        </ScrollView>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: 100 },

  hero: { borderRadius: radius.lg, padding: 20 },
  heroKicker: { color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  heroTitle: { color: '#fff', fontSize: 24, fontWeight: '900', marginTop: 8, lineHeight: 29 },
  heroBody: { color: 'rgba(255,255,255,0.92)', fontSize: fontSize.sm, marginTop: 8, lineHeight: 20 },
  statRow: { flexDirection: 'row', gap: 8, marginTop: 18 },
  statBox: { flex: 1, backgroundColor: 'rgba(255,255,255,0.15)', borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' },
  statNum: { color: '#fff', fontSize: 24, fontWeight: '900' },
  statLabel: { color: 'rgba(255,255,255,0.88)', fontSize: 10, fontWeight: '700', textAlign: 'center', marginTop: 2, lineHeight: 13 },

  howWrap: { gap: 8 },
  howCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, padding: 12, borderWidth: 1, borderColor: colors.border },
  howIcon: { width: 38, height: 38, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  howTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  howBody: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 1, lineHeight: 16 },

  section: { gap: 10 },
  sectionTitle: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },

  dealCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, padding: 12, borderWidth: 1, borderColor: colors.border },
  discount: { paddingHorizontal: 10, paddingVertical: 12, borderRadius: radius.md, minWidth: 70, alignItems: 'center', justifyContent: 'center' },
  discountText: { color: '#fff', fontSize: 11, fontWeight: '900', textAlign: 'center' },
  dealTitle: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  dealBiz: { fontSize: fontSize.xs, color: S.color, fontWeight: '700', marginTop: 1 },

  bizCard: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg, padding: 12, borderWidth: 1, borderColor: colors.border },
  bizLogo: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  bizLogoImg: { width: 44, height: 44 },
  bizTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bizName: { flex: 1, fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  typePill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.full },
  typePillText: { fontSize: 9, fontWeight: '900', textTransform: 'uppercase', letterSpacing: 0.5 },
  bizReward: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 3, lineHeight: 16 },
  bizLocality: { fontSize: 10, color: colors.textLight, fontWeight: '700', marginTop: 3 },

  empty: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', paddingVertical: 24, backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 16 },

  myCardsBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: S.light, borderRadius: radius.lg, paddingVertical: 14 },
  myCardsText: { fontSize: fontSize.sm, fontWeight: '800' },
});
