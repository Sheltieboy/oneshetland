/**
 * LocalScreen — the app's Local tab (app/(tabs)/local.tsx).
 *
 * Local is Shetland's local economy: six permanent gateways (Shop · Offers · Book · Experiences · Businesses · Rewards),
 * Featured locally, the commerce sections, Work (jobs & shifts) and a call to businesses. Everything is real data. Low
 * inventory changes how a section is treated (a proposition panel, a feature, a rail), never whether the proposition
 * is on the screen.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, Image, Pressable, StyleSheet, RefreshControl } from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import DisplayText from '@/components/DisplayText';
import { useAuth } from '@/context/AuthContext';
import { useAppLayout } from '@/hooks/useAppLayout';
import { fetchMyLoyaltyCards, type LoyaltyCard, type LocalBusiness } from '@/lib/local-api';
import { CropImage, Scrim, MerchCard, Rail, SectionHead, PillarTile, Chip, PillarSection, SIDE } from './ui';
import { LocalWork } from './WorkModule';
import { buildWork } from './work';
import { loadHomeLocalData, loadBusinesses, type HomeLocalData } from './data';
import { PILLARS, PILLAR_ORDER, PILLAR_ROUTE, PILLAR_CTA_ROUTE, emptyCommerce, type Merch, type Pillar } from './model';

const CAT_COLOR: Record<string, string> = { food_drink: '#C2410C', retail: '#7C3AED', services: '#0E7490', accommodation: '#15803D' };
const CAT_LABEL: Record<string, string> = { food_drink: 'Food & drink', retail: 'Retail', services: 'Services', accommodation: 'Stay' };
const AREAS = ['All Shetland', 'Lerwick', 'Scalloway', 'Brae', 'Northmavine', 'South Mainland', 'West Mainland', 'Yell', 'Unst', 'Fetlar', 'Whalsay', 'Skerries'];

export default function LocalScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { profile } = useAuth();
  const { contentWidth } = useAppLayout();
  const width = contentWidth;
  const [data, setData] = useState<HomeLocalData | null>(null);
  const [area, setArea] = useState('All Shetland');
  const [areaBiz, setAreaBiz] = useState<LocalBusiness[] | null>(null);   // null = use the all-Shetland list
  const [card, setCard] = useState<LoyaltyCard | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const parish = (profile as { parish?: string | null } | null)?.parish ?? null;
    const tasks: Promise<unknown>[] = [loadHomeLocalData(parish).then(setData)];
    if (profile?.id) tasks.push(fetchMyLoyaltyCards(profile.id).then((cs) => setCard(cs.find((c) => c.program?.type === 'stamps' && (c.program?.stamps_required ?? 0) > 0) ?? null)).catch(() => setCard(null)));
    else setCard(null);
    await Promise.all(tasks);
  }, [profile?.id]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  // The area chips filter Featured locally (matched on address, as the existing Local feed does).
  useEffect(() => {
    if (area === 'All Shetland') { setAreaBiz(null); return; }
    let alive = true;
    void loadBusinesses(area, 9).then((b) => { if (alive) setAreaBiz(b); });
    return () => { alive = false; };
  }, [area]);

  const commerce = data?.commerce ?? emptyCommerce();
  const gw = (width - SIDE * 2 - 12) / 2;
  const biz = areaBiz ?? data?.businesses ?? [];
  const lead = biz.find((b) => b.logo_url || b.cover_url) ?? biz[0];
  const others = biz.filter((b) => b.id !== lead?.id);
  // The Rewards card shows the person's own first stamp card; with none it is an invitation to explore rewards.
  const needed = Math.min(12, card?.program?.stamps_required ?? 8);
  const collected = Math.min(needed, card?.stamps_collected ?? 0);
  const cardLine = needed - collected > 0 ? `${needed - collected} more ${needed - collected === 1 ? 'stamp' : 'stamps'} for your reward` : 'Card full — show it to redeem your reward';
  const openBusiness = (id: string) => router.push({ pathname: '/local-business-detail', params: { id } } as never);
  const chipFor = (p: Pillar) => { const n = commerce[p].length; return n === 0 ? 'Opening soon' : `${n} ${n === 1 ? 'item' : 'items'}`; };
  const featured: Merch[] = [commerce.offers[0], commerce.shop[0], commerce.experiences[0], commerce.book[0]].filter(Boolean) as Merch[];

  const BizTile = ({ b, w = 150, h = 190 }: { b: (typeof biz)[number]; w?: number; h?: number }) => {
    const c = CAT_COLOR[b.category] ?? '#4F46E5';
    return (
      <Pressable onPress={() => openBusiness(b.id)} style={{ width: w, height: h, borderRadius: 22, overflow: 'hidden', backgroundColor: c, padding: 14, justifyContent: 'space-between' }}>
        <Scrim dir="diag" stops={[{ at: 0, color: c, opacity: 1 }, { at: 1, color: '#1E1B4B', opacity: 1 }]} />
        <View style={s.logoTile}>{b.logo_url ? <Image source={{ uri: b.logo_url }} style={{ width: 42, height: 42 }} resizeMode="contain" /> : <Text style={{ fontSize: 20, fontWeight: '900' }}>{b.name[0]}</Text>}</View>
        <View>
          <Text style={{ color: 'rgba(255,255,255,0.78)', fontSize: 9.5, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' }}>{CAT_LABEL[b.category] ?? 'Business'}</Text>
          <DisplayText weight="bold" numberOfLines={2} style={{ color: '#fff', fontSize: 18, lineHeight: 20, marginTop: 2 }}>{b.name}</DisplayText>
        </View>
      </Pressable>
    );
  };

  const now = useMemo(() => new Date(), [data]);
  const work = useMemo(() => buildWork({ jobs: data?.jobs ?? [], shifts: data?.shifts ?? [] }, now), [data, now]);

  return (
    <View style={{ flex: 1, backgroundColor: '#FBF8F2' }}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 60 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#7C3AED" />}>
        {/* Hero — compact: the title, one line, the search ──────────────────────────────── */}
        <View style={{ paddingHorizontal: SIDE, paddingTop: insets.top + 10, paddingBottom: 14, overflow: 'hidden' }}>
          <CropImage photo="street" crop={{ cx: 0.5, cy: 0.4, z: 1.05 }} style={StyleSheet.absoluteFill} />
          <Scrim dir="diag" stops={[{ at: 0, color: '#2E1065', opacity: 0.95 }, { at: 0.55, color: '#4C1D95', opacity: 0.82 }, { at: 1, color: '#7C3AED', opacity: 0.4 }]} />
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
            <DisplayText style={{ color: '#fff', fontSize: 34, lineHeight: 38 }}>Local</DisplayText>
            <Text numberOfLines={1} style={{ color: 'rgba(255,255,255,0.9)', fontSize: 13.5, flex: 1 }}>Shop, save, book and discover.</Text>
          </View>
          <Pressable onPress={() => router.push('/search')} style={s.search} accessibilityLabel="Search"><FontAwesome5 name="search" size={13} color="#6B7280" /><Text numberOfLines={1} style={{ color: '#6B7280', fontSize: 14, marginLeft: 8 }}>Search shops, cafés, services…</Text></Pressable>
        </View>

        {/* The gateway: six permanent entry points (2 × 3), compact ─────────────────────── */}
        <View style={{ paddingHorizontal: SIDE, paddingTop: 14, flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <PillarTile label="Shop" sub={chipFor('shop')} icon="shopping-bag" photo="shopping" crop={{ cx: 0.35, cy: 0.45, z: 1.2 }} from="#7C3AED" to="#3B0764" w={gw} onPress={() => router.push('/shop' as never)} />
          <PillarTile label="Offers" sub={chipFor('offers')} icon="tags" from="#D97706" to="#92400E" w={gw} onPress={() => router.push('/local-offers' as never)} />
          <PillarTile label="Book" sub={chipFor('book')} icon="calendar-check" photo="cafe" crop={{ cx: 0.5, cy: 0.4, z: 1.1 }} from="#059669" to="#064E3B" w={gw} onPress={() => router.push('/local-bookable-browse' as never)} />
          <PillarTile label="Experiences" sub={chipFor('experiences')} icon="ticket-alt" photo="scatness" crop={{ cx: 0.5, cy: 0.5, z: 1.1 }} from="#0E7490" to="#164E63" w={gw} onPress={() => router.push(PILLAR_ROUTE.experiences as never)} />
          <PillarTile label="Businesses" sub="Directory" icon="store" from="#4F46E5" to="#1E1B4B" w={gw} onPress={() => router.navigate('/(tabs)/services' as never)} />
          <PillarTile label="Rewards" sub="Stamps & points" icon="gift" from="#A855F7" to="#4C1D95" w={gw} onPress={() => router.push('/local-loyalty-hub' as never)} />
        </View>

        {/* Area chips ─────────────────────────────────────────────────────────────── */}
        <View style={{ marginTop: 14 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: SIDE, gap: 8 }}>
            {AREAS.map((a) => (
              <Text key={a} onPress={() => setArea(a)} style={[s.areaChip, area === a && { backgroundColor: '#5B21B6', color: '#fff', borderColor: '#5B21B6' }]}>{a}</Text>
            ))}
          </ScrollView>
        </View>

        {/* Featured locally ─────────────────────────────────────────────────────────── */}
        {lead ? (
          <View style={{ marginTop: 22 }}>
            <SectionHead eyebrow="Featured locally" title="Handpicked from across the isles" color="#7C3AED" action="Browse directory" onAction={() => router.navigate('/(tabs)/services' as never)} />
            <Rail>
              <Pressable onPress={() => openBusiness(lead.id)} style={{ width: 270, height: 330, borderRadius: 24, overflow: 'hidden', backgroundColor: CAT_COLOR[lead.category] ?? '#4F46E5' }}>
                <CropImage uri={lead.cover_url ?? undefined} photo={lead.cover_url ? undefined : 'street'} crop={{ cx: 0.5, cy: 0.4, z: 1.2 }} style={StyleSheet.absoluteFill} />
                <Scrim dir="up" stops={[{ at: 0, color: CAT_COLOR[lead.category] ?? '#4F46E5', opacity: 0.97 }, { at: 0.45, color: CAT_COLOR[lead.category] ?? '#4F46E5', opacity: 0.75 }, { at: 1, color: CAT_COLOR[lead.category] ?? '#4F46E5', opacity: 0 }]} />
                <View style={{ position: 'absolute', left: 16, right: 16, bottom: 16 }}>
                  <View style={[s.logoTile, { width: 56, height: 56 }]}>{lead.logo_url ? <Image source={{ uri: lead.logo_url }} style={{ width: 48, height: 48 }} resizeMode="contain" /> : <Text style={{ fontSize: 24, fontWeight: '900' }}>{lead.name[0]}</Text>}</View>
                  <Chip label={CAT_LABEL[lead.category] ?? 'Business'} />
                  <DisplayText weight="bold" style={{ color: '#fff', fontSize: 28, lineHeight: 30, marginTop: 8 }}>{lead.name}</DisplayText>
                </View>
              </Pressable>
              {featured.map((m) => <MerchCard key={m.id} m={m} />)}
              {others.slice(0, 2).map((b) => <BizTile key={b.id} b={b} />)}
            </Rail>
          </View>
        ) : (
          <View style={{ marginTop: 22, paddingHorizontal: SIDE }}>
            <Pressable onPress={() => router.navigate('/(tabs)/services' as never)} style={{ backgroundColor: '#fff', borderRadius: 20, padding: 16 }}>
              <Text style={{ color: '#7C3AED', fontSize: 11, fontWeight: '800', letterSpacing: 1.2 }}>FEATURED LOCALLY</Text>
              <DisplayText weight="bold" style={{ color: '#0F1C26', fontSize: 22, lineHeight: 25, marginTop: 3 }}>{area === 'All Shetland' ? 'Shetland businesses, in one place' : `Nothing featured in ${area} yet`}</DisplayText>
              <Text style={{ color: '#7C3AED', fontWeight: '800', fontSize: 13, marginTop: 8 }}>Browse the directory →</Text>
            </Pressable>
          </View>
        )}

        {/* The four commerce pillars, banded for rhythm ────────────────────────────── */}
        <View style={{ marginTop: 28, paddingVertical: 26, backgroundColor: '#FBF8F2' }}><PillarSection pillar="shop" items={commerce.shop} width={width} /></View>
        <View style={{ paddingVertical: 26, backgroundColor: '#FFF3E0' }}><PillarSection pillar="offers" items={commerce.offers} width={width} notch="#FFF3E0" /></View>
        <View style={{ paddingVertical: 26, backgroundColor: '#E8F7EF' }}><PillarSection pillar="book" items={commerce.book} width={width} /></View>
        <View style={{ paddingVertical: 26, backgroundColor: '#0B3A46' }}><PillarSection pillar="experiences" items={commerce.experiences} width={width} dark /></View>

        {/* Rewards — integrated, not a banner ───────────────────────────────────────── */}
        <View style={{ backgroundColor: '#4C1D95', paddingTop: 26, paddingBottom: 30 }}>
          <SectionHead eyebrow="Local rewards" title="One card for every shop in Shetland" light />
          <View style={{ paddingHorizontal: SIDE, flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {[['1', 'Shop locally', 'In person or online'], ['2', 'Collect stamps', 'Fill a card at every shop'], ['3', 'Earn points', 'Across the isles'], ['4', 'Spend with Wallet', 'Watch your savings grow']].map(([n, t, d]) => (
              <View key={n} style={{ width: gw, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 16, padding: 12 }}>
                <DisplayText style={{ color: '#FDE68A', fontSize: 22 }}>{n}</DisplayText>
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '800', marginTop: 2 }}>{t}</Text>
                <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: 11.5, marginTop: 2 }}>{d}</Text>
              </View>
            ))}
          </View>
          {card ? (
            <Pressable onPress={() => router.push('/local-my-cards' as never)} style={{ marginHorizontal: SIDE, marginTop: 16, backgroundColor: '#fff', borderRadius: 22, padding: 16, transform: [{ rotate: '-1.5deg' }] }} accessibilityLabel={`Your ${card.business?.name ?? ''} stamp card, ${collected} of ${needed}`}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <DisplayText weight="bold" numberOfLines={1} style={{ color: '#2E1065', fontSize: 19, flex: 1, marginRight: 8 }}>{card.business?.name ?? 'Your stamp card'}</DisplayText>
                <View style={{ backgroundColor: '#EDE9FE', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 3 }}><Text style={{ color: '#5B21B6', fontSize: 11, fontWeight: '900' }}>{collected} of {needed}</Text></View>
              </View>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                {Array.from({ length: needed }, (_, i) => <View key={i} style={[s.bigStamp, i < collected ? { backgroundColor: '#7C3AED' } : { borderWidth: 2, borderStyle: 'dashed', borderColor: '#C4B5FD' }]}><Text style={{ color: i < collected ? '#fff' : '#C4B5FD', fontWeight: '900' }}>{i < collected ? '★' : i + 1}</Text></View>)}
              </View>
              <Text style={{ color: '#6D28D9', fontSize: 12.5, fontWeight: '700', marginTop: 12 }}>{cardLine}</Text>
            </Pressable>
          ) : (
            // No stamp card yet: an honest invitation, never an empty card that implies one has been started.
            <View style={{ marginHorizontal: SIDE, marginTop: 16, backgroundColor: '#fff', borderRadius: 22, padding: 18, transform: [{ rotate: '-1.5deg' }] }}>
              <DisplayText weight="bold" style={{ color: '#2E1065', fontSize: 22, lineHeight: 25 }}>Collect rewards locally</DisplayText>
              <Text style={{ color: '#4C1D95', fontSize: 14, lineHeight: 20, marginTop: 6 }}>Find participating businesses and start earning stamps and points.</Text>
              <Pressable onPress={() => router.push('/local-loyalty-hub' as never)} accessibilityRole="button" style={{ alignSelf: 'flex-start', backgroundColor: '#7C3AED', borderRadius: 99, paddingHorizontal: 18, paddingVertical: 10, marginTop: 14 }}>
                <Text style={{ color: '#fff', fontSize: 13.5, fontWeight: '800' }}>Explore rewards →</Text>
              </Pressable>
            </View>
          )}
        </View>

        {/* Work — jobs & shifts, supporting ───────────────────────────────────────────── */}
        <LocalWork work={work} now={now} />

        {/* For businesses ───────────────────────────────────────────────────────────── */}
        <View style={{ margin: SIDE, marginTop: 28, borderRadius: 24, overflow: 'hidden', padding: 20, backgroundColor: '#032F4C' }}>
          <Scrim dir="diag" stops={[{ at: 0, color: '#032F4C', opacity: 1 }, { at: 1, color: '#12667A', opacity: 1 }]} />
          <Text style={{ color: '#99F6E4', fontSize: 11, fontWeight: '800', letterSpacing: 1.2 }}>FOR BUSINESSES</Text>
          <DisplayText weight="bold" style={{ color: '#fff', fontSize: 27, lineHeight: 29, marginTop: 6 }}>Run a business in Shetland?</DisplayText>
          <DisplayText weight="bold" style={{ color: '#FDE68A', fontSize: 27, lineHeight: 29 }}>Put it on the island's map.</DisplayText>
          <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14, lineHeight: 20, marginTop: 8 }}>List it free. Sell products, post offers, take bookings and sell passes to everyone on the islands.</Text>
          <Pressable onPress={() => router.push(PILLAR_CTA_ROUTE as never)} style={{ alignSelf: 'flex-start', backgroundColor: '#fff', borderRadius: 99, paddingHorizontal: 18, paddingVertical: 10, marginTop: 14 }}><Text style={{ fontWeight: '800', fontSize: 13.5 }}>Add your business free →</Text></Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  search: { marginTop: 10, backgroundColor: '#fff', borderRadius: 99, paddingHorizontal: 13, height: 40, flexDirection: 'row', alignItems: 'center' },
  areaChip: { overflow: 'hidden', borderRadius: 99, borderWidth: 1, borderColor: '#CBD5E1', paddingHorizontal: 14, paddingVertical: 8, fontSize: 13, fontWeight: '700', color: '#374151', backgroundColor: '#fff' },
  logoTile: { width: 52, height: 52, borderRadius: 13, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  bigStamp: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
});
