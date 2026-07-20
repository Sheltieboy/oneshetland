/**
 * spik-add.tsx
 *
 * "Add a wird" — community form for proposing a brand-new Spik dictionary entry.
 * Signed-in only: the row is stamped with the submitter's id so RLS allows the
 * insert (submitter_id = auth.uid()). Select fields use chip pickers; free-text
 * fields use text inputs. New words land in spik_word_submissions (status
 * 'pending') and are reviewed before they go live.
 *
 * Mirrors the structure, theme usage and success state of spik-suggest.tsx.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
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
  Easing,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import type { User } from '@supabase/supabase-js';
import { track } from '@/lib/analytics';
import { colors, fontSize, radius, spacing, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { useAlert } from '@/components/BrandedAlert';
import { SECTIONS } from '@/constants/sections';
import { supabase } from '@/lib/supabase';

const ACCENT = SECTIONS.spik.color;

// ── Field definitions ─────────────────────────────────────────────────────────

type FieldType = 'text' | 'multiline' | 'select';

interface AddField {
  name:      string;
  label:     string;
  hint:      string;
  type:      FieldType;
  options?:  string[];   // for select fields
  hasOther?: boolean;    // shows free-text fallback after chips
}

// Optional detail fields — same option lists as spik-suggest.tsx. The required
// headword (`word`) and `short_meaning` are handled as prominent inputs above.
const FIELDS: AddField[] = [
  {
    name: 'spik_meaning', label: 'Full Shetland meaning', type: 'multiline',
    hint: 'A richer explanation in context',
  },
  {
    name: 'example_sentence', label: 'Example in use', type: 'text',
    hint: 'A natural sentence using this word',
  },
  {
    name: 'pronunciation', label: 'Pronunciation', type: 'text',
    hint: 'e.g. AHB-er  (caps = stressed syllable)',
  },
  {
    name: 'alternate_spelling', label: 'Alternate spelling', type: 'text',
    hint: 'Another way this word is written',
  },
  {
    name: 'part_of_speech', label: 'Part of speech', type: 'select',
    hint: 'Select the closest match',
    hasOther: true,
    options: [
      'noun', 'verb', 'adjective', 'adverb', 'pronoun',
      'preposition', 'interjection', 'determiner', 'conjunction',
      'auxiliary verb', 'phrase',
    ],
  },
  {
    name: 'category', label: 'Category', type: 'select',
    hint: 'What topic does this word relate to?',
    options: [
      'action', 'quality', 'people', 'animals', 'body', 'sea', 'object',
      'nature', 'food', 'emotion', 'home', 'time', 'weather', 'work',
      'place', 'clothing',
    ],
  },
  {
    name: 'usage_level', label: 'Usage level', type: 'select',
    hint: 'How commonly is this word used today?',
    options: ['common', 'known', 'less common', 'rare'],
  },
  {
    name: 'era', label: 'Era', type: 'select',
    hint: 'Is this word still in everyday use?',
    options: ['current', 'older', 'archaic'],
  },
  {
    name: 'tone', label: 'Tone', type: 'select',
    hint: 'What feeling does this word carry?',
    options: ['neutral', 'affectionate', 'warm', 'humorous', 'harsh', 'insult'],
  },
  {
    name: 'origin', label: 'Origin', type: 'select',
    hint: 'Where does this word come from?',
    options: ['scots', 'old norse', 'unknown'],
  },
];

// ── Chip picker ───────────────────────────────────────────────────────────────

function ChipPicker({
  options,
  value,
  onChange,
  accentColor,
  hasOther,
}: {
  options: string[];
  value: string;
  onChange: (val: string) => void;
  accentColor: string;
  hasOther?: boolean;
}) {
  const [otherText, setOtherText] = useState('');
  const isOther = value !== '' && !options.includes(value);

  const handleChip = (opt: string) => {
    Haptics.selectionAsync();
    onChange(value === opt ? '' : opt);
  };

  const handleOtherChange = (text: string) => {
    setOtherText(text);
    onChange(text);
  };

  return (
    <View style={styles.chipWrap}>
      <View style={styles.chipGrid}>
        {options.map(opt => {
          const active = value === opt;
          return (
            <TouchableOpacity
              key={opt}
              style={[styles.chip, active && { backgroundColor: accentColor, borderColor: accentColor }]}
              onPress={() => handleChip(opt)}
              activeOpacity={0.75}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {opt}
              </Text>
              {active && <FontAwesome5 name="check" size={9} color="#fff" style={{ marginLeft: 4 }} />}
            </TouchableOpacity>
          );
        })}
        {hasOther && (
          <TouchableOpacity
            style={[styles.chip, styles.chipOther, isOther && { borderColor: accentColor }]}
            onPress={() => { if (!isOther) { Haptics.selectionAsync(); onChange(' '); } }}
            activeOpacity={0.75}
          >
            <Text style={[styles.chipText, isOther && { color: accentColor }]}>Other…</Text>
          </TouchableOpacity>
        )}
      </View>
      {hasOther && isOther && (
        <TextInput
          style={[styles.input, { borderColor: accentColor, marginTop: 8 }]}
          value={otherText || (isOther ? value.trim() : '')}
          onChangeText={handleOtherChange}
          placeholder="Describe it…"
          placeholderTextColor={colors.textLight}
          autoCorrect={false}
          autoFocus
        />
      )}
    </View>
  );
}

// ── Field row ─────────────────────────────────────────────────────────────────

function FieldRow({
  field,
  value,
  onChange,
  accentColor,
}: {
  field: AddField;
  value: string;
  onChange: (val: string) => void;
  accentColor: string;
}) {
  const [open, setOpen] = useState(false);
  const heightAnim = useRef(new Animated.Value(0)).current;
  const hasValue   = value.trim().length > 0;

  const contentHeight = field.type === 'select'
    ? field.options!.length > 8 ? 280 : 220
    : field.type === 'multiline' ? 340 : 200;

  const toggle = () => {
    Haptics.selectionAsync();
    const opening = !open;
    setOpen(opening);
    Animated.timing(heightAnim, {
      toValue: opening ? 1 : 0,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  };

  const maxHeight = heightAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, contentHeight],
  });

  return (
    <View style={[styles.fieldCard, hasValue && { borderColor: accentColor, borderWidth: 1.5 }]}>
      <TouchableOpacity style={styles.fieldHeader} onPress={toggle} activeOpacity={0.7}>
        <View style={styles.fieldHeaderLeft}>
          {hasValue && <View style={[styles.dot, { backgroundColor: accentColor }]} />}
          <Text style={[styles.fieldLabel, hasValue && { color: accentColor }]}>{field.label}</Text>
          {hasValue && field.type === 'select' && (
            <View style={[styles.selectedPill, { backgroundColor: accentColor + '20', borderColor: accentColor + '60', borderWidth: 1 }]}>
              <Text style={[styles.selectedPillText, { color: accentColor }]}>{value}</Text>
            </View>
          )}
        </View>
        <FontAwesome5
          name={open ? 'chevron-up' : 'chevron-down'}
          size={11}
          color={open ? accentColor : colors.textLight}
        />
      </TouchableOpacity>

      <Animated.View style={{ maxHeight, overflow: 'hidden' }}>
        <View style={styles.fieldBody}>
          <Text style={styles.inputHint}>{field.hint}</Text>

          {field.type === 'select' ? (
            <ChipPicker
              options={field.options!}
              value={value}
              onChange={onChange}
              accentColor={accentColor}
              hasOther={field.hasOther}
            />
          ) : (
            <TextInput
              style={[
                styles.input,
                field.type === 'multiline' && styles.inputMulti,
                open && { borderColor: accentColor },
              ]}
              value={value}
              onChangeText={onChange}
              placeholder="Type here…"
              placeholderTextColor={colors.textLight}
              multiline={field.type === 'multiline'}
              numberOfLines={field.type === 'multiline' ? 4 : 1}
              autoCorrect={false}
            />
          )}
        </View>
      </Animated.View>
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function SpikAddScreen() {
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();

  const [checking, setChecking] = useState(true);
  const [user, setUser]         = useState<User | null>(null);

  const [word, setWord]                 = useState('');
  const [shortMeaning, setShortMeaning] = useState('');
  const [details, setDetails] = useState<Record<string, string>>(
    Object.fromEntries(FIELDS.map(f => [f.name, '']))
  );
  const [submitterName, setSubmitterName] = useState('');
  const [showName, setShowName]           = useState(true);
  const [submitting, setSubmitting]       = useState(false);
  const [submitted, setSubmitted]         = useState(false);

  const successScale   = useRef(new Animated.Value(0)).current;
  const successOpacity = useRef(new Animated.Value(0)).current;

  // ── Auth check ───────────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!active) return;
      setUser(user);
      if (user) {
        const meta = user.user_metadata ?? {};
        setSubmitterName(meta.display_name || meta.full_name || '');
      }
      setChecking(false);
    })();
    return () => { active = false; };
  }, []);

  const canSubmit = word.trim().length > 0 && shortMeaning.trim().length > 0;

  const handleSubmit = useCallback(async () => {
    if (!user || !canSubmit) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSubmitting(true);

    const row: Record<string, any> = {
      word:           word.trim(),
      submitter_id:   user.id,
      submitter_name: submitterName.trim() || null,
      show_name:      showName,
      status:         'pending',
      short_meaning:  shortMeaning.trim(),
    };

    // Map each non-empty optional field to its column name.
    for (const f of FIELDS) {
      const val = details[f.name]?.trim();
      if (val) row[f.name] = val;
    }

    try {
      const { error } = await supabase.from('spik_word_submissions').insert(row);
      if (error) throw error;

      track('spik_word_submitted', {});
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
  }, [user, canSubmit, word, shortMeaning, details, submitterName, showName, alert, successScale, successOpacity]);

  // ── Loading (auth check) ────────────────────────────────────────────────────

  if (checking) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScreenHeader title="Add a wird" onClose={() => router.back()} accent={ACCENT} />
        <View style={styles.center}><ActivityIndicator size="large" color={ACCENT} /></View>
      </SafeAreaView>
    );
  }

  // ── Signed-out gate ─────────────────────────────────────────────────────────

  if (!user) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScreenHeader title="Add a wird" onClose={() => router.back()} accent={ACCENT} />
        <View style={styles.gateWrap}>
          <View style={[styles.gateIcon, { backgroundColor: SECTIONS.spik.light }]}>
            <FontAwesome5 name="book" size={28} color={ACCENT} solid />
          </View>
          <Text style={styles.gateTitle}>Sign in to add a word</Text>
          <Text style={styles.gateBody}>
            You'll need an account so we can credit your contribution and keep Spik trustworthy.
          </Text>
          <Button
            label="Sign in"
            icon="sign-in-alt"
            color={ACCENT}
            onPress={() => router.replace({ pathname: '/(auth)/sign-in', params: { next: '/spik-add' } })}
            style={styles.gateBtn}
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
            "{word.trim()}" has been submitted for review.{'\n\n'}
            {showName && submitterName.trim()
              ? `If approved, "${submitterName.trim()}" will appear as a contributor on this word.`
              : `Once reviewed, approved words are added to Spik.`}
          </Text>
          <TouchableOpacity style={[styles.doneBtn, { backgroundColor: ACCENT }]} onPress={() => router.back()}>
            <Text style={styles.doneBtnText}>Back to Spik</Text>
          </TouchableOpacity>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ── Form ───────────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader
        title="Add a wird"
        subtitle="Propose a new dictionary entry"
        onClose={() => router.back()}
        accent={ACCENT}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

        <ScrollView contentContainerStyle={[styles.body, contentContainer(screenWidth)]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">

          <View style={styles.infoCard}>
            <View style={styles.infoBullets}>
              <InfoRow icon="plus"       text="Add a word that's missing from Spik"          color={ACCENT} />
              <InfoRow icon="align-left" text="A word and a short meaning is all you need"    color={ACCENT} />
              <InfoRow icon="shield-alt" text="Nothing goes live until it has been reviewed"  color={ACCENT} />
            </View>
          </View>

          {/* Required: headword */}
          <View style={styles.requiredCard}>
            <View style={styles.requiredLabelRow}>
              <Text style={styles.requiredLabel}>The word</Text>
              <View style={[styles.reqPill, { backgroundColor: ACCENT + '18' }]}>
                <Text style={[styles.reqPillText, { color: ACCENT }]}>Required</Text>
              </View>
            </View>
            <TextInput
              style={styles.wordInput}
              value={word}
              onChangeText={setWord}
              placeholder="e.g. peerie"
              placeholderTextColor={colors.textLight}
              autoCorrect={false}
              autoCapitalize="none"
            />
          </View>

          {/* Required: short meaning */}
          <View style={styles.requiredCard}>
            <View style={styles.requiredLabelRow}>
              <Text style={styles.requiredLabel}>Meaning (short)</Text>
              <View style={[styles.reqPill, { backgroundColor: ACCENT + '18' }]}>
                <Text style={[styles.reqPillText, { color: ACCENT }]}>Required</Text>
              </View>
            </View>
            <Text style={styles.inputHint}>A concise English definition</Text>
            <TextInput
              style={styles.input}
              value={shortMeaning}
              onChangeText={setShortMeaning}
              placeholder="e.g. small, little"
              placeholderTextColor={colors.textLight}
              autoCorrect={false}
            />
          </View>

          <Text style={styles.sectionTitle}>Add more detail (optional)</Text>

          {FIELDS.map(field => (
            <FieldRow
              key={field.name}
              field={field}
              value={details[field.name] ?? ''}
              onChange={val => setDetails(prev => ({ ...prev, [field.name]: val }))}
              accentColor={ACCENT}
            />
          ))}

          <View style={styles.attributionCard}>
            <Text style={styles.attrTitle}>Your name</Text>
            <Text style={styles.attrSubtitle}>
              Shetland dialect is a community project. Let people know you helped.
            </Text>
            <TextInput
              style={styles.nameInput}
              value={submitterName}
              onChangeText={setSubmitterName}
              placeholder="Your name (optional)"
              placeholderTextColor={colors.textLight}
              autoCorrect={false}
            />
            <View style={styles.showNameRow}>
              <View style={styles.showNameLeft}>
                <Text style={styles.showNameLabel}>Show my name on this word</Text>
                <Text style={styles.showNameHint}>
                  {showName ? 'Your name will appear as a contributor hint' : 'Your contribution will be anonymous'}
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
            New words help keep Spik growing. Shetland dialect belongs to everyone — help us capture it.
          </Text>

          <Button
            label={canSubmit ? 'Send for review' : 'Add the word and a meaning'}
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

