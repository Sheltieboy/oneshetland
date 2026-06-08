/**
 * app/boat/[id].tsx
 *
 * Vessel profile — scrapbook redesign for an older audience.
 *
 * Same data as before, but presented like a memorial card rather than a
 * database record:
 *   * 32 px hero name, 18 px body, no faint grey metas
 *   * Plain-English section labels: "Names she went by", "Numbers she
 *     carried", "Owners through the years", "Her size", "Photos",
 *     "Her story", "How we know"
 *   * Confidence chips read as full English ("Almost certain") not as DB
 *     enum slugs
 *   * Save heart in the header — toggles AsyncStorage-backed saved list
 *   * pushRecentBoat() fires on first load so the landing's "You looked
 *     at" row picks the vessel up
 *   * Evidence drawer (now "How we know") is even further out of the way
 *     — collapsed by default, plain wording, monospace raw text only
 *     visible when expanded
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator,
  TouchableOpacity, Image, Linking, Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS } from '@/constants/sections';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import {
  fetchVesselProfile, fetchVesselTimeline,
  VesselProfile, VesselTimelineEntry, Confidence,
  vesselDisplayTitle, hullMaterialLabel, eventTypeLabel, confidenceLabel,
} from '@/lib/boats-api';
import {
  isBoatSaved, toggleSavedBoat, pushRecentBoat,
} from '@/lib/boats-prefs';

const SECTION = SECTIONS.daBoats;

const CONFIDENCE_TONE: Record<Confidence, { bg: string; text: string }> = {
  confirmed: { bg: '#D1FAE5', text: '#065F46' },
  probable:  { bg: '#DBEAFE', text: '#1E3A8A' },
  possible:  { bg: '#FEF3C7', text: '#92400E' },
  unmatched: { bg: '#E5E7EB', text: '#374151' },
  conflict:  { bg: '#FEE2E2', text: '#991B1B' },
};

export default function BoatProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [profile, setProfile]       = useState<VesselProfile | null>(null);
  const [timeline, setTimeline]     = useState<VesselTimelineEntry[]>([]);
  const [loading, setLoading]       = useState(true);
  const [saved, setSaved]           = useState(false);
  const [showEvidence, setShowEv]   = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [p, t, isSaved] = await Promise.all([
        fetchVesselProfile(id),
        fetchVesselTimeline(id),
        isBoatSaved(id),
      ]);
      setProfile(p);
      setTimeline(t);
      setSaved(isSaved);

      // Stash a stub on the recently-viewed list for the landing screen.
      if (p) {
        const heroUrl = p.media.find(m => m.media?.image_url)?.media?.image_url ?? null;
        void pushRecentBoat({
          id: p.vessel.id,
          lk_number: p.vessel.primary_lk_number,
          canonical_name: p.vessel.canonical_name,
          built_year: p.vessel.built_year,
          hero_url: heroUrl,
        });
      }
    } catch {
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const handleSaveToggle = async () => {
    if (!profile) return;
    const heroUrl = profile.media.find(m => m.media?.image_url)?.media?.image_url ?? null;
    const isNowSaved = await toggleSavedBoat({
      id: profile.vessel.id,
      lk_number: profile.vessel.primary_lk_number,
      canonical_name: profile.vessel.canonical_name,
      built_year: profile.vessel.built_year,
      hero_url: heroUrl,
    });
    setSaved(isNowSaved);
  };

  const handleShare = async () => {
    if (!profile) return;
    const title = vesselDisplayTitle(profile.vessel);
    try {
      await Share.share({
        message: `Looking at ${title} on OneShetland — Da Boats heritage register.`,
      });
    } catch { /* user cancelled */ }
  };

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, styles.center]}>
        <ActivityIndicator color={SECTION.color} size="large" />
      </SafeAreaView>
    );
  }
  if (!profile) {
    return (
      <SafeAreaView style={[styles.container, styles.center]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={styles.bodyMuted}>Couldn't find that boat.</Text>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtnSmall}>
          <Text style={styles.backBtnSmallText}>Go back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const { vessel, names, registrations, ownerships, events, measurements, media, evidence } = profile;
  const title = vesselDisplayTitle(vessel);
  const hull  = hullMaterialLabel(vessel.hull_material);
  const heroPhoto = media.find(m => m.media?.image_url)?.media;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Top bar */}
        <View style={styles.topBar}>
          <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} hitSlop={12}>
            <FontAwesome5 name="chevron-left" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <TouchableOpacity onPress={handleShare} style={styles.iconBtn} hitSlop={12}>
            <FontAwesome5 name="share-alt" size={20} color={colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleSaveToggle} style={styles.iconBtn} hitSlop={12}>
            <FontAwesome5
              name="heart"
              size={22}
              color={saved ? SECTION.color : colors.textSecondary}
              solid={saved}
            />
          </TouchableOpacity>
        </View>

        {/* Hero photo — proper aspect ratio, edge-to-edge */}
        {heroPhoto?.image_url ? (
          <View style={styles.heroWrap}>
            <Image source={{ uri: heroPhoto.image_url }} style={styles.hero} resizeMode="cover" />
          </View>
        ) : (
          <View style={styles.heroPlaceholder}>
            <FontAwesome5 name="ship" size={64} color={SECTION.color} />
          </View>
        )}

        {/* Name + LK */}
        <View style={styles.headerBlock}>
          <Text style={[styles.lk, { color: SECTION.color }]}>
            {vessel.primary_lk_number ?? 'No LK number on file'}
          </Text>
          <Text style={styles.title}>{vessel.canonical_name}</Text>
          {(vessel.built_year || hull) ? (
            <Text style={styles.subtitle}>
              {vessel.built_year ? `Built ${vessel.built_year}` : 'Year unknown'}
              {hull ? `  ·  ${hull} hull` : ''}
              {vessel.builder ? `  ·  ${vessel.builder}` : ''}
            </Text>
          ) : null}
        </View>

        {/* Confidence callout — explains what level of certainty we're at */}
        <View style={[
          styles.confCallout,
          { backgroundColor: CONFIDENCE_TONE[vessel.identity_confidence].bg },
        ]}>
          <FontAwesome5
            name={vessel.identity_confidence === 'confirmed' ? 'check-circle' : 'info-circle'}
            size={16}
            color={CONFIDENCE_TONE[vessel.identity_confidence].text}
            solid
          />
          <Text style={[styles.confCalloutText, { color: CONFIDENCE_TONE[vessel.identity_confidence].text }]}>
            {confidenceText(vessel.identity_confidence)}
          </Text>
        </View>

        {/* Names she went by */}
        {names.length ? (
          <Section title="Names she went by" subtitle={names.length === 1 ? '' : `${names.length} known`}>
            {names.map(n => (
              <BigRow
                key={n.id}
                primary={n.name}
                secondary={fmtYears(n.start_year, n.end_year, n.date_text)}
                badge={n.is_primary ? 'main name' : undefined}
                confidence={n.confidence}
              />
            ))}
          </Section>
        ) : null}

        {/* Numbers she carried */}
        {registrations.length ? (
          <Section title="Numbers she carried" subtitle={registrations.length === 1 ? '' : `${registrations.length} known`}>
            {registrations.map(r => (
              <BigRow
                key={r.id}
                primary={r.registration}
                secondary={fmtYears(r.start_year, r.end_year, r.date_text)}
                pillColor={SECTION.color}
                badge={r.is_primary ? 'main number' : undefined}
                confidence={r.confidence}
              />
            ))}
          </Section>
        ) : null}

        {/* Owners through the years */}
        {ownerships.length ? (
          <Section title="Owners through the years">
            {ownerships.map(o => (
              <BigRow
                key={o.id}
                primary={o.owner?.name ?? 'Unknown owner'}
                secondary={fmtYears(o.start_year, o.end_year, o.date_text) || (o.notes ?? '')}
                confidence={o.confidence}
              />
            ))}
          </Section>
        ) : null}

        {/* Her size */}
        {measurements.length ? (
          <Section title="Her size">
            {measurements.map(m => {
              const bits: string[] = [];
              if (m.length_m)      bits.push(`${Number(m.length_m).toFixed(1)} m long`);
              if (m.tonnage_text)  bits.push(m.tonnage_text);
              else if (m.tonnage)  bits.push(`${m.tonnage} tons`);
              if (m.engine_power_kw) bits.push(`${m.engine_power_kw} kW`);
              return (
                <BigRow
                  key={m.id}
                  primary={bits.join('  ·  ') || 'Measurement on record'}
                  secondary={[m.measurement_year, m.notes].filter(Boolean).join(' · ')}
                />
              );
            })}
          </Section>
        ) : null}

        {/* Photos */}
        {media.length ? (
          <Section
            title="Photos"
            subtitle={
              media.filter(m => m.media?.image_url).length === 0
                ? 'Photo references only — tap to find the original'
                : `${media.length} on file`
            }
          >
            <View style={styles.photoGrid}>
              {media.map(link => {
                const mm = link.media;
                if (!mm) return null;
                return (
                  <TouchableOpacity
                    key={link.id}
                    style={styles.photoTile}
                    onPress={() => mm.page_url ? Linking.openURL(mm.page_url) : null}
                    activeOpacity={mm.page_url ? 0.85 : 1}
                  >
                    {mm.image_url ? (
                      <Image source={{ uri: mm.image_url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                    ) : (
                      <View style={styles.photoPlaceholder}>
                        <FontAwesome5 name="camera" size={22} color={SECTION.color} />
                        <Text style={styles.photoPlaceholderText} numberOfLines={2}>
                          {mm.external_ref ?? 'See original'}
                        </Text>
                      </View>
                    )}
                    {mm.page_url && !mm.image_url ? (
                      <View style={styles.photoCatalogue}>
                        <FontAwesome5 name="external-link-alt" size={9} color="#fff" />
                      </View>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          </Section>
        ) : null}

        {/* Her story (timeline) */}
        {timeline.length ? (
          <Section title="Her story" subtitle="Through the years">
            {timeline.map((t, i) => (
              <View key={i} style={styles.timelineRow}>
                <View style={[styles.year, { backgroundColor: SECTION.light }]}>
                  <Text style={[styles.yearText, { color: SECTION.color }]}>{t.year ?? '—'}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.timelineEvent}>{eventTypeLabel(t.item_type)}</Text>
                  <Text style={styles.timelineDesc}>{t.description}</Text>
                  {t.date_text ? (
                    <Text style={styles.timelineMeta}>{t.date_text}</Text>
                  ) : null}
                </View>
              </View>
            ))}
          </Section>
        ) : null}

        {/* How we know (evidence drawer) */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>How we know</Text>
          <Text style={styles.sectionSubtitle}>
            Every fact above came from one of these sources. Tap to see the raw record.
          </Text>
          <TouchableOpacity
            onPress={() => setShowEv(s => !s)}
            style={[styles.drawerToggle, { backgroundColor: SECTION.light }]}
          >
            <FontAwesome5
              name={showEvidence ? 'chevron-down' : 'chevron-right'}
              size={14}
              color={SECTION.color}
            />
            <Text style={[styles.drawerToggleText, { color: SECTION.color }]}>
              {showEvidence
                ? 'Hide sources'
                : `Show ${evidence.length} source${evidence.length === 1 ? '' : 's'}`}
            </Text>
          </TouchableOpacity>

          {showEvidence ? (
            <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
              {evidence.map(ev => {
                const sr = ev.source_record;
                const doc = (sr as any)?.document;
                return (
                  <View key={ev.id} style={styles.evidenceCard}>
                    <View style={styles.evidenceTopRow}>
                      <Text style={styles.evidenceType} numberOfLines={1}>
                        {humaniseRecordType(sr?.record_type ?? '')}
                      </Text>
                      <ConfidencePill value={ev.confidence} />
                    </View>
                    {sr?.raw_text ? (
                      <Text style={styles.evidenceRaw} numberOfLines={6}>
                        {sr.raw_text}
                      </Text>
                    ) : null}
                    {doc?.title ? (
                      <TouchableOpacity
                        onPress={() => doc.url ? Linking.openURL(doc.url) : null}
                        disabled={!doc.url}
                      >
                        <Text style={[styles.evidenceSource, doc.url && { textDecorationLine: 'underline' }]}>
                          From: {doc.title}
                          {doc.publisher ? ` (${doc.publisher})` : ''}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                    {sr?.source_page ? (
                      <Text style={styles.evidencePage}>Page {sr.source_page}</Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>

        {vessel.identity_notes ? (
          <Text style={styles.footnote}>{vessel.identity_notes}</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtYears(start: number | null, end: number | null, dateText: string | null): string {
  if (dateText) return dateText;
  if (start && end)   return `${start}–${end}`;
  if (start)          return `From ${start}`;
  if (end)            return `Until ${end}`;
  return '';
}

function humaniseRecordType(t: string): string {
  if (!t) return 'Source record';
  return t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function confidenceText(c: Confidence): string {
  switch (c) {
    case 'confirmed': return 'This boat is confirmed in the official register.';
    case 'probable':  return 'Almost certainly this boat — strong matching evidence.';
    case 'possible':  return 'Likely this boat, but we\'re still tying off the details.';
    case 'unmatched': return 'Awaiting more evidence to be confident.';
    case 'conflict':  return 'Sources disagree about this boat — see below.';
  }
}

function Section({
  title, subtitle, children,
}: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {subtitle ? <Text style={styles.sectionSubtitle}>{subtitle}</Text> : null}
      <View style={{ gap: 4, marginTop: spacing.sm }}>{children}</View>
    </View>
  );
}

function BigRow({
  primary, secondary, badge, pillColor, confidence,
}: {
  primary: string;
  secondary?: string;
  badge?: string;
  pillColor?: string;
  confidence?: Confidence;
}) {
  return (
    <View style={styles.bigRow}>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {pillColor ? (
            <View style={[styles.regPill, { backgroundColor: pillColor }]}>
              <Text style={styles.regPillText} numberOfLines={1}>{primary}</Text>
            </View>
          ) : (
            <Text style={styles.bigPrimary}>{primary}</Text>
          )}
          {badge ? (
            <View style={styles.badgeChip}>
              <Text style={styles.badgeChipText}>{badge}</Text>
            </View>
          ) : null}
        </View>
        {secondary ? <Text style={styles.bigSecondary}>{secondary}</Text> : null}
      </View>
      {confidence ? <ConfidencePill value={confidence} /> : null}
    </View>
  );
}

function ConfidencePill({ value }: { value: Confidence }) {
  const t = CONFIDENCE_TONE[value];
  return (
    <View style={[styles.confPill, { backgroundColor: t.bg }]}>
      <Text style={[styles.confPillText, { color: t.text }]}>{confidenceLabel(value)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.screenBackground },
  scroll:    { paddingBottom: spacing.xxl, gap: spacing.lg },
  center:    { alignItems: 'center', justifyContent: 'center' },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  iconBtn: {
    width: 44, height: 44,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: 22,
  },

  heroWrap: {
    width: '100%',
    aspectRatio: 16 / 10,
    backgroundColor: '#000',
  },
  hero: { width: '100%', height: '100%' },
  heroPlaceholder: {
    width: '100%',
    aspectRatio: 16 / 10,
    backgroundColor: SECTION.light,
    alignItems: 'center',
    justifyContent: 'center',
  },

  headerBlock: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: 4,
  },
  lk: {
    fontSize: 15,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 1.5,
  },
  title: {
    fontSize: 32,
    fontWeight: '900',
    color: colors.textPrimary,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 17,
    color: colors.textSecondary,
    marginTop: 4,
    fontWeight: '500',
  },

  confCallout: {
    marginHorizontal: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  confCalloutText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 19,
  },

  section: {
    marginHorizontal: spacing.lg,
    padding: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  sectionSubtitle: {
    fontSize: 14,
    color: colors.textMuted,
    marginTop: 2,
  },

  bigRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  bigPrimary: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  bigSecondary: {
    fontSize: 15,
    color: colors.textSecondary,
    marginTop: 2,
  },

  regPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  regPillText: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 14,
    letterSpacing: 0.5,
  },

  badgeChip: {
    backgroundColor: colors.offWhite,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  badgeChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  confPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  confPillText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.2,
  },

  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: spacing.sm,
  },
  photoTile: {
    width: '32%',
    aspectRatio: 1,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: colors.offWhite,
    position: 'relative',
  },
  photoPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 6,
    gap: 4,
  },
  photoPlaceholderText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textAlign: 'center',
  },
  photoCatalogue: {
    position: 'absolute',
    top: 6, right: 6,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: 'rgba(15, 28, 38, 0.7)',
    alignItems: 'center', justifyContent: 'center',
  },

  timelineRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  year: {
    minWidth: 56,
    height: 32,
    paddingHorizontal: 8,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  yearText: { fontSize: 13, fontWeight: '900' },
  timelineEvent: { fontSize: 13, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  timelineDesc:  { fontSize: 16, color: colors.textPrimary, marginTop: 2, lineHeight: 22 },
  timelineMeta:  { fontSize: 13, color: colors.textMuted, marginTop: 2 },

  drawerToggle: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    alignSelf: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 999,
  },
  drawerToggleText: { fontSize: 15, fontWeight: '800' },

  evidenceCard: {
    padding: spacing.md,
    backgroundColor: colors.offWhite,
    borderRadius: radius.md,
    gap: 6,
  },
  evidenceTopRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  evidenceType: {
    flex: 1,
    fontSize: 13,
    fontWeight: '800',
    color: colors.textSecondary,
  },
  evidenceRaw: {
    fontSize: 13,
    color: colors.textPrimary,
    fontFamily: 'Courier',
    backgroundColor: colors.white,
    padding: 8,
    borderRadius: 6,
    lineHeight: 18,
  },
  evidenceSource: { fontSize: 14, color: colors.textSecondary, fontWeight: '600' },
  evidencePage:   { fontSize: 12, color: colors.textMuted },

  bodyMuted: { fontSize: 17, color: colors.textSecondary, marginBottom: spacing.md },
  backBtnSmall: {
    backgroundColor: SECTION.color,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  backBtnSmallText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  footnote: {
    paddingHorizontal: spacing.lg,
    fontSize: 13,
    color: colors.textMuted,
    fontStyle: 'italic',
    lineHeight: 18,
  },
});
