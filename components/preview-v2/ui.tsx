import React, { useId, useState } from 'react';
import { View, Text, Image, Pressable, ScrollView, StyleSheet, LayoutChangeEvent, ViewStyle, StyleProp } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import { DisplayText } from '../DisplayText';
import { PHOTOS } from './images';
import { PILLARS, density, type Merch, type Pillar, type Crop } from './model';

/**
 * Shared building blocks for the App Home V2 / Local V2 design previews. Preview only.
 *
 *   CropImage   exact crop of a photograph (one still-life becomes a dozen products)
 *   Scrim       SVG gradient overlay (the app has no gradient library)
 *   MerchCard   one item shaped for its pillar
 *   PillarSection  a pillar at ANY inventory level: none → proposition panel, 1–3 → feature + rail, 4–12 → rail,
 *                  13+ → rail with categories and a see-all tail
 */

export const SIDE = 16;

/* ── Gradient scrim ───────────────────────────────────────────────────────── */

type Stp = { at: number; color: string; opacity: number };
export function Scrim({ stops, dir = 'up', style }: { stops: Stp[]; dir?: 'up' | 'down' | 'right' | 'diag'; style?: StyleProp<ViewStyle> }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [x1, y1, x2, y2] = dir === 'up' ? [0, 1, 0, 0] : dir === 'down' ? [0, 0, 0, 1] : dir === 'right' ? [0, 0, 1, 0] : [0, 0, 1, 1];
  return (
    <Svg style={[StyleSheet.absoluteFill, style]} pointerEvents="none">
      <Defs>
        <LinearGradient id={id} x1={x1} y1={y1} x2={x2} y2={y2}>
          {stops.map((s, i) => <Stop key={i} offset={s.at} stopColor={s.color} stopOpacity={s.opacity} />)}
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}
export const fade = (color: string, from = 0.9, mid = 0.35, to = 0): Stp[] => [
  { at: 0, color, opacity: from }, { at: 0.55, color, opacity: mid }, { at: 1, color, opacity: to },
];

/* ── Exact crop ───────────────────────────────────────────────────────────── */

export function CropImage({ photo, uri, crop, style }: { photo?: keyof typeof PHOTOS; uri?: string; crop?: Crop; style?: StyleProp<ViewStyle> }) {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const onLayout = (e: LayoutChangeEvent) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });
  let inner: React.ReactNode = null;
  if (box && (photo || uri)) {
    if (uri || !photo) {
      inner = <Image source={{ uri }} style={{ width: box.w, height: box.h }} resizeMode="cover" />;
    } else {
      const p = PHOTOS[photo];
      const c = crop ?? { cx: 0.5, cy: 0.5, z: 1 };
      const cover = Math.max(box.w / p.w, box.h / p.h) * c.z;
      const w = p.w * cover, h = p.h * cover;
      const left = Math.min(0, Math.max(box.w - w, box.w / 2 - c.cx * w));
      const top = Math.min(0, Math.max(box.h - h, box.h / 2 - c.cy * h));
      inner = <Image source={p.src} style={{ position: 'absolute', width: w, height: h, left, top }} resizeMode="stretch" />;
    }
  }
  return <View style={[{ overflow: 'hidden', backgroundColor: '#E5E7EB' }, style]} onLayout={onLayout}>{inner}</View>;
}

/* ── Small parts ──────────────────────────────────────────────────────────── */

export function TestRibbon({ tag }: { tag: 'TEST' | 'QA' }) {
  return (
    <View style={s.ribbon}>
      <Text style={s.ribbonText}>{tag} · ADMIN ONLY</Text>
    </View>
  );
}