function InfoRow({ icon, text, color }: { icon: string; text: string; color: string }) {
  return (
    <View style={styles.infoRow}>
      <View style={[styles.infoIconWrap, { backgroundColor: color + '18' }]}>
        <FontAwesome5 name={icon} size={11} color={color} />
      </View>
      <Text style={styles.infoText}>{text}</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },

  center: { flex: 1, backgroundColor: colors.screenBackground, justifyContent: 'center', alignItems: 'center' },

  body: { padding: spacing.md, gap: 10, paddingBottom: 40 },

  infoCard:    { backgroundColor: '#fff', borderRadius: radius.lg, padding: spacing.md },
  infoBullets: { gap: 10 },
  infoRow:     { flexDirection: 'row', alignItems: 'center', gap: 10 },
  infoIconWrap:{ width: 28, height: 28, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  infoText:    { color: colors.textSecondary, fontSize: fontSize.sm, flex: 1 },

  sectionTitle: { color: colors.textMuted, fontSize: fontSize.xs, fontWeight: '700', letterSpacing: 1, paddingHorizontal: 4, marginTop: 6 },

  // Required cards (word + short meaning)
  requiredCard: {
    backgroundColor: '#fff', borderRadius: radius.lg, padding: spacing.md, gap: 8,
  },
  requiredLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  requiredLabel: { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '800' },
  reqPill:     { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.full },
  reqPillText: { fontSize: fontSize.xs, fontWeight: '700' },
  wordInput: {
    borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 12,
    fontSize: fontSize.xl, fontWeight: '800', color: colors.textPrimary,
  },

  // Field cards
  fieldCard: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  },
  fieldHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 14,
  },
  fieldHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, flexWrap: 'wrap' },
  dot:          { width: 7, height: 7, borderRadius: 4 },
  fieldLabel:   { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '600' },
  selectedPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.full },
  selectedPillText: { fontSize: fontSize.xs, fontWeight: '700', textTransform: 'capitalize' },

  fieldBody:   { paddingHorizontal: 14, paddingBottom: 14, gap: 8 },
  inputHint:   { color: colors.textLight, fontSize: fontSize.xs },
  input: {
    borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: fontSize.md, color: colors.textPrimary,
  },
  inputMulti: { minHeight: 90, textAlignVertical: 'top' },

  // Chips
  chipWrap: { gap: 8 },
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: radius.full, borderWidth: 1.5,
    borderColor: colors.border, backgroundColor: colors.offWhite,
  },
  chipOther:     { borderStyle: 'dashed' },
  chipText:      { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600', textTransform: 'capitalize' },
  chipTextActive:{ color: '#fff' },

  // Attribution
  attributionCard: { backgroundColor: '#fff', borderRadius: radius.lg, padding: spacing.md, gap: 10 },
  attrTitle:    { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '800' },
  attrSubtitle: { color: colors.textMuted, fontSize: fontSize.sm, lineHeight: 18 },
  nameInput: {
    borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: fontSize.md, color: colors.textPrimary,
  },
  showNameRow:  { flexDirection: 'row', alignItems: 'center', gap: 12 },
  showNameLeft: { flex: 1 },
  showNameLabel:{ color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '600' },
  showNameHint: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },

  communityNote: {
    color: colors.textLight, fontSize: fontSize.xs,
    lineHeight: 18, textAlign: 'center', paddingHorizontal: spacing.md,
  },
  submitBtn: { marginTop: 4 },

  // Signed-out gate
  gateWrap: { flex: 1, backgroundColor: colors.screenBackground, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 14 },
  gateIcon: { width: 72, height: 72, borderRadius: 36, justifyContent: 'center', alignItems: 'center', marginBottom: 4 },
  gateTitle: { color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: '900', textAlign: 'center' },
  gateBody:  { color: colors.textMuted, fontSize: fontSize.sm, textAlign: 'center', lineHeight: 21 },
  gateBtn:   { marginTop: 8 },

  // Success
  successWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 16 },
  successIcon: { width: 72, height: 72, borderRadius: 36, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  successTitle: { color: '#fff', fontSize: fontSize.xxxl, fontWeight: '900' },
  successBody:  { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.md, lineHeight: 24, textAlign: 'center' },
  doneBtn:      { borderRadius: radius.full, paddingHorizontal: 32, paddingVertical: 14, marginTop: 8 },
  doneBtnText:  { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
});
