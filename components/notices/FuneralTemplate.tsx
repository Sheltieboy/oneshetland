/**
 * FuneralTemplate — the traditional announcement form for Deaths & Funeral Notices.
 * Quiet, newspaper / shop-window feel: serif name, ornamental rule, generous spacing, warm parchment and deep slate with a muted
 * burgundy accent. NO emergency colours, no promotion, no animation. Optional small oval portrait. Service details appear only when
 * the family approved publishing them (the model carries `service: null` otherwise).
 */
import React from 'react';
import { View, Text, Image, Pressable, StyleSheet, Platform, Linking } from 'react-native';
import type { FuneralNoticeModel } from '@/lib/funeral-notices';

export const FUNERAL = {
  parchment: '#F7F1E3', paper: '#FBF7EE', slate: '#2F3B47', slateSoft: '#566370', burgundy: '#7A3B45', rule: '#B9A98A', edge: '#DDD2BA',
} as const;
const SERIF = Platform.select({ ios: 'Georgia', android: 'serif', default: 'serif' });

/** Thin rule, small diamond, thin rule. */
export function OrnamentalRule({ width = 160 }: { width?: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', alignSelf: 'center', width, marginVertical: 14 }} accessibilityElementsHidden importantForAccessibility="no">
      <View style={{ flex: 1, height: 1, backgroundColor: FUNERAL.rule }} />
      <View style={{ width: 7, height: 7, marginHorizontal: 9, backgroundColor: FUNERAL.burgundy, transform: [{ rotate: '45deg' }] }} />
      <View style={{ flex: 1, height: 1, backgroundColor: FUNERAL.rule }} />
    </View>
  );
}

export function OvalPortrait({ uri, size = 96 }: { uri: string; size?: number }) {
  return (
    <Image
      source={{ uri }}
      accessibilityIgnoresInvertColors
      accessibilityLabel="Photograph"
      style={{ width: size, height: size * 1.3, borderRadius: size, alignSelf: 'center', borderWidth: 3, borderColor: FUNERAL.edge, backgroundColor: FUNERAL.edge }}
      resizeMode="cover"
    />
  );
}

/** A row in the list: a small announcement card. */
export function FuneralListCard({ f, onPress }: { f: FuneralNoticeModel; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Funeral notice: ${f.fullName}${f.dates ? '. ' + f.dates : ''}`}
      style={s.listCard}
    >
      {f.photoUrl ? <OvalPortrait uri={f.photoUrl} size={56} /> : null}
      <View style={{ flex: 1 }}>
        <Text style={s.listName} numberOfLines={2}>{f.fullName}</Text>
        {f.dates ? <Text style={s.listDates}>{f.dates}</Text> : null}
        {f.announcement ? <Text style={s.listText} numberOfLines={2}>{f.announcement}</Text> : null}
        {f.areaName ? <Text style={s.listArea}>{f.areaName}</Text> : null}
      </View>
    </Pressable>
  );
}

/** The full announcement. */
export function FuneralAnnouncement({ f }: { f: FuneralNoticeModel }) {
  return (
    <View style={s.sheet}>
      <Text style={s.eyebrow}>IN MEMORIAM</Text>
      <OrnamentalRule />
      {f.photoUrl ? <View style={{ marginBottom: 14 }}><OvalPortrait uri={f.photoUrl} size={104} /></View> : null}
      <Text style={s.name} accessibilityRole="header">{f.fullName}</Text>
      {f.knownAs ? <Text style={s.known}>known as {f.knownAs}</Text> : null}
      {f.dates ? <Text style={s.dates}>{f.dates}</Text> : null}
      {f.areaName ? <Text style={s.area}>{f.areaName}</Text> : null}
      <OrnamentalRule />
      {f.announcement ? <Text style={s.body}>{f.announcement}</Text> : null}

      {f.service ? (
        <Section title="The service">
          {f.service.kind ? <Text style={s.detailStrong}>{f.service.kind}</Text> : null}
          {f.service.when ? <Text style={s.detail}>{f.service.when}</Text> : null}
          {f.service.venue ? <Text style={s.detail}>{f.service.venue}</Text> : null}
          {f.service.notes ? <Text style={s.detail}>{f.service.notes}</Text> : null}
        </Section>
      ) : null}

      {f.familyRequests ? <Section title="Family requests"><Text style={s.detail}>{f.familyRequests}</Text></Section> : null}

      {f.donationInfo || f.donationUrl ? (
        <Section title="Donations">
          {f.donationInfo ? <Text style={s.detail}>{f.donationInfo}</Text> : null}
          {f.donationUrl ? (
            <Pressable onPress={() => { Linking.openURL(f.donationUrl as string).catch(() => {}); }} accessibilityRole="link" style={s.linkBtn}>
              <Text style={s.link}>Donation page</Text>
            </Pressable>
          ) : null}
        </Section>
      ) : null}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  listCard: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: FUNERAL.parchment, borderRadius: 6, borderWidth: 1, borderColor: FUNERAL.edge, padding: 16, minHeight: 64 },
  listName: { fontFamily: SERIF, fontSize: 19, lineHeight: 25, color: FUNERAL.slate },
  listDates: { fontFamily: SERIF, fontSize: 13.5, color: FUNERAL.slateSoft, marginTop: 2 },
  listText: { fontSize: 13.5, lineHeight: 19, color: FUNERAL.slateSoft, marginTop: 6 },
  listArea: { fontSize: 12, color: FUNERAL.burgundy, marginTop: 6, letterSpacing: 0.3 },

  sheet: { backgroundColor: FUNERAL.parchment, borderRadius: 6, borderWidth: 1, borderColor: FUNERAL.edge, paddingHorizontal: 24, paddingVertical: 28 },
  eyebrow: { textAlign: 'center', fontFamily: SERIF, fontSize: 12, letterSpacing: 4, color: FUNERAL.burgundy },
  name: { textAlign: 'center', fontFamily: SERIF, fontSize: 30, lineHeight: 38, color: FUNERAL.slate },
  known: { textAlign: 'center', fontFamily: SERIF, fontSize: 15, fontStyle: 'italic', color: FUNERAL.slateSoft, marginTop: 4 },
  dates: { textAlign: 'center', fontFamily: SERIF, fontSize: 16, color: FUNERAL.slateSoft, marginTop: 10 },
  area: { textAlign: 'center', fontSize: 13, color: FUNERAL.burgundy, marginTop: 6, letterSpacing: 0.4 },
  body: { fontFamily: SERIF, fontSize: 17, lineHeight: 28, color: FUNERAL.slate, textAlign: 'center' },
  section: { marginTop: 26, paddingTop: 18, borderTopWidth: 1, borderTopColor: FUNERAL.edge, alignItems: 'center', gap: 4 },
  sectionTitle: { fontFamily: SERIF, fontSize: 12, letterSpacing: 3, textTransform: 'uppercase', color: FUNERAL.burgundy, marginBottom: 6 },
  detail: { fontFamily: SERIF, fontSize: 16, lineHeight: 25, color: FUNERAL.slate, textAlign: 'center' },
  detailStrong: { fontFamily: SERIF, fontSize: 17, lineHeight: 25, color: FUNERAL.slate, textAlign: 'center', fontWeight: '700' },
  linkBtn: { minHeight: 44, justifyContent: 'center' },
  link: { fontSize: 14, color: FUNERAL.burgundy, textDecorationLine: 'underline' },
});
