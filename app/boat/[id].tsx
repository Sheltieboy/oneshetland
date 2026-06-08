/**
 * app/boat/[id].tsx
 *
 * Vessel profile — the rich page behind every boat in Da Boats.
 *
 * Shows everything we know about a single hull:
 *   * canonical name + primary LK number + build facts
 *   * historical names (chronological)
 *   * historical registrations (LK, FR, BF, PD, …)
 *   * owners through the years
 *   * measurements (length / tonnage / engine over time)
 *   * photo gallery (with rights notes where present)
 *   * unified timeline (events + name + registration changes)
 *   * evidence drawer — every source record this boat is built on,
 *     with confidence and the originating document
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator,
  TouchableOpacity, Image, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS } from '@/constants/sections';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import {
  fetchVesselProfile, fetchVesselTimeline,
  VesselProfile, VesselTimelineEntry, Confidence,
  vesselDisplayTitle, hullMaterialLabel, eventTypeLabel,
} from '@/lib/boats-api';

const SECTION = SECTIONS.daBoats;

// Lower-saturation pill colours per confidence level — confirmed feels
// confident, possible feels tentative, conflict feels alarming.
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
  const [showEvidence, setEvidence] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [p, t] = await Promise.all([
        fetchVesselProfile(id),
        fetchVesselTimeline(id),
      ]);
      setProfile(p);
      setTimeline(t);
    } catch {
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, styles.center]}>
        <ActivityIndicator color={SECTION.color} />
      </SafeAreaView>
    );
  }
  if (!profile) {
    return (
      <SafeAreaView style={[styles.container, styles.center]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={styles.bodyMuted}>Boat not found.</Text>
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
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} hitSlop={10}>
            <FontAwesome5 name="chevron-left" size={18} color={colors.textPrimary} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={[styles.eyebrow, { color: SECTION.color }]}>
              {vessel.primary_lk_number ?? 'Vessel'}
            </Text>
            <Text style={styles.title} numberOfLines={2}>{title}</Text>
          </View>
          <ConfidenceChip value={vessel.identity_confidence} />
        </View>

        {/* Build facts */}
        <View style={styles.factsCard}>
          {vessel.built_year ? (
            <Fact label="Built" value={String(vessel.built_year)} />
          ) : null}
          {vessel.built_decade ? <Fact label="Decade" value={vessel.built_decade} /> : null}
          {hull             ? <Fact label="Hull"   value={hull} />                  : null}
          {vessel.builder   ? <Fact label="Builder" value={vessel.builder} />        : null}
          {vessel.yard_number ? <Fact label="Yard №" value={vessel.yard_number} />   : null}
          {vessel.country_of_build ? <Fact label="Origin" value={vessel.country_of_build} /> : null}
          {vessel.status    ? <Fact label="Status" value={vessel.status} />          : null}
        </View>

        {/* Hero photo (if any media has an image_url, not just a reference). */}
        {heroPhoto?.image_url ? (
          <View style={styles.heroWrap}>
            <Image source={{ uri: heroPhoto.image_url }} style={styles.hero} resizeMode="cover" />
          </View>
        ) : null}

        {/* Names history */}
        {names.length ? (
          <Section title="Names">
            {names.map(n => (
              <Row key={n.id}>
                <Bullet />
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>
                    {n.name}
                    {n.is_primary ? <Text style={[styles.tinyTag, { color: SECTION.color }]}>  primary</Text> : null}
                  </Text>
                  {(n.start_year || n.end_year || n.date_text) ? (
                    <Text style={styles.rowMeta}>
                      {n.date_text ?? `${n.start_year ?? ''}${n.end_year ? `–${n.end_year}` : ''}`}
                    </Text>
                  ) : null}
                </View>
                <ConfidenceChip value={n.confidence} size="sm" />
              </Row>
            ))}
          </Section>
        ) : null}

        {/* Registrations */}
        {registrations.length ? (
          <Section title="Registrations">
            {registrations.map(r => (
              <Row key={r.id}>
                <View style={[styles.regChip, { backgroundColor: SECTION.light }]}>
                  <Text style={[styles.regChipText, { color: SECTION.color }]}>{r.registration}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  {(r.start_year || r.end_year || r.date_text) ? (
                    <Text style={styles.rowMeta}>
                      {r.date_text ?? `${r.start_year ?? ''}${r.end_year ? `–${r.end_year}` : ''}`}
                    </Text>
                  ) : null}
                </View>
                <ConfidenceChip value={r.confidence} size="sm" />
              </Row>
            ))}
          </Section>
        ) : null}

        {/* Ownership */}
        {ownerships.length ? (
          <Section title="Owners">
            {ownerships.map(o => (
              <Row key={o.id}>
                <Bullet />
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>{o.owner?.name ?? 'Unknown owner'}</Text>
                  {(o.start_year || o.end_year || o.date_text) ? (
                    <Text style={styles.rowMeta}>
                      {o.date_text ?? `${o.start_year ?? ''}${o.end_year ? `–${o.end_year}` : ''}`}
                    </Text>
                  ) : null}
                  {o.notes ? <Text style={styles.rowMeta}>{o.notes}</Text> : null}
                </View>
                <ConfidenceChip value={o.confidence} size="sm" />
              </Row>
            ))}
          </Section>
        ) : null}

        {/* Measurements */}
        {measurements.length ? (
          <Section title="Measurements">
            {measurements.map(m => {
              const bits: string[] = [];
              if (m.length_m)      bits.push(`${Number(m.length_m).toFixed(1)} m`);
              if (m.tonnage_text)  bits.push(m.tonnage_text);
              else if (m.tonnage)  bits.push(`${m.tonnage} t`);
              if (m.engine_power_kw) bits.push(`${m.engine_power_kw} kW`);
              return (
                <Row key={m.id}>
                  <Bullet />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle}>{bits.join('  ·  ')}</Text>
                    {m.measurement_year ? (
                      <Text style={styles.rowMeta}>{m.measurement_year}</Text>
                    ) : null}
                    {m.notes ? <Text style={styles.rowMeta}>{m.notes}</Text> : null}
                  </View>
                </Row>
              );
            })}
          </Section>
        ) : null}

        {/* Photos */}
        {media.length ? (
          <Section title={`Photos (${media.length})`}>
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
                        <FontAwesome5 name="camera" size={18} color={SECTION.color} />
                        <Text style={styles.photoPlaceholderText} numberOfLines={2}>
                          {mm.external_ref ?? 'Photo reference'}
                        </Text>
                      </View>
                    )}
                    {mm.rights_note ? (
                      <View style={styles.photoRights}>
                        <Text style={styles.photoRightsText} numberOfLines={1}>
                          {mm.rights_note.slice(0, 60)}
                        </Text>
                      </View>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          </Section>
        ) : null}

        {/* Timeline */}
        {timeline.length ? (
          <Section title="Timeline">
            {timeline.map((t, i) => (
              <Row key={i}>
                <View style={styles.year}>
                  <Text style={styles.yearText}>{t.year ?? '—'}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>{eventTypeLabel(t.item_type)}</Text>
                  <Text style={styles.rowMeta}>{t.description}</Text>
                  {t.date_text ? <Text style={styles.rowMeta}>{t.date_text}</Text> : null}
                </View>
                <ConfidenceChip value={t.confidence} size="sm" />
              </Row>
            ))}
          </Section>
        ) : null}

        {/* Events that aren't in the timeline view (rare but possible) */}
        {/* — folded already by vessel_timeline view. */}

        {/* Evidence drawer */}
        <Section title={`Evidence (${evidence.length})`}>
          <TouchableOpacity
            onPress={() => setEvidence(s => !s)}
            style={[styles.drawerToggle, { backgroundColor: SECTION.light }]}
          >
            <FontAwesome5
              name={showEvidence ? 'chevron-down' : 'chevron-right'}
              size={11}
              color={SECTION.color}
            />
            <Text style={[styles.drawerToggleText, { color: SECTION.color }]}>
              {showEvidence ? 'Hide source records' : 'Show source records'}
            </Text>
          </TouchableOpacity>

          {showEvidence ? (
            <View style={{ gap: spacing.xs, marginTop: spacing.sm }}>
              {evidence.map(ev => {
                const sr = ev.source_record;
                const doc = (sr as any)?.document;
                return (
                  <View key={ev.id} style={styles.evidenceCard}>
                    <View style={styles.evidenceTopRow}>
                      <Text style={styles.evidenceType} numberOfLines={1}>
                        {sr?.record_type ?? 'record'}
                      </Text>
                      <ConfidenceChip value={ev.confidence} size="sm" />
                    </View>
                    {sr?.raw_text ? (
                      <Text style={styles.evidenceRaw} numberOfLines={4}>
                        {sr.raw_text}
                      </Text>
                    ) : null}
                    {doc?.title ? (
                      <TouchableOpacity
                        onPress={() => doc.url ? Linking.openURL(doc.url) : null}
                        disabled={!doc.url}
                      >
                        <Text style={[styles.evidenceSource, doc.url && { textDecorationLine: 'underline' }]}>
                          Source: {doc.title}
                          {doc.publisher ? ` · ${doc.publisher}` : ''}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                    {sr?.source_page ? (
                      <Text style={styles.evidencePage}>p. {sr.source_page}</Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}
        </Section>

        {vessel.identity_notes ? (
          <Text style={styles.footnote}>{vessel.identity_notes}</Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <View style={styles.rowR}>{children}</View>;
}

function Bullet() {
  return <View style={[styles.bullet, { backgroundColor: SECTION.color }]} />;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
    </View>
  );
}

function ConfidenceChip({ value, size = 'md' }: { value: Confidence; size?: 'sm' | 'md' }) {
  const t = CONFIDENCE_TONE[value];
  return (
    <View style={[
      styles.confChip,
      size === 'sm' && styles.confChipSm,
      { backgroundColor: t.bg },
    ]}>
      <Text style={[
        styles.confChipText,
        size === 'sm' && { fontSize: 9 },
        { color: t.text },
      ]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.screenBackground },
  scroll:    { paddingBottom: spacing.xxl },
  center:    { alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  iconBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18 },
  eyebrow: {
    fontSize: fontSize.xs,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  title: {
    fontSize: fontSize.xl,
    fontWeight: '900',
    color: colors.textPrimary,
    marginTop: 2,
  },

  factsCard: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  fact: { minWidth: '30%', gap: 2 },
  factLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  factValue: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.textPrimary,
  },

  heroWrap: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  hero: { width: '100%', aspectRatio: 16 / 9 },

  section: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    padding: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  sectionTitle: {
    fontSize: fontSize.md,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  },

  rowR: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 6,
  },
  bullet: {
    width: 6, height: 6, borderRadius: 3,
    marginLeft: 2,
  },
  rowTitle: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  rowMeta:  { fontSize: 11, color: colors.textMuted },
  tinyTag:  { fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },

  regChip: {
    minWidth: 56,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 999,
    alignItems: 'center',
  },
  regChipText: { fontSize: 12, fontWeight: '900', letterSpacing: 0.4 },

  year: {
    minWidth: 44,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: colors.offWhite,
    alignItems: 'center',
  },
  yearText: { fontSize: 11, fontWeight: '800', color: colors.textPrimary },

  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: spacing.xs,
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
    fontSize: 9,
    fontWeight: '700',
    color: colors.textMuted,
    textAlign: 'center',
  },
  photoRights: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(15, 28, 38, 0.78)',
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  photoRightsText: { color: '#fff', fontSize: 9, fontWeight: '600' },

  drawerToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  drawerToggleText: { fontSize: 12, fontWeight: '800' },
  evidenceCard: {
    padding: spacing.sm,
    backgroundColor: colors.offWhite,
    borderRadius: radius.sm,
    gap: 4,
  },
  evidenceTopRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  evidenceType: {
    flex: 1,
    fontSize: 11,
    fontWeight: '800',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  evidenceRaw: {
    fontSize: 12,
    color: colors.textPrimary,
    fontFamily: 'Courier',
    backgroundColor: colors.white,
    padding: 6,
    borderRadius: 4,
  },
  evidenceSource: { fontSize: 11, color: colors.textSecondary },
  evidencePage:   { fontSize: 10, color: colors.textMuted },

  confChip: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  confChipSm: { paddingHorizontal: 6, paddingVertical: 2 },
  confChipText: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },

  bodyMuted: { color: colors.textSecondary, marginBottom: spacing.md },
  backBtnSmall: {
    backgroundColor: SECTION.color,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  backBtnSmallText: { color: '#fff', fontWeight: '700' },
  footnote: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
    fontSize: 11,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
});
