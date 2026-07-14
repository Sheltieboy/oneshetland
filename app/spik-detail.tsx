import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { useLocalSearchParams, router } from 'expo-router';
import { colors, fontSize, radius, spacing, shadow } from '@/constants/theme';
import { fetchSpikEntry, decodeEntities, type SpikEntry } from '@/lib/oneshetland-api';
import { paletteFor, type PosPalette } from '@/lib/spik-palette';
import { HeroBackPill } from '@/components/ui/HeroBackPill';
import { track } from '@/lib/analytics';

function stripHtml(str: string): string {
  return decodeEntities(str.replace(/<[^>]*>/g, '').trim());
}

export default function SpikDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [entry, setEntry]     = useState<SpikEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    if (!id) { setError('Invalid word'); setLoading(false); return; }
    fetchSpikEntry(Number(id))
      .then(setEntry)
      .catch(() => setError('Could not load word'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (entry?.id) track('content_viewed', { objectType: 'spik_word', objectId: String(entry.id) });
  }, [entry?.id]);

  const pal = paletteFor(entry?.part_of_speech);

  if (loading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <BackBar color={colors.accent} />
        <View style={styles.center}><ActivityIndicator size="large" color={colors.accent} /></View>
      </SafeAreaView>
    );
  }

  if (error || !entry) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <BackBar color={colors.accent} />
        <View style={styles.center}>
          <Text style={styles.errorText}>{error ?? 'Word not found'}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const meaning     = stripHtml(entry.short_meaning || entry.spik_meaning || '');
  const fullMeaning = entry.spik_meaning ? stripHtml(entry.spik_meaning) : null;
  const example     = entry.example_sentence ? stripHtml(entry.example_sentence) : null;

  const hasPronunciation = !!entry.pronunciation;
  const hasAltSpelling   = !!entry.alternate_spelling;
  const hasOrigin        = !!entry.origin;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.navy }]} edges={['top']}>
      <ScrollView showsVerticalScrollIndicator={false} bounces>

        {/* Hero — left border matches POS colour */}
        <View style={[styles.hero, { borderLeftColor: pal.bar, borderLeftWidth: 5 }]}>
          <BackBar color={pal.bar} />

          <View style={styles.heroContent}>
            <Text style={styles.word}>{entry.word}</Text>

            <View style={styles.badgeRow}>
              {entry.part_of_speech ? (
                <View style={[styles.posBadge, { backgroundColor: pal.tint, borderColor: pal.bar + '55', borderWidth: 1 }]}>
                  <Text style={[styles.posText, { color: pal.bar === colors.accent ? colors.accent : '#fff' }]}>
                    {entry.part_of_speech}
                  </Text>
                </View>
              ) : null}
              {entry.category ? (
                <View style={styles.catBadge}>
                  <Text style={styles.catText}>{entry.category}</Text>
                </View>
              ) : null}
            </View>

            {meaning ? <Text style={styles.heroMeaning}>{meaning}</Text> : null}

            {fullMeaning && fullMeaning !== meaning ? (
              <Text style={styles.heroFullMeaning}>{fullMeaning}</Text>
            ) : null}

            {/* Community contributor hint */}
            {entry.contributor_name && entry.contributor_show ? (
              <View style={styles.contributorRow}>
                <FontAwesome5 name="users" size={10} color={pal.bar} />
                <Text style={styles.contributorText}>
                  * Improved by the community
                  {' — '}
                  <Text style={{ fontWeight: '700' }}>{entry.contributor_name}</Text>
                </Text>
              </View>
            ) : entry.contributor_name ? (
              <View style={styles.contributorRow}>
                <FontAwesome5 name="users" size={10} color={pal.bar} />
                <Text style={styles.contributorText}>* Improved by the community</Text>
              </View>
            ) : null}
          </View>
        </View>

        <View style={styles.body}>

          {/* Example */}
          {example ? (
            <Section>
              <Label>EXAMPLE IN USE</Label>
              <View style={[styles.exampleBox, { borderLeftColor: pal.bar }]}>
                <Text style={styles.exampleText}>"{example}"</Text>
              </View>
            </Section>
          ) : null}

          {/* Pronunciation */}
          {entry.pronunciation ? (
            <Section>
              <Label>PRONUNCIATION</Label>
              <Text style={styles.subLabel}>SAY IT LIKE THIS</Text>
              <View style={styles.pronRow}>
                <View style={[styles.pronChip, { backgroundColor: pal.bg }]}>
                  <Text style={[styles.pronText, { color: pal.text }]}>/{entry.pronunciation}/</Text>
                </View>
                {entry.audio_url ? <PronunciationPlayer url={entry.audio_url} color={pal.bar} /> : null}
              </View>
              {entry.alternate_spelling ? (
                <View style={styles.altRow}>
                  <Text style={styles.altLabel}>Also written:</Text>
                  <Text style={styles.altValue}>{entry.alternate_spelling}</Text>
                </View>
              ) : null}
            </Section>
          ) : entry.alternate_spelling ? (
            <Section>
              <Label>ALSO WRITTEN</Label>
              <Text style={styles.pronValue}>{entry.alternate_spelling}</Text>
            </Section>
          ) : null}

          {/* Hear it — shown when there's audio but no written pronunciation
              to say it like (the pron section above already carries the
              speaker button when a pronunciation string exists). */}
          {entry.audio_url && !entry.pronunciation ? (
            <Section>
              <Label>HEAR IT SPOKEN</Label>
              <View style={styles.pronRow}>
                <PronunciationPlayer url={entry.audio_url} color={pal.bar} />
                <Text style={styles.hearItHint}>Tap to hear "{entry.word}"</Text>
              </View>
            </Section>
          ) : null}

          {/* Word Snapshot */}
          <Section>
            <Label>WORD SNAPSHOT</Label>
            <View style={styles.snapshotGrid}>
              <SnapStat value={hasPronunciation ? 'Yes' : 'No'} label="pronunciation added" accentColor={hasPronunciation ? pal.bar : undefined} />
              <SnapStat value={hasAltSpelling ? '1' : '0'}      label="known variants" />
              <SnapStat value={entry.usage_level || '—'}         label="usage level" accentColor={entry.usage_level ? pal.bar : undefined} />
              <SnapStat value={hasOrigin ? 'Set' : '—'}          label="origin detail" accentColor={hasOrigin ? pal.bar : undefined} />
            </View>
          </Section>

          {/* Origin & context */}
          {(entry.origin || entry.era || entry.tone || entry.speaker_area) ? (
            <Section>
              <Label>ORIGIN & CONTEXT</Label>
              <View style={styles.originTags}>
                {entry.origin ? <OriginTag label={entry.origin} color={pal.bar} bg={pal.bg} text={pal.text} /> : null}
                {entry.era    ? <OriginTag label={entry.era} /> : null}
                {entry.tone   ? <OriginTag label={entry.tone} /> : null}
              </View>
              {entry.speaker_area ? (
                <View style={styles.speakerAreaRow}>
                  <FontAwesome5 name="map-marker-alt" size={11} color={pal.bar} />
                  <Text style={styles.speakerAreaLabel}>Spoken in</Text>
                  <Text style={[styles.speakerAreaValue, { color: pal.bar }]}>{entry.speaker_area}</Text>
                </View>
              ) : null}
            </Section>
          ) : null}

          {/* Suggest */}
          <View style={[styles.suggestBlock, { borderTopColor: pal.bar, borderTopWidth: 3 }]}>
            <Text style={styles.suggestTitle}>Make a Suggestion</Text>
            <Text style={styles.suggestBody}>
              Know a better meaning, pronunciation, example, or origin note for{' '}
              <Text style={[styles.suggestWordHighlight, { color: pal.bar }]}>{entry.word}</Text>?
              {' '}Send it in for review and help improve Spik.
            </Text>
            <View style={styles.suggestBullets}>
              <BulletRow text="Suggest one or more improvements in one go" color={pal.bar} />
              <BulletRow text="See the current version beside your suggestion" color={pal.bar} />
              <BulletRow text="Nothing goes live until it has been reviewed" color={pal.bar} />
            </View>
            <TouchableOpacity
              style={[styles.suggestBtn, { backgroundColor: pal.bar }]}
              activeOpacity={0.85}
              onPress={() => router.push({
                pathname: '/spik-suggest',
                params: {
                  id:                 String(entry.id),
                  word:               entry.word,
                  pos:                entry.part_of_speech ?? '',
                  short_meaning:      entry.short_meaning ?? '',
                  spik_meaning:       entry.spik_meaning ? stripHtml(entry.spik_meaning) : '',
                  example_sentence:   entry.example_sentence ? stripHtml(entry.example_sentence) : '',
                  pronunciation:      entry.pronunciation ?? '',
                  alternate_spelling: entry.alternate_spelling ?? '',
                  origin:             entry.origin ?? '',
                  era:                entry.era ?? '',
                  tone:               entry.tone ?? '',
                  category:           entry.category ?? '',
                },
              })}
            >
              <Text style={styles.suggestBtnText}>Make a Suggestion</Text>
            </TouchableOpacity>
          </View>

        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function BackBar({ color }: { color: string }) {
  return (
    <HeroBackPill
      variant="frost"
      accent={color}
      label="Back"
      style={{ marginLeft: spacing.md, marginTop: 8 }}
      onPress={() => router.back()}
    />
  );
}

