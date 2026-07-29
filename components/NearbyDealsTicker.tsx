/**
 * NearbyDealsTicker
 *
 * A slim, classy ticker for the home feed — sits between the search bar and the
 * Shetland Today card. It cycles through the nearest live offers ("20% off · Da
 * Peerie Café · 0.3 mi") and, when tapped, opens a bottom-sheet drawer listing
 * every nearby deal, sorted nearest-first.
 *
 * Location: uses the device location if the user has already granted it (silently,
 * no prompt on load); otherwise falls back to Lerwick so town testers still get a
 * useful list. The drawer offers a "Use my location" button to switch to precise
 * distances. Renders nothing at all when there are no placeable offers, so the
 * home never shows an empty ticker.
 *
 *   <NearbyDealsTicker style={{ marginHorizontal: 16 }} />
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, ScrollView, Image,
  Animated, ActivityIndicator, StyleProp, ViewStyle, Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { colors, spacing, radius, fontSize } from '@/constants/theme';
import { LERWICK_COORDS } from '@/lib/shetland-today';
import { fetchNearbyOffers, formatOfferDiscount, distanceKm, type NearbyOffer } from '@/lib/local-api';

// Soft-load expo-location so a missing dep just means "no precise location".
let Location: any = null;
try { Location = require('expo-location'); } catch { Location = null; }

const PURPLE = colors.services;          // Local / directory identity
const PURPLE_TINT = colors.servicesLight;
const ONE_MILE_KM = 1.609344;
// If the device location is further than this from Lerwick, it isn't in Shetland
// (Unst/Fair Isle/Foula are all within ~65 km) — ignore it and use Lerwick, so an
// off-island user doesn't see every deal as hundreds of miles away.
const SHETLAND_RADIUS_KM = 150;

function miles(km: number): string {
  const mi = km / ONE_MILE_KM;
  if (mi < 0.1) return 'here';
  if (mi < 10) return `${mi.toFixed(1)} mi`;
  return `${Math.round(mi)} mi`;
}

export function NearbyDealsTicker({ style, variant = 'light' }: { style?: StyleProp<ViewStyle>; variant?: 'light' | 'onDark' }) {
  const dark = variant === 'onDark';       // sits on the navy header vs the light content card
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [offers, setOffers] = useState<NearbyOffer[] | null>(null);
  const [precise, setPrecise] = useState(false);       // true once we use the real device location
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const fade = useRef(new Animated.Value(1)).current;

  // Resolve coordinates: real location only if already granted; else Lerwick.
  const resolveCoords = useCallback(async (): Promise<{ coords: { lat: number; lng: number }; precise: boolean }> => {
    try {
      if (Location?.getForegroundPermissionsAsync) {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm?.status === 'granted') {
          const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy?.Low ?? 3 })
            .catch(() => Location.getLastKnownPositionAsync?.());
          const c = pos?.coords;
          if (c && typeof c.latitude === 'number') {
            const inShetland = distanceKm(c.latitude, c.longitude, LERWICK_COORDS.lat, LERWICK_COORDS.lng) <= SHETLAND_RADIUS_KM;
            if (inShetland) return { coords: { lat: c.latitude, lng: c.longitude }, precise: true };
            // Off-island: keep the real fix out of the results, fall back to Lerwick.
          }
        }
      }
    } catch { /* fall through to Lerwick */ }
    return { coords: LERWICK_COORDS, precise: false };
  }, []);

  const load = useCallback(async () => {
    const { coords, precise: p } = await resolveCoords();
    setPrecise(p);
    try { setOffers(await fetchNearbyOffers(coords)); } catch { setOffers([]); }
  }, [resolveCoords]);

  useEffect(() => { load(); }, [load]);

  // Cycle the ticker line every few seconds (paused while the drawer is open).
  useEffect(() => {
    if (open || !precise || !offers || offers.length < 2) return;
    const t = setInterval(() => {
      Animated.timing(fade, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => {
        setIdx((i) => (i + 1) % offers.length);
        Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: true }).start();
      });
    }, 3400);
    return () => clearInterval(t);
  }, [open, precise, offers, fade]);

  // Ask for precise location, reload, and report whether we ended up precise.
  const enablePrecise = useCallback(async (): Promise<boolean> => {
    if (!Location?.requestForegroundPermissionsAsync) return false;
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm?.status === 'granted') {
        setOffers(null);
        const { coords, precise: p } = await resolveCoords();
        setPrecise(p);
        try { setOffers(await fetchNearbyOffers(coords)); } catch { setOffers([]); }
        return p;
      }
    } catch { /* ignore */ }
    return false;
  }, [resolveCoords]);

  // Tapping the ticker: if location's already on, open the drawer; otherwise ask
  // for it first (which activates the live distances), then open the drawer.
  const onBarPress = useCallback(async () => {
    if (!precise) await enablePrecise();
    setOpen(true);
  }, [precise, enablePrecise]);

  const goToOffer = useCallback((o: NearbyOffer) => {
    setOpen(false);
    router.push({ pathname: '/local-business-detail', params: { id: o.business_id } });
  }, [router]);

  // Nothing placeable nearby → render nothing (no empty ticker on the home).
  if (offers !== null && offers.length === 0) return null;

  const cur = offers && offers.length ? offers[idx % offers.length] : null;
  const within1mi = offers ? offers.filter((o) => o.distance_km <= ONE_MILE_KM).length : 0;

  return (
    <View style={style}>
      {/* ── The ticker ─────────────────────────────────────────────── */}
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onBarPress}
        style={[styles.bar, dark && styles.barDark]}
        accessibilityRole="button"
        accessibilityLabel={precise ? `Deals near you, ${offers?.length} nearby. Tap to see them.` : 'See deals near you. Tap to turn on location.'}
      >
        {dark
          ? <FontAwesome5 name={precise ? 'map-marker-alt' : 'location-arrow'} size={11} color="#CBB8F7" solid style={{ marginRight: 2 }} />
          : <View style={styles.pin}><FontAwesome5 name={precise ? 'map-marker-alt' : 'location-arrow'} size={13} color={PURPLE} solid /></View>}
        {offers === null ? (
          <Text style={[styles.loadingTxt, dark && { color: 'rgba(255,255,255,0.8)' }]}>Finding deals near you…</Text>
        ) : !precise ? (
          // Dormant until they allow location — a clear, tappable call to action.
          <View style={styles.tickerLine}>
            <Text style={[styles.promptTxt, dark && { color: '#FFFFFF' }]} numberOfLines={1}>See deals near you</Text>
            <View style={[styles.enableChip, dark && styles.enableChipDark]}>
              <FontAwesome5 name="location-arrow" size={10} color={dark ? '#FFFFFF' : PURPLE} solid />
              <Text style={[styles.enableChipTxt, dark && { color: '#FFFFFF' }]}>Turn on location</Text>
            </View>
          </View>
        ) : cur ? (
          <Animated.View style={[styles.tickerLine, { opacity: fade }]}>
            <Text style={styles.tickerLabel} numberOfLines={1}>
              <Text style={[styles.discount, dark && { color: '#CBB8F7' }]}>{formatOfferDiscount(cur)}</Text>
              <Text style={[styles.dot, dark && { color: 'rgba(255,255,255,0.4)' }]}>  ·  </Text>
              <Text style={[styles.bizName, dark && { color: '#FFFFFF' }]}>{cur.business?.name}</Text>
            </Text>
            <Text style={[styles.dist, dark && { color: 'rgba(255,255,255,0.75)' }]}>{miles(cur.distance_km)}</Text>
          </Animated.View>
        ) : null}
        {precise ? (
          <FontAwesome5 name="chevron-right" size={12} color={dark ? 'rgba(255,255,255,0.6)' : colors.textLight} style={{ marginLeft: spacing.xs }} />
        ) : null}
      </TouchableOpacity>

      {/* ── The drawer ─────────────────────────────────────────────── */}
      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}>
          <View style={styles.grabber} />
          <View style={styles.sheetHead}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sheetTitle}>Deals near you</Text>
              <Text style={styles.sheetSub}>
                {precise ? 'Nearest to you' : 'Nearest to Lerwick'}
                {within1mi > 0 ? ` · ${within1mi} within a mile` : ''}
              </Text>
            </View>
            <TouchableOpacity onPress={() => setOpen(false)} hitSlop={10} style={styles.closeBtn}>
              <FontAwesome5 name="times" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          </View>

          {!precise && Location?.requestForegroundPermissionsAsync ? (
            <TouchableOpacity onPress={enablePrecise} style={styles.useLoc} activeOpacity={0.85}>
              <FontAwesome5 name="location-arrow" size={12} color={PURPLE} solid />
              <Text style={styles.useLocTxt}>Use my location for exact distances</Text>
            </TouchableOpacity>
          ) : null}

          <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ paddingBottom: spacing.sm }} showsVerticalScrollIndicator={false}>
            {(offers ?? []).map((o) => {
              const near = o.distance_km <= ONE_MILE_KM;
              return (
                <TouchableOpacity key={o.id} style={styles.row} activeOpacity={0.8} onPress={() => goToOffer(o)}>
                  <View style={styles.logoWrap}>
                    {o.business?.logo_url
                      ? <Image source={{ uri: o.business.logo_url }} style={styles.logo} />
                      : <FontAwesome5 name="tag" size={16} color={PURPLE} solid />}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle} numberOfLines={1}>{formatOfferDiscount(o)} · {o.title}</Text>
                    <Text style={styles.rowBiz} numberOfLines={1}>{o.business?.name}</Text>
                  </View>
                  <View style={[styles.distChip, near && styles.distChipNear]}>
                    <Text style={[styles.distChipTxt, near && styles.distChipTxtNear]}>{miles(o.distance_km)}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <TouchableOpacity style={styles.seeAll} activeOpacity={0.85} onPress={() => { setOpen(false); router.push('/local-offers'); }}>
            <Text style={styles.seeAllTxt}>See all offers across Shetland</Text>
            <FontAwesome5 name="arrow-right" size={12} color={PURPLE} />
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: PURPLE_TINT, borderRadius: radius.full,
    borderWidth: 1, borderColor: 'rgba(107,71,191,0.18)',
    paddingVertical: 10, paddingHorizontal: spacing.md,
  },
  // On the navy header: no pill — just a slim line of text sitting under the
  // header's bottom edge, set off by a faint hairline divider.
  barDark: {
    backgroundColor: 'transparent',
    borderRadius: 0,
    borderWidth: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.14)',
    paddingVertical: 7,
    paddingHorizontal: 2,
    gap: 6,
  },
  pin: {
    width: 26, height: 26, borderRadius: 13, backgroundColor: colors.white,
    alignItems: 'center', justifyContent: 'center',
  },
  loadingTxt: { flex: 1, color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '600' },
  tickerLine: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  tickerLabel: { flex: 1, fontSize: fontSize.sm },
  discount: { color: PURPLE, fontWeight: '800' },
  dot: { color: colors.textLight },
  bizName: { color: colors.textPrimary, fontWeight: '600' },
  dist: { color: colors.textMuted, fontSize: fontSize.xs, fontWeight: '700' },
  promptTxt: { flex: 1, color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '600' },
  enableChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: PURPLE_TINT, borderRadius: radius.full,
    paddingHorizontal: 9, paddingVertical: 4,
  },
  enableChipDark: { backgroundColor: 'rgba(255,255,255,0.16)' },
  enableChipTxt: { color: PURPLE, fontSize: fontSize.xs, fontWeight: '800' },

  backdrop: { flex: 1, backgroundColor: 'rgba(6,36,58,0.5)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: colors.white, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: spacing.lg, paddingTop: spacing.sm,
  },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.border, marginBottom: spacing.md },
  sheetHead: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: spacing.sm },
  sheetTitle: { fontSize: fontSize.xl, fontWeight: '800', color: colors.textPrimary },
  sheetSub: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2 },
  closeBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.offWhite, alignItems: 'center', justifyContent: 'center' },

  useLoc: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs, alignSelf: 'flex-start',
    backgroundColor: PURPLE_TINT, borderRadius: radius.full,
    paddingVertical: 7, paddingHorizontal: spacing.md, marginBottom: spacing.sm,
  },
  useLocTxt: { color: PURPLE, fontWeight: '700', fontSize: fontSize.sm },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  logoWrap: {
    width: 44, height: 44, borderRadius: 12, backgroundColor: PURPLE_TINT,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  logo: { width: 44, height: 44 },
  rowTitle: { fontSize: fontSize.md, fontWeight: '700', color: colors.textPrimary },
  rowBiz: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 1 },
  distChip: { backgroundColor: colors.offWhite, borderRadius: radius.full, paddingVertical: 4, paddingHorizontal: 10 },
  distChipNear: { backgroundColor: PURPLE_TINT },
  distChipTxt: { fontSize: fontSize.xs, fontWeight: '800', color: colors.textMuted },
  distChipTxtNear: { color: PURPLE },

  seeAll: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    marginTop: spacing.md, paddingVertical: spacing.sm,
  },
  seeAllTxt: { color: PURPLE, fontWeight: '800', fontSize: fontSize.md },
});