export function Chip({ label, color = '#fff', bg = 'rgba(255,255,255,0.2)', size = 10 }: { label: string; color?: string; bg?: string; size?: number }) {
  return (
    <View style={{ alignSelf: 'flex-start', backgroundColor: bg, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 4 }}>
      <Text style={{ color, fontSize: size, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' }}>{label}</Text>
    </View>
  );
}

export function SectionHead({ eyebrow, title, color = '#6B7280', light = false, action }: { eyebrow?: string; title: string; color?: string; light?: boolean; action?: string }) {
  return (
    <View style={{ paddingHorizontal: SIDE, marginBottom: 12, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
      <View style={{ flex: 1, paddingRight: 12 }}>
        {!!eyebrow && <Text style={{ color: light ? 'rgba(255,255,255,0.75)' : color, fontSize: 11, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase' }}>{eyebrow}</Text>}
        <DisplayText weight="bold" style={{ color: light ? '#fff' : '#0F1C26', fontSize: 26, lineHeight: 29, marginTop: 3 }}>{title}</DisplayText>
      </View>
      {!!action && (
        <View style={{ borderWidth: 1, borderColor: light ? 'rgba(255,255,255,0.45)' : '#CBD5E1', borderRadius: 99, paddingHorizontal: 12, paddingVertical: 7 }}>
          <Text style={{ color: light ? '#fff' : '#374151', fontSize: 12, fontWeight: '800' }}>{action} →</Text>
        </View>
      )}
    </View>
  );
}

export function Rail({ children, gap = 12 }: { children: React.ReactNode; gap?: number }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: SIDE, gap }} decelerationRate="fast">
      {children}
    </ScrollView>
  );
}

/* ── One item ─────────────────────────────────────────────────────────────── */

const qa = (m: Merch): ViewStyle => (m.tag ? { borderWidth: 2, borderStyle: 'dashed', borderColor: '#FBBF24' } : {});

export function MerchCard({ m, dark = false, width, notch = '#F6F1E8' }: { m: Merch; dark?: boolean; width?: number; notch?: string }) {
  const p = PILLARS[m.pillar];
  if (m.pillar === 'shop') {
    const w = width ?? 152;
    return (
      <View style={[{ width: w, borderRadius: 18 }, qa(m)]}>
        <View style={{ width: w, height: w * 1.25, borderRadius: 16, overflow: 'hidden' }}>
          {m.photo || m.uri
            ? <CropImage photo={m.photo} uri={m.uri} crop={m.crop} style={StyleSheet.absoluteFill} />
            : <View style={[StyleSheet.absoluteFill, { backgroundColor: p.color, alignItems: 'center', justifyContent: 'center', padding: 10 }]}><DisplayText weight="bold" style={{ color: '#fff', fontSize: 16, textAlign: 'center' }}>{m.title}</DisplayText></View>}
          <Scrim dir="up" stops={fade('#000', 0.45, 0.1, 0)} />
          {!!m.tag && <TestRibbon tag={m.tag} />}
          {!!m.price && <View style={s.pricePill}><Text style={s.pricePillText}>{m.price}</Text></View>}
        </View>
        <DisplayText weight="bold" numberOfLines={2} style={{ marginTop: 8, fontSize: 16, lineHeight: 19, color: dark ? '#fff' : '#0F1C26' }}>{m.title}</DisplayText>
        <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 11, fontWeight: '600', color: dark ? 'rgba(255,255,255,0.7)' : '#6B7280' }}>{m.business}</Text>
      </View>
    );
  }
  if (m.pillar === 'offers') {
    const w = width ?? 224;
    return (
      <View style={[{ width: w, height: 168, borderRadius: 18, overflow: 'hidden', backgroundColor: p.color, padding: 16, justifyContent: 'space-between' }, qa(m)]}>
        <Scrim dir="diag" stops={[{ at: 0, color: p.color, opacity: 1 }, { at: 1, color: p.deep, opacity: 1 }]} />
        {!!m.tag && <TestRibbon tag={m.tag} />}
        <DisplayText style={{ color: '#fff', fontSize: 34, lineHeight: 36, marginTop: m.tag ? 14 : 0 }}>{m.badge ?? 'Offer'}</DisplayText>
        <View>
          <Text numberOfLines={2} style={{ color: '#fff', fontSize: 15, fontWeight: '700', lineHeight: 19 }}>{m.title}</Text>
          <Text numberOfLines={1} style={{ color: 'rgba(255,255,255,0.8)', fontSize: 11, fontWeight: '600', marginTop: 3 }}>{m.business}{m.meta ? ` · ${m.meta}` : ''}</Text>
        </View>
        {/* ticket notches */}
        <View style={[s.notch, { left: -9, backgroundColor: notch }]} /><View style={[s.notch, { right: -9, backgroundColor: notch }]} />
      </View>
    );
  }
  if (m.pillar === 'book') {
    const w = width ?? 208;
    const mins = m.meta?.match(/\d+/)?.[0];
    return (
      <View style={[{ width: w, borderRadius: 18, overflow: 'hidden', backgroundColor: '#fff', borderWidth: 1, borderColor: '#E5E9EF' }, qa(m)]}>
        <View style={{ height: 78, backgroundColor: p.color, padding: 12, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <Scrim dir="diag" stops={[{ at: 0, color: p.color, opacity: 1 }, { at: 1, color: p.deep, opacity: 1 }]} />
          {!!m.tag && <TestRibbon tag={m.tag} />}
          <DisplayText style={{ color: '#fff', fontSize: 40, lineHeight: 42 }}>{mins ?? '·'}<Text style={{ fontSize: 14, fontWeight: '700' }}> min</Text></DisplayText>
          {!!m.badge && <View style={{ backgroundColor: 'rgba(255,255,255,0.22)', borderRadius: 99, paddingHorizontal: 8, paddingVertical: 4 }}><Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>{m.badge}</Text></View>}
        </View>
        <View style={{ padding: 12 }}>
          <DisplayText weight="bold" numberOfLines={2} style={{ fontSize: 16, lineHeight: 19, color: '#0F1C26' }}>{m.title}</DisplayText>
          <Text numberOfLines={1} style={{ marginTop: 2, fontSize: 11, fontWeight: '600', color: '#6B7280' }}>{m.business}</Text>
          <View style={{ marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={{ fontSize: 14, fontWeight: '900', color: '#0F1C26' }}>{m.price}</Text>
            <View style={{ backgroundColor: p.color, borderRadius: 99, paddingHorizontal: 14, paddingVertical: 6 }}><Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>Book</Text></View>
          </View>
        </View>
      </View>
    );
  }
  const w = width ?? 268;
  return (
    <View style={[{ width: w, height: 188, borderRadius: 18, overflow: 'hidden' }, qa(m)]}>
      {m.photo || m.uri
        ? <CropImage photo={m.photo} uri={m.uri} crop={m.crop} style={StyleSheet.absoluteFill} />
        : <View style={[StyleSheet.absoluteFill, { backgroundColor: p.color }]} />}
      <Scrim dir="up" stops={fade('#000', 0.82, 0.25, 0)} />
      {!!m.tag && <TestRibbon tag={m.tag} />}
      {!!m.price && <View style={[s.pricePill, { left: undefined, right: 10, top: 10, bottom: undefined }]}><Text style={s.pricePillText}>{m.price}</Text></View>}
      <View style={{ position: 'absolute', left: 14, right: 14, bottom: 12 }}>
        <DisplayText weight="bold" numberOfLines={2} style={{ color: '#fff', fontSize: 19, lineHeight: 21 }}>{m.title}</DisplayText>
        <Text numberOfLines={1} style={{ color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '600', marginTop: 3 }}>{m.business}{m.meta ? ` · ${m.meta}` : ''}</Text>
      </View>
    </View>
  );
}

/* ── A pillar at any inventory level ──────────────────────────────────────── */

export function PillarEmpty({ pillar, width }: { pillar: Pillar; width: number }) {
  const p = PILLARS[pillar];
  return (
    <View style={{ marginHorizontal: SIDE, width: width - SIDE * 2, borderRadius: 22, overflow: 'hidden', padding: 20, minHeight: 230, justifyContent: 'flex-end' }}>
      <CropImage photo={p.photo} crop={p.crop} style={StyleSheet.absoluteFill} />
      <Scrim dir="right" stops={[{ at: 0, color: p.deep, opacity: 0.95 }, { at: 0.7, color: p.deep, opacity: 0.8 }, { at: 1, color: p.color, opacity: 0.55 }]} />
      <Chip label="Opening soon" />
      <DisplayText weight="bold" style={{ color: '#fff', fontSize: 26, lineHeight: 28, marginTop: 10 }}>{p.emptyTitle}</DisplayText>
      <Text style={{ color: 'rgba(255,255,255,0.88)', fontSize: 14, lineHeight: 20, marginTop: 6 }}>{p.emptyBody}</Text>
      <View style={{ alignSelf: 'flex-start', backgroundColor: '#fff', borderRadius: 99, paddingHorizontal: 16, paddingVertical: 9, marginTop: 14 }}>
        <Text style={{ fontSize: 13, fontWeight: '800', color: '#0F1C26' }}>{p.cta} →</Text>
      </View>
    </View>
  );
}

function FeatureTile({ m, width }: { m: Merch; width: number }) {
  const p = PILLARS[m.pillar];
  const w = width - SIDE * 2;
  return (
    <View style={[{ marginHorizontal: SIDE, width: w, height: 300, borderRadius: 22, overflow: 'hidden', backgroundColor: p.color }, qa(m)]}>
      {m.photo || m.uri ? <CropImage photo={m.photo} uri={m.uri} crop={m.crop} style={StyleSheet.absoluteFill} /> : <Scrim dir="diag" stops={[{ at: 0, color: p.color, opacity: 1 }, { at: 1, color: p.deep, opacity: 1 }]} />}
      <Scrim dir="up" stops={fade('#000', 0.85, 0.25, 0.02)} />
      {!!m.tag && <TestRibbon tag={m.tag} />}
      {!(m.photo || m.uri) && (m.pillar === 'book' ? m.meta : m.badge) ? <DisplayText style={{ position: 'absolute', right: 18, top: 16, color: '#fff', fontSize: 46 }}>{m.pillar === 'book' ? m.meta : m.badge}</DisplayText> : null}
      <View style={{ position: 'absolute', left: 18, right: 18, bottom: 18 }}>
        <Chip label={p.label} />
        <DisplayText weight="bold" style={{ color: '#fff', fontSize: 30, lineHeight: 32, marginTop: 8 }}>{m.title}</DisplayText>
        <Text style={{ color: 'rgba(255,255,255,0.88)', fontSize: 13, fontWeight: '600', marginTop: 4 }}>{m.business}{m.meta ? ` · ${m.meta}` : ''}</Text>
        {!!m.price && <View style={{ alignSelf: 'flex-start', backgroundColor: '#fff', borderRadius: 99, paddingHorizontal: 14, paddingVertical: 6, marginTop: 10 }}><Text style={{ fontSize: 14, fontWeight: '900', color: '#0F1C26' }}>{m.price}</Text></View>}
      </View>
    </View>
  );
}

export function PillarSection({ pillar, items, width, dark = false, notch }: { pillar: Pillar; items: Merch[]; width: number; dark?: boolean; notch?: string }) {
  const p = PILLARS[pillar];
  const d = density(items.length);
  return (
    <View>
      <SectionHead eyebrow={p.short} title={p.heading} color={p.color} light={dark} action={d === 'none' ? undefined : d === 'many' ? `See all ${items.length}` : 'See all'} />
      {d === 'none' && <PillarEmpty pillar={pillar} width={width} />}
      {d === 'few' && (
        <View style={{ gap: 12 }}>
          <FeatureTile m={items[0]} width={width} />
          {items.length > 1 && <Rail>{items.slice(1).map((m) => <MerchCard key={m.id} m={m} dark={dark} notch={notch} />)}</Rail>}
        </View>
      )}
      {(d === 'rail' || d === 'many') && (
        <View style={{ gap: 12 }}>
          {d === 'many' && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: SIDE, gap: 8 }}>
              <View style={{ backgroundColor: p.color, borderRadius: 99, paddingHorizontal: 13, paddingVertical: 7 }}><Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>All {items.length}</Text></View>
              {p.cats.map((c) => <View key={c} style={{ borderWidth: 1, borderColor: dark ? 'rgba(255,255,255,0.35)' : '#CBD5E1', borderRadius: 99, paddingHorizontal: 13, paddingVertical: 7 }}><Text style={{ color: dark ? 'rgba(255,255,255,0.9)' : '#374151', fontSize: 12, fontWeight: '700' }}>{c}</Text></View>)}
            </ScrollView>
          )}
          <Rail>
            {items.slice(0, 12).map((m) => <MerchCard key={m.id} m={m} dark={dark} notch={notch} />)}
            {d === 'many' && (
              <View style={{ width: 130, borderRadius: 18, borderWidth: 2, borderStyle: 'dashed', borderColor: dark ? 'rgba(255,255,255,0.5)' : p.color, alignItems: 'center', justifyContent: 'center', padding: 12 }}>
                <Text style={{ color: dark ? '#fff' : p.color, fontSize: 13, fontWeight: '800', textAlign: 'center' }}>See all {items.length}</Text>
                <Text style={{ color: dark ? '#fff' : p.color, fontSize: 24, marginTop: 4 }}>→</Text>
              </View>
            )}
          </Rail>
        </View>
      )}
    </View>
  );
}

/* ── Gateway tile (photo-led) ─────────────────────────────────────────────── */

export function GatewayTile({ label, line, chip, photo, crop, from, to, w, h, big = false, children }: {
  label: string; line: string; chip: string; photo?: keyof typeof PHOTOS; crop?: Crop; from: string; to: string; w: number; h: number; big?: boolean; children?: React.ReactNode;
}) {
  return (
    <View style={{ width: w, height: h, borderRadius: 20, overflow: 'hidden', backgroundColor: from }}>
      {photo ? <CropImage photo={photo} crop={crop} style={StyleSheet.absoluteFill} /> : <Scrim dir="diag" stops={[{ at: 0, color: from, opacity: 1 }, { at: 1, color: to, opacity: 1 }]} />}
      <Scrim dir="up" stops={[{ at: 0, color: to, opacity: 0.95 }, { at: 0.5, color: to, opacity: 0.55 }, { at: 1, color: from, opacity: 0.1 }]} />
      {children}
      <View style={{ position: 'absolute', left: 14, right: 12, bottom: 12 }}>
        <DisplayText weight="bold" style={{ color: '#fff', fontSize: big ? 36 : 25, lineHeight: big ? 38 : 27 }}>{label}</DisplayText>
        <Text numberOfLines={2} style={{ color: 'rgba(255,255,255,0.88)', fontSize: 11, lineHeight: 14, fontWeight: '600', marginTop: 3 }}>{line}</Text>
        <View style={{ alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.22)', borderRadius: 99, paddingHorizontal: 10, paddingVertical: 4, marginTop: 8 }}>
          <Text style={{ color: '#fff', fontSize: 10.5, fontWeight: '800' }}>{chip} →</Text>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  ribbon: { position: 'absolute', left: 0, top: 10, zIndex: 5, backgroundColor: '#FACC15', borderTopRightRadius: 6, borderBottomRightRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  ribbonText: { color: '#000', fontSize: 9, fontWeight: '900', letterSpacing: 0.8 },
  pricePill: { position: 'absolute', left: 10, bottom: 10, backgroundColor: '#fff', borderRadius: 99, paddingHorizontal: 11, paddingVertical: 4 },
  pricePillText: { fontSize: 13, fontWeight: '900', color: '#0F1C26' },
  notch: { position: 'absolute', top: 74, width: 18, height: 18, borderRadius: 9, backgroundColor: '#F6F1E8' },
});
