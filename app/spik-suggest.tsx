/**
 * spik-suggest.tsx
 *
 * Suggestion form for improving a Spik dictionary entry.
 * Select fields use chip pickers; free-text fields use text inputs.
 * Suggestions stored in spik_suggestions (Supabase), reviewed in WordPress.
 */

import React, { useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Switch,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Animated,
  Easing,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, router } from 'expo-router';
import { colors, fontSize, radius, spacing, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { SECTIONS } from '@/constants/sections';
import { paletteFor } from '@/lib/spik-palette';

const SUPABASE_URL      = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

// ── Field definitions ─────────────────────────────────────────────────────────

type FieldType = 'text' | 'multiline' | 'select';

interface SuggestField {
  name:      string;
  label:     string;
  hint:      string;
  type:      FieldType;
  options?:  string[];   // for select fields
  hasOther?: boolean;    // shows free-text fallback after chips
}

const FIELDS: SuggestField[] = [
  {
    name: 'short_meaning', label: 'Meaning (short)', type: 'text',
    hint: 'A concise English definition',
  },
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
  currentValue,
  value,
  onChange,
  accentColor,
}: {
  field: SuggestField;
  currentValue: string;
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
          {currentValue ? (
            <View style={styles.currentWrap}>
              <Text style={styles.currentLabel}>CURRENT</Text>
              <Text style={styles.currentValue} numberOfLines={2}>{currentValue}</Text>
            </View>
          ) : null}

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
              placeholder={`Your suggestion…`}
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

export default function SpikSuggestScreen() {
  const params = useLocalSearchParams<{
    id: string; word: string; pos: string;
    short_meaning: string; spik_meaning: string; example_sentence: string;
    pronunciation: string; alternate_spelling: string; part_of_speech: string;
    origin: string; era: string; tone: string; category: string; usage_level: string;
  }>();

  const pal = paletteFor(params.pos);
  const { screenWidth } = useAppLayout();

  const [suggestions, setSuggestions] = useState<Record<string, string>>(
    Object.fromEntries(FIELDS.map(f => [f.name, '']))
  );
  const [submitterName, setSubmitterName] = useState('');
  const [showName, setShowName]           = useState(true);
  const [submitting, setSubmitting]       = useState(false);
  const [submitted, setSubmitted]         = useState(false);

  const successScale   = useRef(new Animated.Value(0)).current;
  const successOpacity = useRef(new Animated.Value(0)).current;

  const currentValue = (field: string): string => (params as any)[field] ?? '';

  const hasSuggestions  = FIELDS.some(f => suggestions[f.name]?.trim().length > 0);
  const suggestionCount = FIELDS.filter(f => suggestions[f.name]?.trim().length > 0).length;

  const handleSubmit = useCallback(async () => {
    if (!hasSuggestions) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSubmitting(true);

    const rows = FIELDS
      .filter(f => suggestions[f.name]?.trim().length > 0)
      .map(f => ({
        word_id:         Number(params.id),
        word:            params.word ?? '',
        field_name:      f.name,
        field_label:     f.label,
        current_value:   currentValue(f.name) || null,
        suggested_value: suggestions[f.name].trim(),
        submitter_name:  submitterName.trim() || null,
        show_name:       showName,
        status:          'pending',
      }));

    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/spik_suggestions`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Prefer':        'return=minimal',
        },
        body: JSON.stringify(rows),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      setSubmitted(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Animated.parallel([
        Animated.spring(successScale,   { toValue: 1, friction: 5, tension: 100, useNativeDriver: true }),
        Animated.timing(successOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      ]).start();

    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Something went wrong', 'Please try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  }, [suggestions, submitterName, showName, hasSuggestions, params]);

  // ── Success ────────────────────────────────────────────────────────────────

  if (submitted) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.navy }]} edges={['top', 'bottom']}>
        <Animated.View style={[styles.successWrap, { opacity: successOpacity, transform: [{ scale: successScale }] }]}>
          <View style={[styles.successIcon, { backgroundColor: pal.bg }]}>
            <FontAwesome5 name="check" size={28} color={pal.bar} />
          </View>
          <Text style={styles.successTitle}>Thank you!</Text>
          <Text style={styles.successBody}>
            Your suggestion{suggestionCount > 1 ? 's have' : ' has'} been submitted for review.{'\n\n'}
            {showName && submitterName.trim()
              ? `If approved, "${submitterName.trim()}" will appear as a contributor on "${params.word}".`
              : `Once reviewed, any approved changes will appear on "${params.word}".`}
          </Text>
          <TouchableOpacity style={[styles.doneBtn, { backgroundColor: pal.bar }]} onPress={() => router.back()}>
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
        title="Suggest an improvement"
        subtitle={params.pos ? `${params.word} · ${params.pos}` : params.word}
        onClose={() => router.back()}
        accent={SECTIONS.spik.color}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>

        <ScrollView contentContainerStyle={[styles.body, contentContainer(screenWidth)]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">

          <View style={styles.infoCard}>
            <View style={styles.infoBullets}>
              <InfoRow icon="edit"      text="Suggest one or more improvements in one go"         color={pal.bar} />
              <InfoRow icon="eye"       text="See the current value beside your suggestion"        color={pal.bar} />
              <InfoRow icon="shield-alt" text="Nothing goes live until it has been reviewed"       color={pal.bar} />
            </View>
          </View>

          <Text style={styles.sectionTitle}>What would you like to improve?</Text>

          {FIELDS.map(field => (
            <FieldRow
              key={field.name}
              field={field}
              currentValue={currentValue(field.name)}
              value={suggestions[field.name] ?? ''}
              onChange={val => setSuggestions(prev => ({ ...prev, [field.name]: val }))}
              accentColor={pal.bar}
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
                trackColor={{ false: colors.border, true: pal.bar }}
                thumbColor="#fff"
              />
            </View>
          </View>

          <Text style={styles.communityNote}>
            Community suggestions help keep Spik accurate and alive. Shetland dialect belongs to everyone — help us get it right.
          </Text>

          <Button
            label={hasSuggestions
              ? `Send ${suggestionCount} suggestion${suggestionCount > 1 ? 's' : ''} for review`
              : 'Open a field above to get started'}
            icon="paper-plane"
            color={SECTIONS.spik.color}
            fullWidth
            loading={submitting}
            disabled={!hasSuggestions || submitting}
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

  header: {
    backgroundColor: '#fff',
    paddingHorizontal: spacing.md, paddingTop: 8, paddingBottom: 14,
    borderBottomWidth: 3, gap: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4, elevation: 3,
  },
  backBtn:    { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  backText:   { fontSize: fontSize.sm, fontWeight: '600' },
  headerMid:  { gap: 6 },
  headerTitle:{ color: colors.textPrimary, fontSize: fontSize.lg, fontWeight: '800' },
  wordPill:   { flexDirection: 'row', alignItems: 'center', gap: 6 },
  posDot:     { width: 8, height: 8, borderRadius: 4 },
  wordPillText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '700' },
  wordPillPos:  { fontSize: fontSize.xs, fontWeight: '600' },

  body: { padding: spacing.md, gap: 10, paddingBottom: 40 },

  infoCard:    { backgroundColor: '#fff', borderRadius: radius.lg, padding: spacing.md },
  infoBullets: { gap: 10 },
  infoRow:     { flexDirection: 'row', alignItems: 'center', gap: 10 },
  infoIconWrap:{ width: 28, height: 28, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  infoText:    { color: colors.textSecondary, fontSize: fontSize.sm, flex: 1 },

  sectionTitle: { color: colors.textMuted, fontSize: fontSize.xs, fontWeight: '700', letterSpacing: 1, paddingHorizontal: 4, marginTop: 6 },

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
  currentWrap: { backgroundColor: colors.offWhite, borderRadius: radius.sm, padding: 10 },
  currentLabel:{ color: colors.textLight, fontSize: fontSize.xs, fontWeight: '600', marginBottom: 3 },
  currentValue:{ color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 18 },
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
  submitBtn: {
    marginTop: 4,
  },

  // Success
  successWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 16 },
  successIcon: { width: 72, height: 72, borderRadius: 36, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  successTitle: { color: '#fff', fontSize: fontSize.xxxl, fontWeight: '900' },
  successBody:  { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.md, lineHeight: 24, textAlign: 'center' },
  doneBtn:      { borderRadius: radius.full, paddingHorizontal: 32, paddingVertical: 14, marginTop: 8 },
  doneBtnText:  { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
});
