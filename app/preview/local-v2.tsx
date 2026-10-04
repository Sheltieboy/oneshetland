/**
 * App Local V2 — DESIGN PREVIEW. Local only: not linked from the app, not in any shipped build, never published.
 * Open it in a development build at  /preview/local-v2?state=seed&as=public   (state: live|empty|seed|full, as: public|admin)
 *
 * Local is Shetland's local economy: six permanent gateways (Shop · Offers · Book · Experiences · Businesses · Rewards).
 * Low inventory changes how a rail is treated, never whether the proposition is on the screen.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, Image, StyleSheet, useWindowDimensions } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DisplayText } from '../../components/DisplayText';
import { CropImage, Scrim, fade, MerchCard, Rail, SectionHead, GatewayTile, Chip, PillarSection, SIDE } from '../../components/preview-v2/ui';
import { PreviewSwitch } from '../../components/preview-v2/PreviewSwitch';
import { loadPreviewData, type PreviewData } from '../../components/preview-v2/data';
import { buildCommerce, PILLARS, PILLAR_ORDER, type Merch, type Pillar, type PreviewState, type PreviewViewer } from '../../components/preview-v2/model';

const EMPTY_REAL: Record<Pillar, Merch[]> = { shop: [], offers: [], book: [], experiences: [] };
const CAT_COLOR: Record<string, string> = { food_drink: '#C2410C', retail: '#7C3AED', services: '#0E7490', accommodation: '#15803D' };
const CAT_LABEL: Record<string, string> = { food_drink: 'Food & drink', retail: 'Retail', services: 'Services', accommodation: 'Stay' };
const AREAS = ['All Shetland', 'Lerwick', 'Scalloway', 'Brae', 'Northmavine', 'South Mainland', 'West Mainland', 'Yell', 'Unst', 'Fetlar', 'Whalsay', 'Skerries'];
const parseState = (v?: string): PreviewState => (['live', 'empty', 'seed', 'full'] as const).find((x) => x === v) ?? 'seed';

export default function AppLocalV2() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const q = useLocalSearchParams<{ state?: string; as?: string }>();
  const state = parseState(q.state);
  const viewer: PreviewViewer = q.as === 'admin' ? 'admin' : 'public';
  const [data, setData] = useState<PreviewData | null>(null);
  const [area, setArea] = useState('All Shetland');
  useEffect(() => { void loadPreviewData().then(setData); }, []);
  const commerce = useMemo(() => buildCommerce(state, viewer, data?.real ?? EMPTY_REAL), [state, viewer, data]);

  const gw = (width - SIDE * 2 - 12) / 2;
  const biz = data?.businesses ?? [];
  const lead = biz.find((b) => b.logo_url || b.cover_url) ?? biz[0];
  const others = biz.filter((b) => b.id !== lead?.id);
  const chipFor = (p: Pillar) => { const n = commerce[p].length; return n === 0 ? 'Opening soon' : `${n} ${n === 1 ? 'item' : 'items'}`; };
  const featured: Merch[] = [commerce.offers[0], commerce.shop[0], commerce.experiences[0], commerce.book[0]].filter(Boolean) as Merch[];

  const BizTile = ({ b, w = 150, h = 190 }: { b: (typeof biz)[number]; w?: number; h?: number }) => {
    const c = CAT_COLOR[b.category] ?? '#4F46E5';
    return (
      <View style={{ width: w, height: h, borderRadius: 22, overflow: 'hidden', backgroundColor: c, padding: 14, justifyContent: 'space-between' }}>
        <Scrim dir="diag" stops={[{ at: 0, color: c, opacity: 1 }, { at: 1, color: '#1E1B4B', opacity: 1 }]} />
        <View style={s.logoTile}>{b.logo_url ? <Image source={{ uri: b.logo_url }} style={{ width: 42, height: 42 }} resizeMode="contain" /> : <Text style={{ fontSize: 20, fontWeight: '900' }}>{b.name[0]}</Text>}</View>
        <View>
          <Text style={{ color: 'rgba(255,255,255,0.78)', fontSize: 9.5, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' }}>{CAT_LABEL[b.category] ?? 'Business'}</Text>
          <DisplayText weight="bold" numberOfLines={2} style={{ color: '#fff', fontSize: 18, lineHeight: 20, marginTop: 2 }}>{b.name}</DisplayText>
        </View>
      </View>
    );
  };

  const jobs = data?.jobs ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: '#FBF8F2' }}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 60 }}>
        <View style={{ height: insets.top, backgroundColor: '#0F172A' }} />
        <PreviewSwitch route="local-v2" state={state} viewer={viewer} />

        {/* Hero ─────────────────────────────────────────────────────────────────── */}
        <View style={{ paddingHorizontal: SIDE, paddingTop: 22, paddingBottom: 22, overflow: 'hidden' }}>
          <CropImage photo="street" crop={{ cx: 0.5, cy: 0.4, z: 1.05 }} style={StyleSheet.absoluteFill} />
          <Scrim dir="diag" stops={[{ at: 0, color: '#2E1065', opacity: 0.95 }, { at: 0.55, color: '#4C1D95', opacity: 0.82 }, { at: 1, color: '#7C3AED', opacity: 0.4 }]} />
          <Text style={{ color: '#DDD6FE', fontSize: 11, fontWeight: '800', letterSpacing: 1.4 }}>ONESHETLAND · LOCAL</Text>
          <DisplayText style={{ color: '#fff', fontSize: 50, lineHeight: 50, marginTop: 6 }}>Local</DisplayText>
          <Text style={{ color: 'rgba(255,255,255,0.92)', fontSize: 16, lineHeight: 22, marginTop: 8, maxWidth: 320 }}>Shop, save, book and discover across Shetland.</Text>
          <View style={s.search}><Text style={{ fontSize: 15, marginRight: 8 }}>🔍</Text><Text style={{ color: '#6B7280', fontSize: 15 }}>Search shops, cafés, services…</Text></View>
        </View>

        {/* The gateway: six permanent entry points (2 × 3) ───────────────────────── */}
        <View style={{ paddingHorizontal: SIDE, paddingTop: 18, flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
          <GatewayTile label="Shop" line={PILLARS.shop.short} chip={chipFor('shop')} photo="shopping" crop={{ cx: 0.35, cy: 0.45, z: 1.2 }} from="#7C3AED" to="#3B0764" w={gw} h={158} />
          <GatewayTile label="Offers" line={PILLARS.offers.short} chip={chipFor('offers')} photo="street" crop={PILLARS.offers.crop} from="#D97706" to="#78350F" w={gw} h={158} />
          <GatewayTile label="Book" line={PILLARS.book.short} chip={chipFor('book')} photo="cafe" crop={{ cx: 0.5, cy: 0.4, z: 1.1 }} from="#059669" to="#064E3B" w={gw} h={158} />
          <GatewayTile label="Experiences" line={PILLARS.experiences.short} chip={chipFor('experiences')} photo="jarlshof" from="#0E7490" to="#164E63" w={gw} h={158} />
          <GatewayTile label="Businesses" line="Everyone trading across the isles" chip="500+ listed" photo="street" crop={{ cx: 0.85, cy: 0.5, z: 1.4 }} from="#4F46E5" to="#1E1B4B" w={gw} h={158} />
          <GatewayTile label="Rewards" line="Stamps, points and your Wallet" chip="Collect as you shop" from="#A855F7" to="#4C1D95" w={gw} h={158}>
            <View style={s.stampCard}>
              <Text style={{ fontSize: 8, fontWeight: '900', color: '#4C1D95', letterSpacing: 0.6 }}>SAMPLE CAFÉ · 5/8</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>{Array.from({ length: 8 }, (_, i) => <View key={i} style={[s.stamp, i < 5 ? { backgroundColor: '#7C3AED' } : { borderWidth: 1.5, borderStyle: 'dashed', borderColor: '#C4B5FD' }]} />)}</View>
            </View>
          </GatewayTile>
        </View>

        {/* Area chips ─────────────────────────────────────────────────────────────── */}
        <View style={{ marginTop: 16 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: SIDE, gap: 8 }}>
            {AREAS.map((a) => (
              <Text key={a} onPress={() => setArea(a)} style={[s.areaChip, area === a && { backgroundColor: '#5B21B6', color: '#fff', borderColor: '#5B21B6' }]}>{a}</Text>
            ))}
          </ScrollView>
        </View>

        {/* Featured locally ─────────────────────────────────────────────────────────── */}
        {lead && (
          <View style={{ marginTop: 26 }}>
            <SectionHead eyebrow="Featured locally" title="Handpicked from across the isles" color="#7C3AED" />
            <Rail>
              <View style={{ width: 270, height: 330, borderRadius: 24, overflow: 'hidden', backgroundColor: CAT_COLOR[lead.category] ?? '#4F46E5' }}>
                <CropImage uri={lead.cover_url ?? undefined} photo={lead.cover_url ? undefined : 'street'} crop={{ cx: 0.5, cy: 0.4, z: 1.2 }} style={StyleSheet.absoluteFill} />
                <Scrim dir="up" stops={[{ at: 0, color: CAT_COLOR[lead.category] ?? '#4F46E5', opacity: 0.97 }, { at: 0.45, color: CAT_COLOR[lead.category] ?? '#4F46E5', opacity: 0.75 }, { at: 1, color: CAT_COLOR[lead.category] ?? '#4F46E5', opacity: 0 }]} />
                <View style={{ position: 'absolute', left: 16, right: 16, bottom: 16 }}>
                  <View style={[s.logoTile, { width: 56, height: 56 }]}>{lead.logo_url ? <Image source={{ uri: lead.logo_url }} style={{ width: 48, height: 48 }} resizeMode="contain" /> : <Text style={{ fontSize: 24, fontWeight: '900' }}>{lead.name[0]}</Text>}</View>
                  <Chip label={CAT_LABEL[lead.category] ?? 'Business'} />
                  <DisplayText weight="bold" style={{ color: '#fff', fontSize: 28, lineHeight: 30, marginTop: 8 }}>{lead.name}</DisplayText>
                </View>
              </View>
              {featured.map((m) => <MerchCard key={m.id} m={m} />)}
              {others.slice(0, 2).map((b) => <BizTile key={b.id} b={b} />)}
            </Rail>
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
          <View style={{ marginHorizontal: SIDE, marginTop: 16, backgroundColor: '#fff', borderRadius: 22, padding: 16, transform: [{ rotate: '-1.5deg' }] }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <DisplayText weight="bold" style={{ color: '#2E1065', fontSize: 19 }}>Sample Café</DisplayText>
              <View style={{ backgroundColor: '#EDE9FE', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 3 }}><Text style={{ color: '#5B21B6', fontSize: 11, fontWeight: '900' }}>5 of 8</Text></View>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
              {Array.from({ length: 8 }, (_, i) => <View key={i} style={[s.bigStamp, i < 5 ? { backgroundColor: '#7C3AED' } : { borderWidth: 2, borderStyle: 'dashed', borderColor: '#C4B5FD' }]}><Text style={{ color: i < 5 ? '#fff' : '#C4B5FD', fontWeight: '900' }}>{i < 5 ? '★' : i + 1}</Text></View>)}
            </View>
            <Text style={{ color: '#6D28D9', fontSize: 12.5, fontWeight: '700', marginTop: 12 }}>3 more stamps for a free coffee</Text>
          </View>
        </View>

        {/* Jobs — supporting ────────────────────────────────────────────────────────── */}
        {jobs.length > 0 && (
          <View style={{ paddingTop: 26 }}>
            <SectionHead eyebrow="Work" title="Hiring locally" color="#2A8B5C" action="All jobs" />
            <View style={{ paddingHorizontal: SIDE, gap: 10 }}>
              {jobs.slice(0, 3).map((j) => (
                <View key={j.id} style={{ backgroundColor: '#fff', borderRadius: 16, borderLeftWidth: 4, borderLeftColor: '#2A8B5C', padding: 14 }}>
                  <DisplayText weight="bold" numberOfLines={2} style={{ fontSize: 17, lineHeight: 20, color: '#0F1C26' }}>{j.title}</DisplayText>
                  <Text numberOfLines={1} style={{ color: '#6B7280', fontSize: 12, marginTop: 3 }}>{j.employer} · {j.location}</Text>
                  {!!j.pay && <Text style={{ color: '#2A8B5C', fontSize: 12.5, fontWeight: '800', marginTop: 4 }}>{j.pay}</Text>}
                </View>
              ))}
            </View>
          </View>
        )}

        {/* For businesses ───────────────────────────────────────────────────────────── */}
        <View style={{ margin: SIDE, marginTop: 28, borderRadius: 24, overflow: 'hidden', padding: 20, backgroundColor: '#032F4C' }}>
          <Scrim dir="diag" stops={[{ at: 0, color: '#032F4C', opacity: 1 }, { at: 1, color: '#12667A', opacity: 1 }]} />
          <Text style={{ color: '#99F6E4', fontSize: 11, fontWeight: '800', letterSpacing: 1.2 }}>FOR BUSINESSES</Text>
          <DisplayText weight="bold" style={{ color: '#fff', fontSize: 27, lineHeight: 29, marginTop: 6 }}>Run a business in Shetland?</DisplayText>
          <DisplayText weight="bold" style={{ color: '#FDE68A', fontSize: 27, lineHeight: 29 }}>Put it on the island's map.</DisplayText>
          <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 14, lineHeight: 20, marginTop: 8 }}>List it free. Sell products, post offers, take bookings and sell passes to everyone on the islands.</Text>
          <View style={{ alignSelf: 'flex-start', backgroundColor: '#fff', borderRadius: 99, paddingHorizontal: 18, paddingVertical: 10, marginTop: 14 }}><Text style={{ fontWeight: '800', fontSize: 13.5 }}>Add your business free →</Text></View>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  search: { marginTop: 18, backgroundColor: '#fff', borderRadius: 99, paddingHorizontal: 16, height: 46, flexDirection: 'row', alignItems: 'center' },
  areaChip: { overflow: 'hidden', borderRadius: 99, borderWidth: 1, borderColor: '#CBD5E1', paddingHorizontal: 14, paddingVertical: 8, fontSize: 13, fontWeight: '700', color: '#374151', backgroundColor: '#fff' },
  logoTile: { width: 52, height: 52, borderRadius: 13, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  stampCard: { position: 'absolute', right: 10, top: 8, width: 84, backgroundColor: '#fff', borderRadius: 10, padding: 6, transform: [{ rotate: '5deg' }] },
  stamp: { width: 13, height: 13, borderRadius: 7 },
  bigStamp: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
});
