/**
 * HomeScreen — the app's Home tab (app/(tabs)/index.tsx).
 *
 * A living front page of Shetland: a compact identity / wallet / search header, then what is genuinely yours (For you),
 * what is happening, who is open, local commerce, Work (jobs and shifts together), island life and community notices.
 * Everything is real data; a section with nothing to show collapses (For you, What's happening, Who's open) or
 * shows its standing proposition (commerce, Work, community) — nothing is invented.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, Pressable, Image, StyleSheet, RefreshControl } from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { FontAwesome5 } from '@expo/vector-icons';
import DisplayText from '@/components/DisplayText';
import AlertPill from '@/components/AlertPill';
import { NotificationBell } from '@/components/NotificationBell';
import { useAuth } from '@/context/AuthContext';
import { useAppLayout } from '@/hooks/useAppLayout';
import { supabase } from '@/lib/supabase';
import { fetchActiveAlerts, type PartnerAlert } from '@/lib/alerts-api';
import { cachedAudience, saveAudience, type Audience } from '@/lib/audience';
import { fetchWalletBalance, formatPence } from '@/lib/local-api';
import { fetchHomeData, type HomeData } from '@/lib/home-data';
import { fetchMyUpcomingEventTickets } from '@/lib/events-api';
import { fetchNearbyOffers, type NearbyOffer } from '@/lib/concierge-api';
import { loadSavedBoats, type VesselStub } from '@/lib/boats-prefs';
import { TestBadge } from '@/components/TestBadge';
import { CropImage, Scrim, fade, MerchCard, Rail, SectionHead, GatewayTile, Chip, SIDE } from './ui';
import { HomeWork } from './WorkModule';
import { buildWork } from './work';
import { loadHomeLocalData, type HomeLocalData } from './data';
import { buildForYou, type ForYouTile, type ForYouTone } from './forYou';
import { density, PILLARS, PILLAR_ORDER, PILLAR_ROUTE, PILLAR_CTA_ROUTE, emptyCommerce, type Merch, type Pillar } from './model';
import type { PhotoKey } from './images';

// Soft-load expo-location so a missing dep gracefully degrades (as the previous Home did).
let Location: any = null;
try { Location = require('expo-location'); } catch { Location = null; }

const CAT_COLOR: Record<string, string> = { food_drink: '#C2410C', retail: '#7C3AED', services: '#0E7490', accommodation: '#15803D' };
const CAT_LABEL: Record<string, string> = { food_drink: 'Food & drink', retail: 'Retail', services: 'Services', accommodation: 'Stay' };
// One photograph per tile and none repeated on screen: Offers is colour (its cards are tickets), the rest are distinct.
const GATEWAY_PHOTO: Partial<Record<Pillar, { photo: PhotoKey; crop?: { cx: number; cy: number; z: number } }>> = {
  shop: { photo: 'shopping', crop: { cx: 0.35, cy: 0.45, z: 1.2 } }, book: { photo: 'cafe', crop: { cx: 0.5, cy: 0.4, z: 1.1 } }, experiences: { photo: 'scatness', crop: { cx: 0.5, cy: 0.5, z: 1.1 } },
};
// The rail leads with a ticket, a day out and a service so its first cards don't echo the Shop tile above it.
const RAIL_ORDER: Pillar[] = ['offers', 'experiences', 'book', 'shop'];
const NOUN: Record<Pillar, [string, string]> = { shop: ['product', 'products'], offers: ['offer', 'offers'], book: ['service', 'services'], experiences: ['experience', 'experiences'] };
const TONE: Record<ForYouTone, [string, string]> = {
  wallet: ['#7C3AED', '#312E81'], booking: ['#059669', '#064E3B'], ticket: ['#D4921A', '#78350F'], delivery: ['#0E7490', '#164E63'],
  work: ['#2563EB', '#1E3A8A'], reward: ['#DB2777', '#831843'], gift: ['#A855F7', '#4C1D95'], saved: ['#1E3A8A', '#0F172A'], nearby: ['#D97706', '#78350F'],
};

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { profile } = useAuth();
  const { contentWidth } = useAppLayout();
  const width = contentWidth;

  const [data, setData] = useState<HomeLocalData | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // ── Audience: living here or visiting — a ranking hint, persisted exactly as before (lib/audience.ts). ──
  const [audience, setAudienceState] = useState<Audience>('resident');
  useEffect(() => { let alive = true; cachedAudience().then((a) => { if (alive && a) setAudienceState(a); }); return () => { alive = false; }; }, []);
  useEffect(() => {
    if (!profile) return;
    // The intro asks before sign-in, so that answer lives in the device cache; on first sign-in the profile is still at
    // its 'resident' default, which must not silently undo a visitor's choice.
    void (async () => {
      const cached = await cachedAudience();
      if (profile.audience === 'resident' && cached === 'visiting') { setAudienceState('visiting'); void saveAudience(profile.id, 'visiting'); return; }
      if (profile.audience) setAudienceState(profile.audience);
    })();
  }, [profile?.id, profile?.audience]);
  const toggleAudience = useCallback(() => {
    const next: Audience = audience === 'resident' ? 'visiting' : 'resident';
    setAudienceState(next);
    Haptics.selectionAsync();
    void saveAudience(profile?.id, next);
  }, [audience, profile?.id]);

  // ── Partner alerts: the floating pill, live (unchanged behaviour). ──
  const [alerts, setAlerts] = useState<PartnerAlert[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  useEffect(() => {
    fetchActiveAlerts().then(setAlerts).catch(() => {});
    const existing = supabase.getChannels().find((c) => c.topic === 'realtime:partner-alerts-home');
    if (existing) supabase.removeChannel(existing);
    const channel = supabase.channel('partner-alerts-home')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'partner_alerts' }, () => { fetchActiveAlerts().then(setAlerts).catch(() => {}); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);
  const visibleAlert = alerts.find((a) => !dismissed.has(a.id)) ?? null;

  // ── Wallet + everything personal (For you). Only for a signed-in person. ──
  const [walletPence, setWalletPence] = useState<number | null>(null);
  const [home, setHome] = useState<HomeData | null>(null);
  const [tickets, setTickets] = useState<Awaited<ReturnType<typeof fetchMyUpcomingEventTickets>>>([]);
  const [savedBoats, setSavedBoats] = useState<VesselStub[]>([]);
  const [nearby, setNearby] = useState<NearbyOffer[]>([]);

  const loadAll = useCallback(async () => {
    const parish = (profile as { parish?: string | null } | null)?.parish ?? null;
    const tasks: Promise<unknown>[] = [
      loadHomeLocalData(parish, profile?.id).then(setData),
      loadSavedBoats().then(setSavedBoats).catch(() => {}),
    ];
    if (profile?.id) {
      tasks.push(
        fetchWalletBalance(profile.id).then(setWalletPence).catch(() => {}),
        fetchHomeData(profile).then(setHome).catch(() => setHome(null)),
        fetchMyUpcomingEventTickets(profile.id).then(setTickets).catch(() => setTickets([])),
      );
    } else { setWalletPence(null); setHome(null); setTickets([]); }
    // Nearby offers use location only if the person has ALREADY allowed it elsewhere — Home never prompts.
    if (Location) {
      tasks.push((async () => {
        try {
          const perm = await Location.getForegroundPermissionsAsync?.();
          if (!perm?.granted) { setNearby([]); return; }
          const pos = await Location.getCurrentPositionAsync?.({ accuracy: Location.Accuracy?.Balanced });
          if (pos?.coords) setNearby(await fetchNearbyOffers(pos.coords.latitude, pos.coords.longitude, 2));
        } catch { /* ignore */ }
      })());
    }
    await Promise.all(tasks);
  }, [profile]);
  useFocusEffect(useCallback(() => { void loadAll(); }, [loadAll]));
  const onRefresh = useCallback(async () => { setRefreshing(true); await loadAll(); setRefreshing(false); }, [loadAll]);

  const now = useMemo(() => new Date(), [data]);
  const work = useMemo(() => buildWork({ jobs: data?.jobs ?? [], shifts: data?.shifts ?? [] }, now), [data, now]);
  const commerce = data?.commerce ?? emptyCommerce();
  const forYou = useMemo(
    () => buildForYou({ signedIn: !!profile?.id, walletPence, home, tickets, savedBoats, nearby }, now),
    [profile?.id, walletPence, home, tickets, savedBoats, nearby, now],
  );

  const total = PILLAR_ORDER.reduce((n, p) => n + commerce[p].length, 0);
  const mixed: Merch[] = [];
  for (let i = 0; mixed.length < 12 && i < 6; i++) for (const p of RAIL_ORDER) if (commerce[p][i] && mixed.length < 12) mixed.push(commerce[p][i]);
  const gw = (width - SIDE * 2 - 12) / 2;
  const [e0, e1, e2] = data?.events ?? [];
  const biz = data?.businesses ?? [];
  const lead = biz.find((b) => b.logo_url || b.cover_url) ?? biz[0];
  const rest = biz.filter((b) => b.id !== lead?.id).slice(0, 6);
  const dlabel = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
  const tlabel = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const openEvent = (id: string) => router.push({ pathname: '/events/[id]', params: { id } } as never);
  const openBusiness = (id: string) => router.push({ pathname: '/local-business-detail', params: { id } } as never);
  const urgentNotice = (data?.notices ?? []).find((n) => n.severity === 'urgent') ?? null;

  const initials = profile?.full_name ? profile.full_name.trim().split(/\s+/).slice(0, 2).map((w: string) => w[0]).join('').toUpperCase() : '?';
  const walletLabel = walletPence == null ? null : walletPence % 100 === 0 ? `£${Math.round(walletPence / 100)}` : formatPence(walletPence);

  return (
    <View style={{ flex: 1, backgroundColor: '#F6F1E8' }}>
      <Stack.Screen options={{ headerShown: false }} />
      {visibleAlert && <AlertPill alert={visibleAlert} onDismiss={(id) => setDismissed((prev) => new Set([...prev, id]))} />}
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 60 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#12B3D6" />}>
        {/* 1–4 · compact top: identity · wallet · alerts · profile / search + audience / Shetland now ───────── */}
        <View style={{ backgroundColor: '#032F4C', paddingHorizontal: SIDE, paddingTop: insets.top + 6, paddingBottom: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', height: 40 }}>
            <Image source={require('../../assets/logo-mark-keyed.png')} style={{ width: 28, height: 28 }} resizeMode="contain" />
            <DisplayText weight="bold" style={{ color: '#fff', fontSize: 20, marginLeft: 7, flex: 1 }} numberOfLines={1}>OneShetland</DisplayText>
            <Pressable onPress={() => router.push('/local-wallet')} hitSlop={6} style={s.walletPill} accessibilityLabel={walletLabel ? `Wallet, ${walletLabel}` : 'Wallet'}>
              <FontAwesome5 name="wallet" size={12} color="#fff" solid />
              {walletLabel != null && <Text style={{ color: '#fff', fontSize: 12.5, fontWeight: '800', marginLeft: 6 }}>{walletLabel}</Text>}
            </Pressable>
            <NotificationBell size={32} />
            <Pressable onPress={() => router.push('/(tabs)/me')} hitSlop={5} style={[s.roundBtn, { backgroundColor: '#12B3D6' }]} accessibilityLabel="Profile"><Text style={{ color: '#fff', fontWeight: '900', fontSize: 13 }}>{initials}</Text></Pressable>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 8 }}>
            <Pressable onPress={() => router.push('/search')} style={s.search} accessibilityLabel="Search">
              <FontAwesome5 name="search" size={13} color="#6B7280" />
              <Text numberOfLines={1} style={{ color: '#6B7280', fontSize: 14, flex: 1, marginLeft: 8 }}>Search Shetland…</Text>
            </Pressable>
            <Pressable onPress={toggleAudience} style={s.mode} accessibilityLabel={audience === 'resident' ? 'Mode: I live here. Tap to switch to visiting' : "Mode: I'm visiting. Tap to switch to I live here"}>
              <Text style={{ fontSize: 12, fontWeight: '800', color: '#fff' }}>{audience === 'resident' ? '🏠 Live here' : '🧳 Visiting'}</Text>
              <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginLeft: 5 }}>⇄</Text>
            </Pressable>
          </View>

          {/* Shetland now — a slim contextual line */}
          <View style={s.nowStrip}>
            <Text style={{ color: 'rgba(255,255,255,0.92)', fontSize: 12, fontWeight: '700', flex: 1 }} numberOfLines={1}>{data?.weather ?? 'Lerwick'}</Text>
            {data?.ships && <View style={s.nowChip}><Text style={s.nowChipText}>⚓ {data.ships.count} {data.ships.count === 1 ? 'ship' : 'ships'} in port</Text></View>}
          </View>
          {urgentNotice && (
            <Pressable onPress={() => router.push('/notices')} style={s.urgentChip}>
              <FontAwesome5 name="exclamation-triangle" size={10} color="#fff" solid />
              <Text style={{ color: '#fff', fontSize: 11.5, fontWeight: '800', flex: 1 }} numberOfLines={1}>{urgentNotice.title}</Text>
            </Pressable>
          )}
        </View>

        {/* 4b · PLAN MY DAY — visitors only. Someone who lives here doesn't need an itinerary, so in "Live here" mode this does not render. */}
        {audience === 'visiting' && <PlanDayCard onPress={() => router.push('/plan-day')} />}

        {/* 5 · FOR YOU — only what genuinely belongs to this person; no tiles → no section ─────────────────── */}
        {forYou.length > 0 && (
          <View style={{ marginTop: 18 }}>
            <SectionHead eyebrow="Picked for you" title="For you" color="#7C3AED" />
            <Rail>{forYou.map((t) => <ForYouCard key={t.id} t={t} onPress={() => router.push({ pathname: t.route.pathname as never, params: t.route.params })} />)}</Rail>
          </View>
        )}

        {/* 6 · HAPPENING NOW — editorial ───────────────────────────────────────────── */}
        {e0 && (
          <View style={{ marginTop: 26 }}>
            <SectionHead eyebrow="Right now in Shetland" title="What's happening" color="#D4921A" action="Calendar" onAction={() => router.push('/(tabs)/whats-on')} />
            <View style={{ paddingHorizontal: SIDE, gap: 12 }}>
              <Pressable onPress={() => openEvent(e0.id)} style={{ height: 300, borderRadius: 24, overflow: 'hidden' }}>
                <CropImage uri={e0.cover_url ?? undefined} photo={e0.cover_url ? undefined : 'concert'} style={StyleSheet.absoluteFill} />
                <Scrim dir="up" stops={fade('#000', 0.88, 0.3, 0.05)} />
                <View style={{ position: 'absolute', left: 18, right: 18, bottom: 18 }}>
                  <View style={{ alignSelf: 'flex-start', backgroundColor: '#fff', borderRadius: 99, paddingHorizontal: 12, paddingVertical: 5, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: '#D4921A' }} /><Text style={{ color: '#B45309', fontSize: 11, fontWeight: '900' }}>{dlabel(e0.starts_at)}</Text>
                  </View>
                  <DisplayText weight="bold" style={{ color: '#fff', fontSize: 31, lineHeight: 33, marginTop: 10 }}>{e0.title}</DisplayText>
                  <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: 14, fontWeight: '600', marginTop: 5 }}>{tlabel(e0.starts_at)}{e0.venue ? ` · ${e0.venue}` : ''}</Text>
                </View>
              </Pressable>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                {e1 && (
                  <Pressable onPress={() => openEvent(e1.id)} style={{ width: gw, height: 150, borderRadius: 20, overflow: 'hidden' }}>
                    <CropImage uri={e1.cover_url ?? undefined} photo={e1.cover_url ? undefined : 'concert'} style={StyleSheet.absoluteFill} />
                    <Scrim dir="up" stops={fade('#000', 0.85, 0.3, 0.05)} />
                    <View style={{ position: 'absolute', left: 12, right: 12, bottom: 11 }}>
                      <Text style={{ color: '#FCD34D', fontSize: 10, fontWeight: '900' }}>{dlabel(e1.starts_at)}</Text>
                      <DisplayText weight="bold" numberOfLines={2} style={{ color: '#fff', fontSize: 17, lineHeight: 19, marginTop: 2 }}>{e1.title}</DisplayText>
                    </View>
                  </Pressable>
                )}
                {data?.ships ? (
                  <Pressable onPress={() => router.push('/cruise')} style={{ width: gw, height: 150, borderRadius: 20, overflow: 'hidden', backgroundColor: '#0A4A70', padding: 14, justifyContent: 'space-between' }}>
                    <Scrim dir="diag" stops={[{ at: 0, color: '#0A4A70', opacity: 1 }, { at: 1, color: '#032F4C', opacity: 1 }]} />
                    <Text style={{ color: '#BAE6FD', fontSize: 10, fontWeight: '900', letterSpacing: 1 }}>IN PORT TODAY</Text>
                    <DisplayText style={{ color: '#fff', fontSize: 44, lineHeight: 46 }}>{data.ships.count}<Text style={{ fontSize: 15 }}> {data.ships.count === 1 ? 'ship' : 'ships'}</Text></DisplayText>
                  </Pressable>
                ) : e2 ? (
                  <Pressable onPress={() => openEvent(e2.id)} style={{ width: gw, height: 150, borderRadius: 20, overflow: 'hidden', backgroundColor: '#B45309', padding: 14, justifyContent: 'space-between' }}>
                    <Scrim dir="diag" stops={[{ at: 0, color: '#D4921A', opacity: 1 }, { at: 1, color: '#92400E', opacity: 1 }]} />
                    <DisplayText style={{ color: '#fff', fontSize: 44, lineHeight: 46 }}>{new Date(e2.starts_at).getDate()}<Text style={{ fontSize: 15 }}> {new Date(e2.starts_at).toLocaleDateString('en-GB', { month: 'short' }).toUpperCase()}</Text></DisplayText>
                    <DisplayText weight="bold" numberOfLines={2} style={{ color: '#fff', fontSize: 16, lineHeight: 18 }}>{e2.title}</DisplayText>
                  </Pressable>
                ) : null}
              </View>
            </View>
          </View>
        )}

        {/* 7 · LOCAL DISCOVERY — a rich rail ─────────────────────────────────────── */}
        {lead && (
          <View style={{ marginTop: 28, backgroundColor: '#EDE3D2', paddingVertical: 24 }}>
            <SectionHead eyebrow="Discover something local" title="Who's open for business" color="#7C3AED" action="All" onAction={() => router.push('/local-businesses-browse')} />
            <Rail>
              <Pressable onPress={() => openBusiness(lead.id)} style={{ width: 262, height: 330, borderRadius: 24, overflow: 'hidden', backgroundColor: CAT_COLOR[lead.category] ?? '#4F46E5' }}>
                <CropImage uri={lead.cover_url ?? undefined} photo={lead.cover_url ? undefined : 'street'} crop={{ cx: 0.5, cy: 0.4, z: 1.2 }} style={StyleSheet.absoluteFill} />
                <Scrim dir="up" stops={[{ at: 0, color: CAT_COLOR[lead.category] ?? '#4F46E5', opacity: 0.97 }, { at: 0.45, color: CAT_COLOR[lead.category] ?? '#4F46E5', opacity: 0.75 }, { at: 1, color: CAT_COLOR[lead.category] ?? '#4F46E5', opacity: 0 }]} />
                {data?.fixtures.business.has(lead.id) && <TestBadge style={{ top: 14 }} />}
                <View style={{ position: 'absolute', left: 16, right: 16, bottom: 16 }}>
                  <View style={s.logoTile}>{lead.logo_url ? <Image source={{ uri: lead.logo_url }} style={{ width: 54, height: 54 }} resizeMode="contain" /> : <Text style={{ fontSize: 24, fontWeight: '900' }}>{lead.name[0]}</Text>}</View>
                  <Chip label={CAT_LABEL[lead.category] ?? 'Business'} />
                  <DisplayText weight="bold" style={{ color: '#fff', fontSize: 28, lineHeight: 30, marginTop: 8 }}>{lead.name}</DisplayText>
                  {!!lead.description && <Text numberOfLines={2} style={{ color: 'rgba(255,255,255,0.9)', fontSize: 13, lineHeight: 18, marginTop: 5 }}>{lead.description}</Text>}
                </View>
              </Pressable>
              {rest.map((b) => {
                const c = CAT_COLOR[b.category] ?? '#4F46E5';
                return (
                  <Pressable key={b.id} onPress={() => openBusiness(b.id)} style={{ width: 158, height: 200, borderRadius: 22, overflow: 'hidden', backgroundColor: c, padding: 14, justifyContent: 'space-between' }}>
                    <Scrim dir="diag" stops={[{ at: 0, color: c, opacity: 1 }, { at: 1, color: '#1E1B4B', opacity: 1 }]} />
                    {data?.fixtures.business.has(b.id) && <TestBadge style={{ top: 0 }} />}
                    <View style={[s.logoTile, { marginBottom: 0, marginTop: data?.fixtures.business.has(b.id) ? 14 : 0 }]}>{b.logo_url ? <Image source={{ uri: b.logo_url }} style={{ width: 46, height: 46 }} resizeMode="contain" /> : <Text style={{ fontSize: 20, fontWeight: '900' }}>{b.name[0]}</Text>}</View>
                    <View>
                      <Text style={{ color: 'rgba(255,255,255,0.78)', fontSize: 9.5, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase' }}>{CAT_LABEL[b.category] ?? 'Business'}</Text>
                      <DisplayText weight="bold" numberOfLines={2} style={{ color: '#fff', fontSize: 18, lineHeight: 20, marginTop: 2 }}>{b.name}</DisplayText>
                    </View>
                  </Pressable>
                );
              })}
            </Rail>
          </View>
        )}

        {/* 8 · SHOP · OFFERS · BOOK · EXPERIENCES ────────────────────────────────── */}
        <View style={{ backgroundColor: '#2E1065', paddingTop: 26, paddingBottom: 26 }}>
          <SectionHead eyebrow="Shop local" title="Shop · Offers · Book · Experiences" light action="Local" onAction={() => router.navigate('/(tabs)/local')} />
          <View style={{ paddingHorizontal: SIDE, flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
            {PILLAR_ORDER.map((p) => {
              const pl = PILLARS[p]; const n = commerce[p].length; const d = density(n);
              const gp = GATEWAY_PHOTO[p];
              return <GatewayTile key={p} label={pl.label} line={pl.short} chip={d === 'none' ? 'Opening soon' : `${n} ${NOUN[p][n === 1 ? 0 : 1]}`} photo={gp?.photo} crop={gp?.crop} from={pl.color} to={pl.deep} w={gw} h={172} onPress={() => router.push(PILLAR_ROUTE[p] as never)} />;
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
                <Pressable onPress={() => router.push(PILLAR_CTA_ROUTE as never)} style={{ alignSelf: 'flex-start', backgroundColor: '#fff', borderRadius: 99, paddingHorizontal: 16, paddingVertical: 9, marginTop: 12 }}><Text style={{ fontWeight: '800', fontSize: 13 }}>Be one of the first →</Text></Pressable>
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
            <Pressable onPress={() => router.navigate('/(tabs)/da-boats')} style={{ height: 210, borderRadius: 22, overflow: 'hidden' }}>
              <CropImage photo="boats" style={StyleSheet.absoluteFill} /><Scrim dir="up" stops={fade('#000', 0.85, 0.2, 0)} />
              <View style={{ position: 'absolute', left: 14, top: 14 }}><Chip label="Da Boats" bg="#1E3A8A" /></View>
              <View style={{ position: 'absolute', left: 16, bottom: 14 }}><DisplayText style={{ color: '#fff', fontSize: 30 }}>The fleet</DisplayText><Text style={{ color: 'rgba(255,255,255,0.82)', fontSize: 12, fontWeight: '600' }}>The fishing fleet, past and present</Text></View>
            </Pressable>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Pressable onPress={() => router.navigate('/(tabs)/memories')} style={{ width: gw, height: 190, borderRadius: 20, overflow: 'hidden' }}>
                <CropImage photo="memory" style={StyleSheet.absoluteFill} /><Scrim dir="up" stops={fade('#9F1239', 0.95, 0.35, 0)} />
                <View style={{ position: 'absolute', left: 12, top: 12 }}><Chip label="Aald Memories" bg="#9F1239" size={9} /></View>
                <DisplayText weight="bold" style={{ position: 'absolute', left: 12, right: 12, bottom: 12, color: '#fff', fontSize: 17, lineHeight: 19 }}>A story fae da isles</DisplayText>
              </Pressable>
              <View style={{ width: gw, gap: 12 }}>
                <Pressable onPress={() => router.navigate('/(tabs)/spik')} style={{ height: 89, borderRadius: 20, overflow: 'hidden', backgroundColor: '#0E7490', padding: 12, justifyContent: 'space-between' }}>
                  <Scrim dir="diag" stops={[{ at: 0, color: '#12B3D6', opacity: 1 }, { at: 1, color: '#0E7490', opacity: 1 }]} />
                  <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 9, fontWeight: '900', letterSpacing: 1 }}>WIRD O' DA DAY</Text>
                  <DisplayText style={{ color: '#fff', fontSize: 24, lineHeight: 26 }}>{data?.spik?.word ?? 'Spik'}</DisplayText>
                </Pressable>
                <Pressable onPress={() => router.push('/games')} style={{ height: 89, borderRadius: 20, overflow: 'hidden', backgroundColor: '#047857', padding: 12, justifyContent: 'space-between' }}>
                  <Scrim dir="diag" stops={[{ at: 0, color: '#10B981', opacity: 1 }, { at: 1, color: '#047857', opacity: 1 }]} />
                  <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 9, fontWeight: '900', letterSpacing: 1 }}>TODAY'S GAME</Text>
                  <DisplayText weight="bold" style={{ color: '#fff', fontSize: 17, lineHeight: 19 }}>Spik Sprint</DisplayText>
                </Pressable>
              </View>
            </View>
          </View>
        </View>

        {/* 10 · COMMUNITY / NOTICES — real only ──────────────────────────────────── */}
        <View style={{ paddingTop: 26 }}>
          <SectionHead eyebrow="Community" title="From the community" color="#6B47BF" action="Hubs" onAction={() => router.push('/hubs')} />
          <View style={{ paddingHorizontal: SIDE, gap: 12 }}>
            {(data?.notices ?? []).map((n) => (
              <Pressable key={n.id} onPress={() => router.push('/notices')} style={{ borderRadius: 22, padding: 18, backgroundColor: '#DDD6FE' }}>
                <Text style={{ color: '#6D28D9', fontSize: 10.5, fontWeight: '900', letterSpacing: 1, textTransform: 'uppercase' }}>{n.publisher}</Text>
                <DisplayText weight="bold" style={{ color: '#2E1065', fontSize: 23, lineHeight: 26, marginTop: 4 }}>{n.title}</DisplayText>
                <Text numberOfLines={3} style={{ color: '#4C1D95', fontSize: 13.5, lineHeight: 19, marginTop: 6 }}>{n.body}</Text>
              </Pressable>
            ))}
            {(data?.notices ?? []).length === 0 && (
              <Pressable onPress={() => router.push('/hubs')} style={{ borderRadius: 22, padding: 18, backgroundColor: '#EDE9FE' }}>
                <DisplayText weight="bold" style={{ color: '#2E1065', fontSize: 20 }}>Hubs bring clubs, groups and good causes together.</DisplayText>
              </Pressable>
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

/** Visitor-only front door to the day planner (app/plan-day.tsx). The form lives on that screen; this is the invitation. */
function PlanDayCard({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel="Plan my day. Tell us when you're free and what you fancy." style={{ marginHorizontal: SIDE, marginTop: 18, borderRadius: 24, overflow: 'hidden', padding: 18, backgroundColor: '#4C1D95' }}>
      <Scrim dir="diag" stops={[{ at: 0, color: '#7C3AED', opacity: 1 }, { at: 1, color: '#312E81', opacity: 1 }]} />
      <Chip label="Visiting Shetland" />
      <DisplayText weight="bold" style={{ color: '#fff', fontSize: 28, lineHeight: 30, marginTop: 8 }}>Plan my day</DisplayText>
      <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: 14, lineHeight: 20, marginTop: 5 }}>Tell us when you&apos;re free and what you fancy — Peerie Bot ✨ lays out a day with travel times and a map.</Text>
      <View style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderRadius: 99, paddingHorizontal: 18, paddingVertical: 11, marginTop: 14 }}>
        <Text style={{ color: '#4C1D95', fontSize: 13.5, fontWeight: '800' }}>Plan my day</Text>
        <FontAwesome5 name="arrow-right" size={11} color="#4C1D95" solid />
      </View>
    </Pressable>
  );
}

function ForYouCard({ t, onPress }: { t: ForYouTile; onPress: () => void }) {
  const [from, to] = TONE[t.tone];
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${t.tag}. ${t.headline}. ${t.detail}`} style={[s.fy, { backgroundColor: to }]}>
      <Scrim dir="diag" stops={[{ at: 0, color: from, opacity: 1 }, { at: 1, color: to, opacity: 1 }]} />
      <Chip label={t.tag} />
      <View>
        {t.big
          ? <DisplayText style={{ color: '#fff', fontSize: 34 }} numberOfLines={1}>{t.headline}</DisplayText>
          : <DisplayText weight="bold" numberOfLines={2} style={{ color: '#fff', fontSize: 22, lineHeight: 24 }}>{t.headline}</DisplayText>}
        <Text numberOfLines={2} style={s.fyLine}>{t.detail}</Text>
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  walletPill: { backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 99, paddingHorizontal: 11, height: 32, flexDirection: 'row', alignItems: 'center', marginRight: 6 },
  roundBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center', marginLeft: 6 },
  search: { flex: 1, backgroundColor: '#fff', borderRadius: 99, paddingHorizontal: 13, height: 40, flexDirection: 'row', alignItems: 'center' },
  mode: { height: 40, borderRadius: 99, paddingHorizontal: 12, backgroundColor: 'rgba(255,255,255,0.14)', flexDirection: 'row', alignItems: 'center' },
  nowStrip: { marginTop: 8, flexDirection: 'row', alignItems: 'center', height: 26, gap: 8 },
  nowChip: { backgroundColor: 'rgba(125,211,252,0.25)', borderRadius: 99, paddingHorizontal: 9, paddingVertical: 3 },
  nowChipText: { color: '#E0F2FE', fontSize: 11, fontWeight: '800' },
  urgentChip: { marginTop: 6, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#DC2626', borderRadius: 99, paddingHorizontal: 11, paddingVertical: 6, maxWidth: '100%' },
  fy: { width: 176, height: 150, borderRadius: 20, overflow: 'hidden', padding: 14, justifyContent: 'space-between' },
  fyLine: { color: 'rgba(255,255,255,0.88)', fontSize: 11.5, fontWeight: '600', marginTop: 3 },
  logoTile: { width: 58, height: 58, borderRadius: 14, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
});