// Tappable speaker button that plays a word's pronunciation recording.
// Mounted only when a word actually has an audio_url, so useAudioPlayer
// always receives a real source. Mirrors the AudioTile play/pause pattern
// used on the memory detail screen.
function PronunciationPlayer({ url, color }: { url: string; color: string }) {
  const player = useAudioPlayer(url);
  const status = useAudioPlayerStatus(player);
  const isPlaying = status.playing;

  const toggle = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (status.playing) {
      player.pause();
    } else {
      // Replay from the start once it has reached the end.
      if (status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration)) {
        player.seekTo(0);
      }
      player.play();
    }
  };

  return (
    <TouchableOpacity
      onPress={toggle}
      activeOpacity={0.85}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={isPlaying ? 'Pause pronunciation' : 'Play pronunciation'}
      style={[styles.audioBtn, { backgroundColor: color }]}
    >
      <FontAwesome5 name={isPlaying ? 'pause' : 'volume-up'} size={15} color="#fff" solid />
    </TouchableOpacity>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <View style={styles.section}>{children}</View>;
}

function Label({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

function SnapStat({ value, label, accentColor }: { value: string; label: string; accentColor?: string }) {
  return (
    <View style={styles.snapStat}>
      <Text style={[styles.snapValue, accentColor ? { color: accentColor } : null]}>{value}</Text>
      <Text style={styles.snapLabel}>{label}</Text>
    </View>
  );
}

function OriginTag({ label, color, bg, text }: { label: string; color?: string; bg?: string; text?: string }) {
  if (color && bg && text) {
    return (
      <View style={[styles.originTag, { backgroundColor: bg }]}>
        <Text style={[styles.originTagText, { color: text }]}>{label}</Text>
      </View>
    );
  }
  return (
    <View style={styles.originTagMuted}>
      <Text style={styles.originTagTextMuted}>{label}</Text>
    </View>
  );
}

function BulletRow({ text, color }: { text: string; color: string }) {
  return (
    <View style={styles.bulletRow}>
      <View style={[styles.bullet, { backgroundColor: color }]} />
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1 },

  backBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: spacing.md, paddingTop: 10, paddingBottom: 4,
    alignSelf: 'flex-start',
  },
  backText: { fontSize: fontSize.sm, fontWeight: '600' },

  // Hero
  hero: {
    backgroundColor: colors.navy,
    paddingBottom: spacing.xl,
    paddingLeft: spacing.md - 5, // compensate for left border
  },
  heroContent: { paddingHorizontal: spacing.md, paddingTop: 8 },
  word:        { color: '#fff', fontSize: 36, fontWeight: '800', lineHeight: 42 },
  badgeRow:    { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  posBadge:    { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.full },
  posText:     { fontSize: fontSize.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  catBadge:    { backgroundColor: 'rgba(255,255,255,0.1)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.full },
  catText:     { color: 'rgba(255,255,255,0.65)', fontSize: fontSize.xs, fontWeight: '600' },
  heroMeaning:     { color: '#fff', fontSize: fontSize.lg, lineHeight: 26, fontWeight: '400', marginTop: 14 },
  heroFullMeaning: { color: 'rgba(255,255,255,0.6)', fontSize: fontSize.md, lineHeight: 24, marginTop: 10 },
  contributorRow:  { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.15)' },
  contributorText: { color: 'rgba(255,255,255,0.55)', fontSize: fontSize.xs, lineHeight: 16, flex: 1 },

  // Body
  body: { backgroundColor: colors.screenBackground, paddingBottom: 48 },

  section: {
    backgroundColor: colors.cardBackground,
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    borderRadius: radius.lg,
    padding: spacing.md,
    ...shadow.card,
  },
  sectionLabel: {
    color: colors.textLight, fontSize: fontSize.xs, fontWeight: '700',
    letterSpacing: 1.2, marginBottom: 10,
  },

  // Example
  exampleBox: {
    borderLeftWidth: 3, borderRadius: radius.sm,
    backgroundColor: colors.offWhite,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  exampleText: { color: colors.textSecondary, fontSize: fontSize.md, lineHeight: 24, fontStyle: 'italic' },

  // Pronunciation
  subLabel:  { color: colors.textLight, fontSize: fontSize.xs, fontWeight: '600', letterSpacing: 0.8, marginBottom: 8 },
  pronRow:   { flexDirection: 'row', alignItems: 'center', gap: 10 },
  audioBtn:  { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', ...shadow.card },
  hearItHint:{ color: colors.textSecondary, fontSize: fontSize.sm, flex: 1 },
  pronChip:  { alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.full },
  pronText:  { fontSize: fontSize.md, fontWeight: '700' },
  pronValue: { color: colors.textPrimary, fontSize: fontSize.xl, fontWeight: '700' },
  altRow:    { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  altLabel:  { color: colors.textMuted, fontSize: fontSize.sm },
  altValue:  { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '600' },

  // Snapshot
  snapshotGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  snapStat: {
    width: '47%', backgroundColor: colors.offWhite,
    borderRadius: radius.md, padding: 14,
  },
  snapValue: { color: colors.textPrimary, fontSize: fontSize.xl, fontWeight: '800', marginBottom: 2 },
  snapLabel: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 16 },

  // Origin
  originTags:       { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 2 },
  speakerAreaRow:   { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 12, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  speakerAreaLabel: { color: colors.textMuted, fontSize: fontSize.sm },
  speakerAreaValue: { fontSize: fontSize.sm, fontWeight: '700' },
  originTag:        { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.full },
  originTagText:    { fontSize: fontSize.sm, fontWeight: '600' },
  originTagMuted:   { backgroundColor: colors.offWhite, paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.full },
  originTagTextMuted: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600' },

  // Suggest
  suggestBlock: {
    backgroundColor: colors.navy,
    marginHorizontal: spacing.md, marginTop: spacing.md,
    borderRadius: radius.lg, padding: spacing.md,
  },
  suggestTitle:         { color: '#fff', fontSize: fontSize.lg, fontWeight: '800', marginBottom: 8 },
  suggestBody:          { color: 'rgba(255,255,255,0.6)', fontSize: fontSize.sm, lineHeight: 20, marginBottom: 14 },
  suggestWordHighlight: { fontWeight: '700' },
  suggestBullets:       { gap: 8, marginBottom: 18 },
  bulletRow:   { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  bullet:      { width: 7, height: 7, borderRadius: 4, marginTop: 5 },
  bulletText:  { color: 'rgba(255,255,255,0.65)', fontSize: fontSize.sm, flex: 1, lineHeight: 20 },
  suggestBtn:      { borderRadius: radius.md, paddingVertical: 14, alignItems: 'center' },
  suggestBtnText:  { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },

  center:    { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorText: { color: 'rgba(255,255,255,0.6)', fontSize: fontSize.md },
});
