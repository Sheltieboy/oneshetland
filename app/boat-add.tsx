/**
 * boat-add.tsx
 *
 * "Add a boat" — community submission for Da Boats.
 *
 * CRITICAL: Da Boats records the HULL — the physical vessel, which keeps its
 * identity across renames and re-registrations. The name is only the hull's
 * *current* name; former names are history on the SAME hull, not separate
 * boats. This form teaches that up front and guards against creating a
 * duplicate hull for a boat that's simply been renamed or re-registered:
 *   * a live duplicate search runs as the person types name + LK number,
 *   * matches surface in an amber "is it one of these already?" panel,
 *   * a match can be tapped through to its profile, or flagged "this is it"
 *     (stored as possible_duplicate_id),
 *   * if matches exist and none is picked, the person must acknowledge
 *     "none of these — this hull isn't listed yet" before they can submit.
 *
 * Submissions land in vessel_submissions (submission_status 'pending') and
 * are reviewed before anything joins the register.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  ActivityIndicator,
  Animated,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { searchVessels, VesselSearchRow, vesselDisplayTitle } from '@/lib/boats-api';
import { colors, fontSize, radius, spacing, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { useAlert } from '@/components/BrandedAlert';
import { SECTIONS } from '@/constants/sections';

const SECTION = SECTIONS.daBoats;
const ACCENT  = SECTION.color;

// Amber "possible duplicate" panel tones (mirrors the 'possible' confidence look).
const AMBER_BG     = '#FEF3C7';
const AMBER_BORDER = '#F59E0B';
const AMBER_TEXT   = '#92400E';

// Hull material chip options — label shown, single-letter CODE stored.
const HULL_OPTIONS: { label: string; code: string }[] = [
  { label: 'Wood',       code: 'W' },
  { label: 'Steel',      code: 'S' },
  { label: 'Fibreglass', code: 'F' },
  { label: 'Aluminium',  code: 'A' },
  { label: 'Other',      code: 'O' },
  { label: 'Unknown',    code: 'U' },
];

interface AuthUser {
  id: string;
  metaName: string;
}

export default function BoatAddScreen() {
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();

  // ── Auth gate ──────────────────────────────────────────────────────────────
  const [authChecked, setAuthChecked] = useState(false);
  const [user, setUser]               = useState<AuthUser | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: { user: u } } = await supabase.auth.getUser();
      if (!alive) return;
      if (u) {
        const meta = (u.user_metadata ?? {}) as Record<string, any>;
        setUser({
          id: u.id,
          metaName: meta.display_name ?? meta.full_name ?? '',
        });
        setSubmitterName(prev => prev || meta.display_name || meta.full_name || '');
      }
      setAuthChecked(true);
    })();
    return () => { alive = false; };
  }, []);

  // ── Form state ───────────────────────────────────────────────────────────────
  const [name, setName]                 = useState('');
  const [lk, setLk]                     = useState('');
  const [builtYear, setBuiltYear]       = useState('');
  const [hullMaterial, setHullMaterial] = useState('');   // single-letter code
  const [builder, setBuilder]           = useState('');
  const [yardNumber, setYardNumber]     = useState('');
  const [country, setCountry]           = useState('');
  const [statusText, setStatusText]     = useState('');
  const [formerNames, setFormerNames]   = useState('');
  const [notes, setNotes]               = useState('');
  const [submitterName, setSubmitterName] = useState('');
  const [showName, setShowName]           = useState(true);

  // ── Duplicate search ───────────────────────────────────────────────────────
  const [matches, setMatches]     = useState<VesselSearchRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [dupeId, setDupeId]       = useState<string | null>(null);
  const [ackNone, setAckNone]     = useState(false);

  // ── Submission ─────────────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted]   = useState(false);
  const successOpacity = useRef(new Animated.Value(0)).current;

  // Live, debounced duplicate search keyed on "name + lk".
  useEffect(() => {
    const term = `${name} ${lk}`.trim();
    if (term.length < 2) {
      setMatches([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const rows = await searchVessels(term, 6);
        setMatches(rows);
      } catch {
        setMatches([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [name, lk]);

  // A picked duplicate implies "yes it's listed", so clear the negative ack.
  const pickDupe = (idv: string) => {
    Haptics.selectionAsync();
    setDupeId(prev => {
      const next = prev === idv ? null : idv;
      if (next) setAckNone(false);
      return next;
    });
  };

  const parsedYear = (): number | null | 'invalid' => {
    const t = builtYear.trim();
    if (!t) return null;
    const n = Number(t);
    if (!Number.isInteger(n) || n < 1700 || n > 2100) return 'invalid';
    return n;
  };

  const nameOk       = name.trim().length > 0;
  const needsAck     = matches.length > 0 && !dupeId && !ackNone;
  const canSubmit    = nameOk && !needsAck && !submitting;

  const handleSubmit = useCallback(async () => {
    if (!user) { return; }
    if (!nameOk) {
      alert({ title: 'Boat name needed', message: 'Please add the boat’s current name.' });
      return;
    }
    if (needsAck) {
      alert({
        title: 'Is it one of these?',
        message: 'We found boats that might already be this hull. Pick the right one, or confirm none of them match before adding.',
      });
      return;
    }
    const year = parsedYear();
    if (year === 'invalid') {
      alert({ title: 'Check the year built', message: 'Enter a full year between 1700 and 2100, or leave it blank.' });
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSubmitting(true);
    try {
      const { error } = await supabase.from('vessel_submissions').insert({
        canonical_name:      name.trim(),
        primary_lk_number:   lk.trim() || null,
        built_year:          year,
        builder:             builder.trim() || null,
        yard_number:         yardNumber.trim() || null,
        hull_material:       hullMaterial || null,
        country_of_build:    country.trim() || null,
        status:              statusText.trim() || null,
        former_names:        formerNames.trim() || null,
        identity_notes:      notes.trim() || null,
        possible_duplicate_id: dupeId,
        submitter_id:        user.id,
        submitter_name:      submitterName.trim() || null,
        show_name:           showName,
        submission_status:   'pending',
      });
      if (error) throw error;

      setSubmitted(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Animated.timing(successOpacity, { toValue: 1, duration: 300, useNativeDriver: true }).start();
    } catch (err: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      alert({ title: 'Something went wrong', message: err?.message ?? 'Please try again in a moment.' });
    } finally {
      setSubmitting(false);
    }
  }, [
    user, nameOk, needsAck, name, lk, builtYear, builder, yardNumber, hullMaterial,
    country, statusText, formerNames, notes, dupeId, submitterName, showName, alert,
  ]);

  // ── Loading auth ─────────────────────────────────────────────────────────────
  if (!authChecked) {
    return (
      <SafeAreaView style={[styles.safe, styles.center]} edges={['top', 'bottom']}>
        <ActivityIndicator color={ACCENT} size="large" />
      </SafeAreaView>
    );
  }

  // ── Signed-out gate ──────────────────────────────────────────────────────────
  if (!user) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScreenHeader title="Add a boat" onClose={() => router.back()} accent={ACCENT} />
        <View style={styles.gateWrap}>
          <View style={[styles.gateIcon, { backgroundColor: SECTION.light }]}>
            <FontAwesome5 name="ship" size={30} color={ACCENT} />
          </View>
          <Text style={styles.gateTitle}>Sign in to add a boat</Text>
          <Text style={styles.gateBody}>
            You need an account so we can credit your contribution and keep the register trustworthy.
          </Text>
          <Button
            label="Sign in"
            icon="sign-in-alt"
            color={ACCENT}
            onPress={() => router.replace({ pathname: '/(auth)/sign-in', params: { next: '/boat-add' } })}
            style={{ marginTop: spacing.md }}
          />
        </View>
      </SafeAreaView>
    );
  }

  // ── Success ──────────────────────────────────────────────────────────────────
  if (submitted) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.navy }]} edges={['top', 'bottom']}>
        <Animated.View style={[styles.successWrap, { opacity: successOpacity }]}>
          <View style={[styles.successIcon, { backgroundColor: SECTION.light }]}>
            <FontAwesome5 name="check" size={28} color={ACCENT} />
          </View>
          <Text style={styles.successTitle}>Thank you!</Text>
          <Text style={styles.successBody}>
            “{name.trim()}” has been submitted for review. Once it’s checked, it’ll join the register
            in Da Boats.{'\n\n'}
            {showName && submitterName.trim()
              ? `We’ll credit “${submitterName.trim()}” for the addition.`
              : 'Your contribution helps keep the fleet’s history alive.'}
          </Text>
          <TouchableOpacity style={[styles.doneBtn, { backgroundColor: ACCENT }]} onPress={() => router.back()}>
            <Text style={styles.doneBtnText}>Back to Da Boats</Text>
          </TouchableOpacity>
        </Animated.View>
      </SafeAreaView>
    );
  }

  // ── Form ─────────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader
        title="Add a boat"
        subtitle="Da Boats · heritage register"
        onClose={() => router.back()}
        accent={ACCENT}
      />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[styles.body, contentContainer(screenWidth)]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          {/* Hull explainer */}
          <View style={[styles.explainer, { backgroundColor: SECTION.light, borderColor: ACCENT + '33' }]}>
            <View style={styles.explainerTop}>
              <View style={[styles.explainerIcon, { backgroundColor: ACCENT + '1F' }]}>
                <FontAwesome5 name="anchor" size={13} color={ACCENT} solid />
              </View>
              <Text style={[styles.explainerTitle, { color: ACCENT }]}>You’re adding a boat’s hull</Text>
            </View>
            <Text style={styles.explainerBody}>
              You’re adding a boat’s hull — the physical boat. A hull keeps the same identity even when
              it’s renamed or re-registered. Add the boat you know; if it’s carried other names, add
              those as former names below rather than as a separate boat. If it’s already listed under
              an old name, add your details there instead.
            </Text>
          </View>

          {/* Name + LK */}
          <View style={styles.card}>
            <FieldLabel label="Boat name (current)" required />
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Brilliant"
              placeholderTextColor={colors.textLight}
              autoCorrect={false}
              autoCapitalize="characters"
            />
            <Text style={styles.hint}>The name she carries now — former names go further down.</Text>

            <View style={{ height: spacing.md }} />

            <FieldLabel label="Registration / LK number" />
            <TextInput
              style={styles.input}
              value={lk}
              onChangeText={setLk}
              placeholder="e.g. LK123"
              placeholderTextColor={colors.textLight}
              autoCorrect={false}
              autoCapitalize="characters"
            />
          </View>

          {/* Duplicate search panel */}
          {(searching || matches.length > 0) && (
            <View style={styles.dupePanel}>
              <View style={styles.dupeHeaderRow}>
                <FontAwesome5 name="exclamation-triangle" size={13} color={AMBER_TEXT} solid />
                <Text style={styles.dupeTitle}>Is it one of these already?</Text>
                {searching ? <ActivityIndicator size="small" color={AMBER_TEXT} style={{ marginLeft: 'auto' }} /> : null}
              </View>
              <Text style={styles.dupeIntro}>
                A hull keeps its identity through renames. If your boat is here under any name, tap it to
                open its page and add your details there instead of creating a duplicate.
              </Text>

              {matches.map(m => {
                const picked = dupeId === m.id;
                const others = altNames(m);
                return (
                  <View key={m.id} style={[styles.dupeRow, picked && { borderColor: ACCENT, borderWidth: 1.5 }]}>
                    <TouchableOpacity
                      style={styles.dupeRowMain}
                      activeOpacity={0.7}
                      onPress={() => router.push(`/boat/${m.id}`)}
                    >
                      <Text style={styles.dupeName}>{vesselDisplayTitle(m)}</Text>
                      <Text style={styles.dupeMeta} numberOfLines={1}>
                        {[m.built_year ? `Built ${m.built_year}` : null, others]
                          .filter(Boolean).join('  ·  ') || 'Tap to view'}
                      </Text>
                      <View style={styles.dupeViewRow}>
                        <Text style={[styles.dupeViewText, { color: ACCENT }]}>View this boat</Text>
                        <FontAwesome5 name="chevron-right" size={9} color={ACCENT} />
                      </View>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.thisIsIt, picked && { backgroundColor: ACCENT, borderColor: ACCENT }]}
                      onPress={() => pickDupe(m.id)}
                      activeOpacity={0.8}
                    >
                      <FontAwesome5
                        name={picked ? 'check' : 'plus'}
                        size={10}
                        color={picked ? '#fff' : ACCENT}
                        solid
                      />
                      <Text style={[styles.thisIsItText, { color: picked ? '#fff' : ACCENT }]}>
                        {picked ? 'This is it' : 'This is it'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                );
              })}

              {matches.length > 0 && !dupeId ? (
                <TouchableOpacity
                  style={styles.ackRow}
                  onPress={() => { Haptics.selectionAsync(); setAckNone(v => !v); }}
                  activeOpacity={0.7}
                >
                  <View style={[styles.ackBox, ackNone && { backgroundColor: ACCENT, borderColor: ACCENT }]}>
                    {ackNone ? <FontAwesome5 name="check" size={11} color="#fff" /> : null}
                  </View>
                  <Text style={styles.ackText}>None of these — this hull isn’t listed yet</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          )}

          {/* Hull details */}
          <Text style={styles.sectionLabel}>The hull</Text>
          <View style={styles.card}>
            <FieldLabel label="Year built" />
            <TextInput
              style={styles.input}
              value={builtYear}
              onChangeText={setBuiltYear}
              placeholder="e.g. 1974"
              placeholderTextColor={colors.textLight}
              keyboardType="number-pad"
              maxLength={4}
            />

            <View style={{ height: spacing.md }} />

            <FieldLabel label="Hull material" />
            <View style={styles.chipGrid}>
              {HULL_OPTIONS.map(opt => {
                const active = hullMaterial === opt.code;
                return (
                  <TouchableOpacity
                    key={opt.code}
                    style={[styles.chip, active && { backgroundColor: ACCENT, borderColor: ACCENT }]}
                    onPress={() => { Haptics.selectionAsync(); setHullMaterial(active ? '' : opt.code); }}
                    activeOpacity={0.75}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{opt.label}</Text>
                    {active && <FontAwesome5 name="check" size={9} color="#fff" style={{ marginLeft: 4 }} />}
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={{ height: spacing.md }} />

            <FieldLabel label="Builder" />
            <TextInput
              style={styles.input}
              value={builder}
              onChangeText={setBuilder}
              placeholder="e.g. Herd & Mackenzie"
              placeholderTextColor={colors.textLight}
            />

            <View style={{ height: spacing.md }} />

            <FieldLabel label="Yard number" />
            <TextInput
              style={styles.input}
              value={yardNumber}
              onChangeText={setYardNumber}
              placeholder="e.g. 142"
              placeholderTextColor={colors.textLight}
            />

            <View style={{ height: spacing.md }} />

            <FieldLabel label="Country of build" />
            <TextInput
              style={styles.input}
              value={country}
              onChangeText={setCountry}
              placeholder="e.g. Scotland"
              placeholderTextColor={colors.textLight}
            />

            <View style={{ height: spacing.md }} />

            <FieldLabel label="Status" />
            <TextInput
              style={styles.input}
              value={statusText}
              onChangeText={setStatusText}
              placeholder="e.g. Active, Lost, Scrapped"
              placeholderTextColor={colors.textLight}
            />
          </View>

          {/* Identity / history */}
          <Text style={styles.sectionLabel}>Her history</Text>
          <View style={styles.card}>
            <FieldLabel label="Former names" />
            <TextInput
              style={[styles.input, styles.inputMulti]}
              value={formerNames}
              onChangeText={setFormerNames}
              placeholder="Other names she’s carried, separated by commas"
              placeholderTextColor={colors.textLight}
              multiline
            />
            <Text style={styles.hint}>These are the SAME hull under earlier names — not separate boats.</Text>

            <View style={{ height: spacing.md }} />

            <FieldLabel label="Anything else" />
            <TextInput
              style={[styles.input, styles.inputMulti]}
              value={notes}
              onChangeText={setNotes}
              placeholder="Registration history, how you know her, anything that helps identify the hull"
              placeholderTextColor={colors.textLight}
              multiline
            />
          </View>

          {/* Attribution */}
          <View style={styles.card}>
            <Text style={styles.attrTitle}>Your name</Text>
            <Text style={styles.attrSubtitle}>
              Da Boats is a community archive. Let folk know you helped.
            </Text>
            <TextInput
              style={[styles.input, { marginTop: 8 }]}
              value={submitterName}
              onChangeText={setSubmitterName}
              placeholder="Your name (optional)"
              placeholderTextColor={colors.textLight}
              autoCorrect={false}
            />
            <View style={styles.showNameRow}>
              <View style={styles.showNameLeft}>
                <Text style={styles.showNameLabel}>Credit me for this addition</Text>
                <Text style={styles.showNameHint}>
                  {showName ? 'Your name may appear as a contributor' : 'Your contribution will be anonymous'}
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
            Nothing goes into the register until it’s been reviewed. Thanks for helping keep the fleet’s
            history right.
          </Text>

          <Button
            label={needsAck ? 'Confirm it’s not listed above' : 'Send for review'}
            icon="paper-plane"
            color={ACCENT}
            fullWidth
            loading={submitting}
            disabled={!canSubmit}
            onPress={handleSubmit}
            style={styles.submitBtn}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Small pieces ───────────────────────────────────────────────────────────────

function FieldLabel({ label, required }: { label: string; required?: boolean }) {
  return (
    <Text style={styles.fieldLabel}>
      {label}
      {required ? <Text style={{ color: colors.error }}> *</Text> : null}
    </Text>
  );
}

/** Other names on a search row, minus the current canonical name. */
function altNames(r: VesselSearchRow): string | null {
  const others = (r.all_names ?? '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .filter(n => n.toUpperCase() !== r.canonical_name.toUpperCase());
  if (others.length === 0) return null;
  return `Also: ${others.slice(0, 3).join(', ')}`;
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  center: { justifyContent: 'center', alignItems: 'center' },

  body: { padding: spacing.md, gap: 10, paddingBottom: 48, backgroundColor: colors.screenBackground },

  // Explainer
  explainer: {
    borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, gap: 8,
  },
  explainerTop:   { flexDirection: 'row', alignItems: 'center', gap: 10 },
  explainerIcon:  { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  explainerTitle: { fontSize: fontSize.md, fontWeight: '900' },
  explainerBody:  { color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 20 },

  // Cards / fields
  card: { backgroundColor: colors.white, borderRadius: radius.lg, padding: spacing.md },
  sectionLabel: {
    color: colors.textMuted, fontSize: fontSize.xs, fontWeight: '700',
    letterSpacing: 1, textTransform: 'uppercase', paddingHorizontal: 4, marginTop: 6,
  },
  fieldLabel: { color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '700', marginBottom: 6 },
  hint:       { color: colors.textLight, fontSize: fontSize.xs, marginTop: 5, lineHeight: 16 },
  input: {
    borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 12, paddingVertical: 11,
    fontSize: fontSize.md, color: colors.textPrimary,
  },
  inputMulti: { minHeight: 78, textAlignVertical: 'top' },

  // Chips
  chipGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: radius.full, borderWidth: 1.5,
    borderColor: colors.border, backgroundColor: colors.offWhite,
  },
  chipText:       { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600' },
  chipTextActive: { color: '#fff' },

  // Duplicate panel
  dupePanel: {
    backgroundColor: AMBER_BG, borderRadius: radius.lg,
    borderWidth: 1, borderColor: AMBER_BORDER, padding: spacing.md, gap: 10,
  },
  dupeHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dupeTitle:     { color: AMBER_TEXT, fontSize: fontSize.md, fontWeight: '900' },
  dupeIntro:     { color: AMBER_TEXT, fontSize: fontSize.xs, lineHeight: 17, opacity: 0.9 },
  dupeRow: {
    flexDirection: 'row', alignItems: 'stretch', gap: 8,
    backgroundColor: colors.white, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, padding: 12,
  },
  dupeRowMain: { flex: 1, gap: 2 },
  dupeName:    { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '800' },
  dupeMeta:    { color: colors.textMuted, fontSize: fontSize.xs },
  dupeViewRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  dupeViewText:{ fontSize: fontSize.xs, fontWeight: '700' },
  thisIsIt: {
    flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'center',
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.full,
    borderWidth: 1.5, borderColor: ACCENT, backgroundColor: colors.white,
  },
  thisIsItText: { fontSize: fontSize.xs, fontWeight: '800' },

  ackRow:  { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  ackBox: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: AMBER_BORDER,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.white,
  },
  ackText: { flex: 1, color: AMBER_TEXT, fontSize: fontSize.sm, fontWeight: '700' },

  // Attribution
  attrTitle:    { color: colors.textPrimary, fontSize: fontSize.md, fontWeight: '800' },
  attrSubtitle: { color: colors.textMuted, fontSize: fontSize.sm, lineHeight: 18, marginTop: 2 },
  showNameRow:  { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  showNameLeft: { flex: 1 },
  showNameLabel:{ color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '600' },
  showNameHint: { color: colors.textMuted, fontSize: fontSize.xs, marginTop: 2 },

  communityNote: {
    color: colors.textLight, fontSize: fontSize.xs,
    lineHeight: 18, textAlign: 'center', paddingHorizontal: spacing.md, marginTop: 4,
  },
  submitBtn: { marginTop: 4 },

  // Signed-out gate
  gateWrap: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: 32, gap: 10, backgroundColor: colors.screenBackground,
  },
  gateIcon:  { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  gateTitle: { color: colors.textPrimary, fontSize: fontSize.xl, fontWeight: '900' },
  gateBody:  { color: colors.textSecondary, fontSize: fontSize.md, lineHeight: 22, textAlign: 'center' },

  // Success
  successWrap:  { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32, gap: 16 },
  successIcon:  { width: 72, height: 72, borderRadius: 36, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  successTitle: { color: '#fff', fontSize: fontSize.xxxl, fontWeight: '900' },
  successBody:  { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.md, lineHeight: 24, textAlign: 'center' },
  doneBtn:      { borderRadius: radius.full, paddingHorizontal: 32, paddingVertical: 14, marginTop: 8 },
  doneBtnText:  { color: '#fff', fontSize: fontSize.md, fontWeight: '700' },
});
