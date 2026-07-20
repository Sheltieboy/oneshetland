/**
 * spik-add-variation.tsx
 *
 * Contributor form for adding a LOCAL VARIATION of a Spik dictionary word.
 * A word can be spelled / said differently around Shetland — a contributor
 * picks their region, gives the local spelling / pronunciation, records their
 * own audio of the word (and optionally an example sentence + its audio), and
 * submits it for review. Approved variations then show on the word detail
 * screen grouped by region.
 *
 * Signed-in only: an anonymous visitor is shown a sign-in prompt that routes
 * back here afterwards via the `next` param.
 *
 * Rows land in spik_word_variations with status 'pending'; RLS requires
 * contributor_id = auth.uid() and status = 'pending' on insert.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Switch,
  KeyboardAvoidingView,
  Platform,
  Animated,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, router } from 'expo-router';
import { track } from '@/lib/analytics';
import { colors, fontSize, radius, spacing, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { useAlert } from '@/components/BrandedAlert';
import { SECTIONS } from '@/constants/sections';
import { supabase } from '@/lib/supabase';
import { VoiceRecorder } from '@/components/VoiceRecorder';
import { uploadSpikAudio, type PickedFile } from '@/lib/image-upload';
import { fetchRegions, type SpikRegion } from '@/lib/spik-variations-api';

const ACCENT = SECTIONS.spik.color;

export default function SpikAddVariationScreen() {
  const { id, word } = useLocalSearchParams<{ id: string; word: string }>();
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();

  // ── Auth gate ────────────────────────────────────────────────────────────
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [userId, setUserId]             = useState<string | null>(null);

  // ── Form state ───────────────────────────────────────────────────────────
  const [regions, setRegions]           = useState<SpikRegion[]>([]);
  const [regionId, setRegionId]         = useState('');
  const [regionName, setRegionName]     = useState('');
  const [variantSpelling, setVariantSpelling] = useState('');
  const [pronunciation, setPronunciation]     = useState('');
  const [wordAudio, setWordAudio]       = useState<PickedFile | null>(null);
  const [sentenceText, setSentenceText] = useState('');
  const [sentenceAudio, setSentenceAudio] = useState<PickedFile | null>(null);
  const [submitterName, setSubmitterName] = useState('');
  const [showName, setShowName]         = useState(true);

  const [submitting, setSubmitting]     = useState(false);
  const [submitted, setSubmitted]       = useState(false);

  const successScale   = useRef(new Animated.Value(0)).current;
  const successOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!active) return;
      const user = data.user;
      setUserId(user?.id ?? null);
      if (user) {
        const meta = (user.user_metadata ?? {}) as Record<string, any>;
        const name = meta.full_name || meta.name || meta.display_name || '';
        if (name) setSubmitterName(String(name));
      }
      setCheckingAuth(false);
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    fetchRegions().then(setRegions).catch(() => setRegions([]));
  }, []);

  const canSubmit =
    !!regionId &&
    (variantSpelling.trim().length > 0 || !!wordAudio);

  const pickRegion = (r: SpikRegion) => {
    Haptics.selectionAsync();
    if (regionId === r.id) {
      setRegionId('');
      setRegionName('');
    } else {
      setRegionId(r.id);
      setRegionName(r.name);
    }
  };

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !userId) {
      if (!regionId) {
        alert({ title: 'Region needed', message: 'Please choose which part of Shetland this variation is from.' });
      } else if (!variantSpelling.trim() && !wordAudio) {
        alert({ title: 'Add a variation', message: 'Give a local spelling or record the word before submitting.' });
      }
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSubmitting(true);

    try {
      let wordAudioUrl: string | null = null;
      let sentenceAudioUrl: string | null = null;

      if (wordAudio) {
        wordAudioUrl = await uploadSpikAudio(userId, Number(id), 'word', wordAudio);
      }
      if (sentenceAudio) {
        sentenceAudioUrl = await uploadSpikAudio(userId, Number(id), 'sentence', sentenceAudio);
      }

      const { error } = await supabase.from('spik_word_variations').insert({
        word_id:            Number(id),
        region_id:          regionId,
        region_name:        regionName,
        variant_spelling:   variantSpelling.trim() || null,
        pronunciation:      pronunciation.trim() || null,
        word_audio_url:     wordAudioUrl,
        sentence_text:      sentenceText.trim() || null,
        sentence_audio_url: sentenceAudioUrl,
        contributor_id:     userId,
        contributor_name:   submitterName.trim() || null,
        show_name:          showName,
        status:             'pending',
      });

      if (error) throw error;

      track('spik_variation_submitted', { objectType: 'spik_word', objectId: String(id) });
      setSubmitted(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Animated.parallel([
        Animated.spring(successScale,   { toValue: 1, friction: 5, tension: 100, useNativeDriver: true }),
        Animated.timing(successOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      ]).start();
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      alert({ title: 'Something went wrong', message: 'Please try again in a moment.' });
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, userId, id, regionId, regionName, variantSpelling, pronunciation, wordAudio, sentenceText, sentenceAudio, submitterName, showName]);

  // ── Loading auth ───────────────────────────────────────────────────────────
  if (checkingAuth) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScreenHeader title="Add a local variation" subtitle={word} onClose={() => router.back()} accent={ACCENT} />
        <View style={styles.center}><ActivityIndicator size="large" color={ACCENT} /></View>
      </SafeAreaView>
    );
  }

  // ── Signed-out gate ────────────────────────────────────────────────────────
  if (!userId) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScreenHeader title="Add a local variation" subtitle={word} onClose={() => router.back()} accent={ACCENT} />
        <View style={styles.gate}>
          <View style={[styles.gateIcon, { backgroundColor: SECTIONS.spik.light }]}>
            <FontAwesome5 name="user-lock" size={26} color={ACCENT} />
          </View>
          <Text style={styles.gateTitle}>Sign in to add a variation</Text>
          <Text style={styles.gateBody}>
            You need an account to share a local spelling, pronunciation or
            recording. It only takes a moment.
          </Text>
          <Button
            label="Sign in"
            icon="sign-in-alt"
            color={ACCENT}
            fullWidth
            onPress={() => router.replace({
              pathname: '/(auth)/sign-in',
              params: { next: `/spik-add-variation?id=${id}&word=${word}` },
            })}
            style={{ marginTop: spacing.md }}
          />
        </View>
      </SafeAreaView>
    );
  }

  // ── Success ────────────────────────────────────────────────────────────────
  if (submitted) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.navy }]} edges={['top', 'bottom']}>
        <Animated.View style={[styles.successWrap, { opacity: successOpacity, transform: [{ scale: successScale }] }]}>
          <View style={[styles.successIcon, { backgroundColor: SECTIONS.spik.light }]}>
            <FontAwesome5 name="check" size={28} color={ACCENT} />
          </View>
          <Text style={styles.successTitle}>Thank you!</Text>
          <Text style={styles.successBody}>
            Your variation of "{word}" has been submitted for review.{'\n\n'}
            {showName && submitterName.trim()
              ? `Once approved, "${submitterName.trim()}" will appear as the contributor.`
              : 'Once reviewed, it will appear on this word grouped by region.'}
          </Text>
          <TouchableOpacity style={[styles.doneBtn, { backgroundColor: ACCENT }]} onPress={() => router.back()}>
            <Text style={styles.doneBtnText}>Back to word</Text>
          </TouchableOpacity>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ── Form ───────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader
        title="Add a local variation"
        subtitle={word}
        onClose={() => router.back()}
        accent={ACCENT}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.body, contentContainer(screenWidth)]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <View style={styles.infoCard}>
            <Text style={styles.infoText}>
              Some words are said or spelled differently around Shetland. Share
              how it's said where you're from — pick your region and add a local
              spelling or a recording of the word.
            </Text>
          </View>

          {/* Region (required) */}
          <View style={[styles.card, !!regionId && { borderColor: ACCENT, borderWidth: 1.5 }]}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardLabel}>Region</Text>
              <Text style={styles.requiredTag}>Required</Text>
            </View>
            <Text style={styles.cardHint}>Which part of Shetland is this variation from?</Text>
            {regions.length === 0 ? (
              <ActivityIndicator color={ACCENT} style={{ marginTop: 8 }} />
            ) : (
              <View style={styles.chipGrid}>
                {regions.map(r => {
                  const active = regionId === r.id;
                  return (
                    <TouchableOpacity
                      key={r.id}
                      style={[styles.chip, active && { backgroundColor: ACCENT, borderColor: ACCENT }]}
                      onPress={() => pickRegion(r)}
                      activeOpacity={0.75}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>{r.name}</Text>
                      {active && <FontAwesome5 name="check" size={9} color="#fff" style={{ marginLeft: 4 }} />}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>

          {/* Local spelling */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Local spelling</Text>
            <Text style={styles.cardHint}>How the word is written where you're from</Text>
            <TextInput
              style={styles.input}
              value={variantSpelling}
              onChangeText={setVariantSpelling}
              placeholder="e.g. a local spelling"
              placeholderTextColor={colors.textLight}
              autoCorrect={false}
            />
          </View>

          {/* Pronunciation */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Pronunciation</Text>
            <Text style={styles.cardHint}>e.g. AHB-er (caps = stressed syllable)</Text>
            <TextInput
              style={styles.input}
              value={pronunciation}
              onChangeText={setPronunciation}
              placeholder="How it sounds"
              placeholderTextColor={colors.textLight}
              autoCorrect={false}
            />
          </View>

          {/* Word audio */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Say the word</Text>
            <Text style={styles.cardHint}>Record yourself saying the word out loud</Text>
            {wordAudio ? (
              <AudioReady label="Word recording added" onRedo={() => setWordAudio(null)} />
            ) : (
              <VoiceRecorder onFinish={(file) => setWordAudio(file)} />
            )}
          </View>

          {/* Example sentence */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Example sentence</Text>
            <Text style={styles.cardHint}>A natural sentence using the word (optional)</Text>
            <TextInput
              style={[styles.input, styles.inputMulti]}
              value={sentenceText}
              onChangeText={setSentenceText}
              placeholder="Use it in a sentence…"
              placeholderTextColor={colors.textLight}
              multiline
              numberOfLines={3}
              autoCorrect={false}
            />
          </View>

          {/* Sentence audio */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Say the sentence</Text>
            <Text style={styles.cardHint}>Record the example sentence out loud (optional)</Text>
            {sentenceAudio ? (
              <AudioReady label="Sentence recording added" onRedo={() => setSentenceAudio(null)} />
            ) : (
              <VoiceRecorder onFinish={(file) => setSentenceAudio(file)} />
            )}
          </View>

          {/* Attribution */}
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Your name</Text>
            <Text style={styles.cardHint}>Shetland dialect is a community project. Let people know you helped.</Text>
            <TextInput
              style={styles.input}
              value={submitterName}
              onChangeText={setSubmitterName}
              placeholder="Your name (optional)"
              placeholderTextColor={colors.textLight}
              autoCorrect={false}
            />
            <View style={styles.showNameRow}>
              <View style={styles.showNameLeft}>
                <Text style={styles.showNameLabel}>Show my name on this variation</Text>
                <Text style={styles.showNameHint}>
                  {showName ? 'Your name will appear as a contributor' : 'Your contribution will be anonymous'}
                </Text>
              </View>
              <Switch
                value={showName}
                onValueChange={val => { Haptics.selectionAsync(); setShowName(val); }}
                trackColor={{ false: colors.border, true: ACCENT }}
                thumbColor="#fff"
              />
            </View>
          </View>

          <Text style={styles.communityNote}>
            Nothing goes live until it has been reviewed. Thanks for helping keep
            Shetland dialect alive.
          </Text>

          <Button
            label={canSubmit ? 'Submit variation for review' : 'Choose a region and add a spelling or recording'}
            icon="paper-plane"
            color={ACCENT}
            fullWidth
            loading={submitting}
            disabled={!canSubmit || submitting}
            onPress={handleSubmit}
            style={styles.submitBtn}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function AudioReady({ label, onRedo }: { label: string; onRedo: () => void }) {
  return (
    <View style={styles.audioReadyRow}>
      <View style={styles.audioReadyLeft}>
        <FontAwesome5 name="check-circle" size={16} color={colors.success} solid />
        <Text style={styles.audioReadyText}>{label}</Text>
      </View>
      <TouchableOpacity onPress={onRedo} hitSlop={8} style={styles.redoBtn}>
        <FontAwesome5 name="redo" size={11} color={ACCENT} />
        <Text style={styles.redoText}>Re-record</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.screenBackground },

  body: { padding: spacing.md, gap: 10, paddingBottom: 40, backgroundColor: colors.screenBackground },

  infoCard: { backgroundColor: '#fff', borderRadius: radius.lg, padding: spacing.md },
  infoText: { color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 20 },

  card: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: 8,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardLabel: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '700' },
  requiredTag: { color: ACCENT, fontSize: fontSize.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  cardHint: { color: colors.textLight, fontSize: fontSize.xs },

  input: {
    borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: fontSize.md, color: colors.textPrimary,
  },
  inputMulti: { minHeight: 80, textAlignVertical: 'top' },

  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  chip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: radius.full, borderWidth: 1.5,
    borderColor: colors.border, backgroundColor: colors.offWhite,
  },
  chipText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600' },
  chipTextActive: { color: '#fff' },

  audioReadyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  audioReadyLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  audioReadyText: { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '600' },
  redoBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
  redoText: { color: ACCENT, fontSize: fontSize.sm, fontWeight: '700' },

  showNameRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 2 },
  showNameLeft: { flex: 1 },
  showNameLabel: { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '600' },
  showNameHint: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },

  communityNote: {
    color: colors.textLight, fontSize: fontSize.xs,
    lineHeight: 18, textAlign: 'center', paddingHorizontal: spacing.md,
  },
  submitBtn: { marginTop: 4 },

  // Auth gate
  gate: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, backgroundColor: colors.screenBackground },
  gateIcon: { width: 68, height: 68, borderRadius: 34, justifyContent: 'center', alignItems: 'center', marginBottom: 18 },
  gateTitle: { color: colors.textPrimary, fontSize: fontSize.xl, fontWeight: '800', textAlign: 'center' },
  gateBody: { color: colors.textMuted, fontSize: fontSize.md, lineHeight: 22, textAlign: 'center', marginTop: 10 },

  // Success
  successWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 16 },
  successIcon: { width: 72, height: 72, borderRadius: 36, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  successTitle: { color: '#fff', fontSize: fontSize.xxxl, fontWeight: '900' },
  successBody: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.md, lineHeight: 24, textAlign: 'center' },
  doneBtn: { borderRadius: radius.full, paddingHorizontal: 32, paddingVertical: 14, marginTop: 8 },
  doneBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
});
