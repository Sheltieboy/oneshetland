/**
 * App Home V2 — DESIGN PREVIEW. Local only: not linked from the app, not in any shipped build, never published.
 * Open it in a development build at  /preview/home-v2?state=seed&as=public   (state: live|empty|seed|full, as: public|admin)
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable, Image, StyleSheet, useWindowDimensions } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DisplayText } from '../../components/DisplayText';
import { CropImage, Scrim, fade, MerchCard, Rail, SectionHead, GatewayTile, Chip, SIDE } from '../../components/preview-v2/ui';
import { HomeWork } from '../../components/preview-v2/WorkModule';
import { buildWork, parseMix } from '../../components/preview-v2/work';
import { PreviewSwitch } from '../../components/preview-v2/PreviewSwitch';
import { loadPreviewData, type PreviewData } from '../../components/preview-v2/data';
import { buildCommerce, density, PILLARS, PILLAR_ORDER, type Merch, type Pillar, type PreviewState, type PreviewViewer } from '../../components/preview-v2/model';

const EMPTY_REAL: Record<Pillar, Merch[]> = { shop: [], offers: [], book: [], experiences: [] };
const CAT_COLOR: Record<string, string> = { food_drink: '#C2410C', retail: '#7C3AED', services: '#0E7490', accommodation: '#15803D' };
const CAT_LABEL: Record<string, string> = { food_drink: 'Food & drink', retail: 'Retail', services: 'Services', accommodation: 'Stay' };
const NOUN: Record<Pillar, [string, string]> = { shop: ['product', 'products'], offers: ['offer', 'offers'], book: ['service', 'services'], experiences: ['experience', 'experiences'] };

const parseState = (v?: string): PreviewState => (['live', 'empty', 'seed', 'full'] as const).find((x) => x === v) ?? 'seed';

export default function AppHomeV2() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const q = useLocalSearchParams<{ state?: string; as?: string; work?: string }>();
  const state = parseState(q.state);
  const viewer: PreviewViewer = q.as === 'admin' ? 'admin' : 'public';
  const [data, setData] = useState<PreviewData | null>(null);
  const [audience, setAudience] = useState<'resident' | 'visiting'>('resident');
  useEffect(() => { void loadPreviewData().then(setData); }, []);
  const commerce = useMemo(() => buildCommerce(state, viewer, data?.real ?? EMPTY_REAL), [state, viewer, data]);

  const now = useMemo(() => new Date(), []);
  const work = useMemo(() => buildWork(state, parseMix(q.work), { jobs: data?.jobs ?? [], shifts: data?.shifts ?? [] }, now), [state, q.work, data, now]);

  const total = PILLAR_ORDER.reduce((n, p) => n + commerce[p].length, 0);
  const mixed: Merch[] = [];
  for (let i = 0; mixed.length < 12 && i < 6; i++) for (const p of PILLAR_ORDER) if (commerce[p][i] && mixed.length < 12) mixed.push(commerce[p][i]);
  const gw = (width - SIDE * 2 - 12) / 2;
  const events = data?.events ?? [];
  const [e0, e1, e2] = events;
  const biz = data?.businesses ?? [];
  const lead = biz.find((b) => b.logo_url || b.cover_url) ?? biz[0];
  const rest = biz.filter((b) => b.id !== lead?.id).slice(0, 6);
  const day = (iso: string) => new Date(iso);
  const dlabel = (iso: string) => day(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
  const tlabel = (iso: string) => day(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const showForYou = state === 'seed' || state === 'full';

  return (
    <View style={{ flex: 1, backgroundColor: '#F6F1E8' }}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 60 }}>
        <View style={{ height: insets.top, backgroundColor: '#0F172A' }} />
        <PreviewSwitch route="home-v2" state={state} viewer={viewer} />

        {/* 1–4 · top bar, search, mode, Shetland now ─────────────────────────────── */}
        <View style={{ backgroundColor: '#032F4C', paddingHorizontal: SIDE, paddingTop: 14, paddingBottom: 18 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Image source={require('../../assets/logo-mark-keyed.png')} style={{ width: 32, height: 32 }} resizeMode="contain" />
            <DisplayText weight="bold" style={{ color: '#fff', fontSize: 21, marginLeft: 8, flex: 1 }}>OneShetland</DisplayText>
            <View style={s.walletPill}><Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>👛  £12.50</Text></View>
            <View style={s.roundBtn}><Text style={{ fontSize: 15 }}>🔔</Text><View style={s.dot} /></View>
            <View style={[s.roundBtn, { backgroundColor: '#12B3D6' }]}><Text style={{ color: '#fff', fontWeight: '900', fontSize: 13 }}>D</Text></View>
          </View>

          <View style={s.search}><Text style={{ fontSize: 15, marginRight: 8 }}>🔍</Text><Text style={{ color: '#6B7280', fontSize: 15 }}>Search Shetland — businesses, events, jobs…</Text></View>

          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12, justifyContent: 'space-between' }}>
            <View style={s.seg}>
              {(['resident', 'visiting'] as const).map((a) => (
                <Pressable key={a} onPress={() => setAudience(a)} style={[s.segItem, audience === a && { backgroundColor: '#fff' }]}>
                  <Text style={{ fontSize: 11.5, fontWeight: '800', color: audience === a ? '#032F4C' : 'rgba(255,255,255,0.85)' }}>{a === 'resident' ? '🏠 I live here' : "🧳 I'm visiting"}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Shetland now */}
          <View style={s.nowStrip}>
            <Text style={{ color: '#fff', fontSize: 12.5, fontWeight: '700', flex: 1 }} numberOfLines={1}>{data?.weather ?? 'Lerwick · loading…'}</Text>
            {data?.ships && <View style={s.nowChip}><Text style={s.nowChipText}>⚓ {data.ships.count} {data.ships.count === 1 ? 'ship' : 'ships'} in port</Text></View>}
          </View>
        </View>

        {/* 5 · FOR YOU — real personal content only; sample tiles shown in the seeded states so the design can be judged ── */}
        {showForYou && (
          <View style={{ marginTop: 22 }}>
            <SectionHead eyebrow="Picked for you · preview sample" title="For you" color="#7C3AED" />
            <Rail>
              <View style={[s.fy, { backgroundColor: '#4C1D95' }]}>
                <Scrim dir="diag" stops={[{ at: 0, color: '#7C3AED', opacity: 1 }, { at: 1, color: '#312E81', opacity: 1 }]} />
                <Chip label="Wallet" /><View><DisplayText style={{ color: '#fff', fontSize: 34 }}>£12.50</DisplayText><Text style={s.fyLine}>Top up · 3 stamps to a free coffee</Text></View>
              </View>
              <View style={[s.fy, { backgroundColor: '#059669' }]}>
                <Scrim dir="diag" stops={[{ at: 0, color: '#059669', opacity: 1 }, { at: 1, color: '#064E3B', opacity: 1 }]} />
                <Chip label="Booked" /><View><DisplayText weight="bold" style={{ color: '#fff', fontSize: 22, lineHeight: 24 }}>Tomorrow 10:30</DisplayText><Text style={s.fyLine}>Cut & finish · Sample Hair Studio</Text></View>
              </View>
              <View style={[s.fy, { backgroundColor: '#B45309' }]}>
                <Scrim dir="diag" stops={[{ at: 0, color: '#D4921A', opacity: 1 }, { at: 1, color: '#78350F', opacity: 1 }]} />
                <Chip label="Tickets" /><View><DisplayText weight="bold" style={{ color: '#fff', fontSize: 22, lineHeight: 24 }}>Thu 8 Oct</DisplayText><Text style={s.fyLine}>2 tickets · Accordion & Fiddle Festival</Text></View>
              </View>
            </Rail>
          </View>
        )}

        {/* 6 · HAPPENING NOW — editorial ───────────────────────────────────────────── */}
        {e0 && (
          <View style={{ marginTop: 26 }}>
            <SectionHead eyebrow="Right now in Shetland" title="What's happening" color="#D4921A" action="Calendar" />
            <View style={{ paddingHorizontal: SIDE, gap: 12 }}>
              <View style={{ height: 300, borderRadius: 24, overflow: 'hidden' }}>
                <CropImage uri={e0.cover_url ?? undefined} photo={e0.cover_url ? undefined : 'concert'} style={StyleSheet.absoluteFill} />
                <Scrim dir="up" stops={fade('#000', 0.88, 0.3, 0.05)} />
                <View style={{ position: 'absolute', left: 18, right: 18, bottom: 18 }}>
                  <View style={{ alignSelf: 'flex-start', backgroundColor: '#fff', borderRadius: 99, paddingHorizontal: 12, paddingVertical: 5, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: '#D4921A' }} /><Text style={{ color: '#B45309', fontSize: 11, fontWeight: '900' }}>{dlabel(e0.starts_at)}</Text>
                  </View>
                  <DisplayText weight="bold" style={{ color: '#fff', fontSize: 31, lineHeight: 33, marginTop: 10 }}>{e0.title}</DisplayText>
                  <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: 14, fontWeight: '600', marginTop: 5 }}>{tlabel(e0.starts_at)}{e0.venue ? ` · ${e0.venue}` : ''}</Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                {e1 && (
                  <View style={{ width: gw, height: 150, borderRadius: 20, overflow: 'hidden' }}>
                    <CropImage uri={e1.cover_url ?? undefined} photo={e1.cover_url ? undefined : 'concert'} style={StyleSheet.absoluteFill} />
                    <Scrim dir="up" stops={fade('#000', 0.85, 0.3, 0.05)} />
                    <View style={{ position: 'absolute', left: 12, right: 12, bottom: 11 }}>
                      <Text style={{ color: '#FCD34D', fontSize: 10, fontWeight: '900' }}>{dlabel(e1.starts_at)}</Text>
                      <DisplayText weight="bold" numberOfLines={2} style={{ color: '#fff', fontSize: 17, lineHeight: 19, marginTop: 2 }}>{e1.title}</DisplayText>
                    </View>
                  </View>
                )}
                {data?.ships ? (
                  <View style={{ width: gw, height: 150, borderRadius: 20, overflow: 'hidden', backgroundColor: '#0A4A70', padding: 14, justifyContent: 'space-between' }}>
                    <Scrim dir="diag" stops={[{ at: 0, color: '#0A4A70', opacity: 1 }, { at: 1, color: '#032F4C', opacity: 1 }]} />
                    <Text style={{ color: '#BAE6FD', fontSize: 10, fontWeight: '900', letterSpacing: 1 }}>IN PORT TODAY</Text>
                    <DisplayText style={{ color: '#fff', fontSize: 44, lineHeight: 46 }}>{data.ships.count}<Text style={{ fontSize: 15 }}> {data.ships.count === 1 ? 'ship' : 'ships'}</Text></DisplayText>
                  </View>
                ) : e2 ? (
                  <View style={{ width: gw, height: 150, borderRadius: 20, overflow: 'hidden', backgroundColor: '#B45309', padding: 14, justifyContent: 'space-between' }}>
                    <Scrim dir="diag" stops={[{ at: 0, color: '#D4921A', opacity: 1 }, { at: 1, color: '#92400E', opacity: 1 }]} />
                    <DisplayText style={{ color: '#fff', fontSize: 44, lineHeight: 46 }}>{day(e2.starts_at).getDate()}<Text style={{ fontSize: 15 }}> {day(e2.starts_at).toLocaleDateString('en-GB', { month: 'short' }).toUpperCase()}</Text></DisplayText>
                    <DisplayText weight="bold" numberOfLines={2} style={{ color: '#fff', fontSize: 16, lineHeight: 18 }}>{e2.title}</DisplayText>
                  </View>
                ) : null}
              </View>
            </View>
          </View>
        )}

        {/* 7 · LOCAL DISCOVERY — a rich rail ─────────────────────────────────────── */}
        {lead && (
          <View style={{ marginTop: 28, backgroundColor: '#EDE3D2', paddingVertical: 24 }}>
            <SectionHead eyebrow="Discover something local" title="Who's open for business" color="#7C3AED" action="All" />
            <Rail>
              <View style={{ width: 262, height: 330, borderRadius: 24, overflow: 'hidden', backgroundColor: CAT_COLOR[lead.category] ?? '#4F46E5' }}>
                <CropImage uri={lead.cover_url ?? undefined} photo={lead.cover_url ? undefined : 'street'} crop={{ cx: 0.5, cy: 0.4, z: 1.2 }} style={StyleSheet.absoluteFill} />
                <Scrim dir="up" stops={[{ at: 0, color: CAT_COLOR[lead.category] ?? '#4F46E5', opacity: 0.97 }, { at: 0.45, color: CAT_COLOR[lead.category] ?? '#4F46E5', opacity: 0.75 }, { at: 1, color: CAT_COLOR[lead.category] ?? '#4F46E5', opacity: 0 }]} />
                <View style={{ position: 'absolute', left: 16, right: 16, bottom: 16 }}>
                  <View style={s.logoTile}>{lead.logo_url ? <Image source={{ uri: lead.logo_url }} style={{ width: 54, height: 54 }} resizeMode="contain" /> : <Text style={{ fontSize: 24, fontWeight: '900' }}>{lead.name[0]}</Text>}</View>
                  <Chip label={CAT_LABEL[lead.category] ?? 'Business'} />
                  <DisplayText weight="bold" style={{ color: '#fff', fontSize: 28, lineHeight: 30, marginTop: 8 }}>{lead.name}</DisplayText>
                  {!!lead.description && <Text numberOfLines={2} style={{ color: 'rgba(255,255,255,0.9)', fontSize: 13, lineHeight: 18, marginTop: 5 }}>{lead.description}</Text>}
                </View>
              </View>
              {rest.map((b) => {
                const c = CAT_COLOR[b.category] ?? '#4F46E5';
                return (
                  <View key={b.id} style={{ width: 158, height: 200, borderRadius: 22, overflow: 'hidden', backgroundColor: c, padding: 14, justifyContent: 'space-between' }}>
                    <Scrim dir="diag" stops={[{ at: 0, color: c, opacity: 1 }, { at: 1, color: '#1E1B4B', opacity: 1 }]} />
                    <View style={[s.logoTile, { marginBottom: 0 }]}>{b.logo_url ? <Image source={{ uri: b.logo_url }} style={{ width: 46, height: 46 }} resizeMode="contain" /> : <Text style={{ fontSize: 20, fontWeight: '900' }}>{b.name[0]}</Text>}</View>
                    <View>
                      <Text style={{ color: 'rgba(255,255,255,0.78)', fontSize: 9.5, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' }}>{CAT_LABEL[b.category] ?? 'Business'}</Text>
                      <DisplayText weight="bold" numberOfLines={2} style={{ color: '#fff', fontSize: 18, lineHeight: 20, marginTop: 2 }}>{b.name}</DisplayText>
                    </View>
                  </View>
                );
              })}
            </Rail>
          </View>
        )}

        {/* 8 · SHOP · OFFERS · BOOK · EXPERIENCES ────────────────────────────────── */}
        <View style={{ backgroundColor: '#2E1065', paddingTop: 26, paddingBottom: 26 }}>
          <SectionHead eyebrow="Shop local" title="Shop · Offers · Book · Experiences" light action="Local" />
          <View style={{ paddingHorizontal: SIDE, flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
            {PILLAR_ORDER.map((p) => {
              const pl = PILLARS[p]; const n = commerce[p].length; const d = density(n);
              return <GatewayTile key={p} label={pl.label} line={pl.short} chip={d === 'none' ? 'Opening soon' : `${n} ${NOUN[p][n === 1 ? 0 : 1]}`} photo={pl.photo} crop={pl.crop} from={pl.color} to={pl.deep} w={gw} h={172} />;
            })}
          </View>
          <View style={{ marginTop: 22 }}>
            {total > 0 ? (
              <>
                <Text style={{ color: 'rgba(255,255,255,0.72)', fontSize: 11, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase', paddingHorizontal: SIDE, marginBottom: 10 }}>Fresh from local businesses</Text>
                <Rail>{mixed.map((m) => <MerchCard key={m.id} m={m} dark notch="#2E1065" />)}</Rail>
              </>
            ) : (
              <View style={{ marginHorizontal: SIDE, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)', backgroundColor: 'rgba(255,255,255,0.1)', padding: 18 }}>
                <DisplayText weight="bold" style={{ color: '#fff', fontSize: 22, lineHeight: 25 }}>The first Shetland businesses are setting up shop here.</DisplayText>
                <Text style={{ color: 'rgba(255,255,255,0.82)', fontSize: 14, lineHeight: 20, marginTop: 6 }}>Products from makers, offers from cafés and shops, appointments to book and days out to buy — all local.</Text>
                <View style={{ alignSelf: 'flex-start', backgroundColor: '#fff', borderRadius: 99, paddingHorizontal: 16, paddingVertical: 9, marginTop: 12 }}><Text style={{ fontWeight: '800', fontSize: 13 }}>Be one of the first →</Text></View>
              </View>
            )}
          </View>
        </View>

        {/* 8b · WORK — jobs & shifts together ───────────────────────────────────────── */}
        <HomeWork work={work} now={now} />

        {/* 9 · ISLAND LIFE — one mosaic ──────────────────────────────────────────── */}
        <View style={{ backgroundColor: '#032F4C', paddingTop: 26, paddingBottom: 26 }}>
          <SectionHead eyebrow="Island life" title="Fae da isles" light />
          <View style={{ paddingHorizontal: SIDE, gap: 12 }}>
            <View style={{ height: 210, borderRadius: 22, overflow: 'hidden' }}>
              <CropImage photo="boats" style={StyleSheet.absoluteFill} /><Scrim dir="up" stops={fade('#000', 0.85, 0.2, 0)} />
              <View style={{ position: 'absolute', left: 14, top: 14 }}><Chip label="Da Boats" bg="#1E3A8A" /></View>
              <View style={{ position: 'absolute', left: 16, bottom: 14 }}><DisplayText style={{ color: '#fff', fontSize: 30 }}>The fleet</DisplayText><Text style={{ color: 'rgba(255,255,255,0.82)', fontSize: 12, fontWeight: '600' }}>The fishing fleet, past and present</Text></View>
            </View>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ width: gw, height: 190, borderRadius: 20, overflow: 'hidden' }}>
                <CropImage photo="memory" style={StyleSheet.absoluteFill} /><Scrim dir="up" stops={fade('#9F1239', 0.95, 0.35, 0)} />
                <View style={{ position: 'absolute', left: 12, top: 12 }}><Chip label="Aald Memories" bg="#9F1239" size={9} /></View>
                <DisplayText weight="bold" style={{ position: 'absolute', left: 12, right: 12, bottom: 12, color: '#fff', fontSize: 17, lineHeight: 19 }}>A story fae da isles</DisplayText>
              </View>
              <View style={{ width: gw, gap: 12 }}>
                <View style={{ height: 89, borderRadius: 20, overflow: 'hidden', backgroundColor: '#0E7490', padding: 12, justifyContent: 'space-between' }}>
                  <Scrim dir="diag" stops={[{ at: 0, color: '#12B3D6', opacity: 1 }, { at: 1, color: '#0E7490', opacity: 1 }]} />
                  <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 9, fontWeight: '900', letterSpacing: 1 }}>WIRD O' DA DAY</Text>
                  <DisplayText style={{ color: '#fff', fontSize: 24, lineHeight: 26 }}>{data?.spik?.word ?? 'peerie'}</DisplayText>
                </View>
                <View style={{ height: 89, borderRadius: 20, overflow: 'hidden', backgroundColor: '#047857', padding: 12, justifyContent: 'space-between' }}>
                  <Scrim dir="diag" stops={[{ at: 0, color: '#10B981', opacity: 1 }, { at: 1, color: '#047857', opacity: 1 }]} />
                  <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 9, fontWeight: '900', letterSpacing: 1 }}>TODAY'S GAME</Text>
                  <DisplayText weight="bold" style={{ color: '#fff', fontSize: 17, lineHeight: 19 }}>Spik Sprint</DisplayText>
                </View>
              </View>
            </View>
          </View>
        </View>

        {/* 10 · COMMUNITY / NOTICES — real only ──────────────────────────────────── */}
        <View style={{ paddingTop: 26 }}>
          <SectionHead eyebrow="Community" title="From the community" color="#6B47BF" action="Hubs" />
          <View style={{ paddingHorizontal: SIDE, gap: 12 }}>
            {(data?.notices ?? []).map((n) => (
              <View key={n.id} style={{ borderRadius: 22, padding: 18, backgroundColor: '#DDD6FE' }}>
                <Text style={{ color: '#6D28D9', fontSize: 10.5, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase' }}>{n.publisher}</Text>
                <DisplayText weight="bold" style={{ color: '#2E1065', fontSize: 23, lineHeight: 26, marginTop: 4 }}>{n.title}</DisplayText>
                <Text numberOfLines={3} style={{ color: '#4C1D95', fontSize: 13.5, lineHeight: 19, marginTop: 6 }}>{n.body}</Text>
              </View>
            ))}
            {(data?.notices ?? []).length === 0 && (
              <View style={{ borderRadius: 22, padding: 18, backgroundColor: '#EDE9FE' }}>
                <DisplayText weight="bold" style={{ color: '#2E1065', fontSize: 20 }}>Hubs bring clubs, groups and good causes together.</DisplayText>
              </View>
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  walletPill: { backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 99, paddingHorizontal: 11, paddingVertical: 7, marginRight: 8 },
  roundBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center', marginLeft: 6 },
  dot: { position: 'absolute', top: 7, right: 8, width: 8, height: 8, borderRadius: 4, backgroundColor: '#EF4444', borderWidth: 1, borderColor: '#032F4C' },
  search: { marginTop: 14, backgroundColor: '#fff', borderRadius: 99, paddingHorizontal: 16, height: 46, flexDirection: 'row', alignItems: 'center' },
  seg: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 99, padding: 3 },
  segItem: { borderRadius: 99, paddingHorizontal: 12, paddingVertical: 6 },
  nowStrip: { marginTop: 12, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9, gap: 8 },
  nowChip: { backgroundColor: 'rgba(125,211,252,0.25)', borderRadius: 99, paddingHorizontal: 9, paddingVertical: 4 },
  nowChipText: { color: '#E0F2FE', fontSize: 11, fontWeight: '800' },
  fy: { width: 176, height: 150, borderRadius: 20, overflow: 'hidden', padding: 14, justifyContent: 'space-between' },
  fyLine: { color: 'rgba(255,255,255,0.88)', fontSize: 11.5, fontWeight: '600', marginTop: 3 },
  logoTile: { width: 58, height: 58, borderRadius: 14, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
});
