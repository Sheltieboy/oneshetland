/**
 * app/onboarding.tsx
 *
 * Mandatory account-level onboarding — distinct from app/intro.tsx (a
 * device-level first-launch tour that exists independently of any account).
 * This screen is reached only once per account: app/_layout.tsx redirects
 * every authenticated route here while profiles.onboarding_completed_at is
 * NULL, and stops redirecting the moment it isn't.
 *
 * Deliberately simpler than the web JoinWizard (components/welcome/JoinWizard
 * on oneshetland-web) it's modelled on: web's fields are optional and its
 * progress is derived from populated data (see lib/onboarding.ts's design
 * note there). Ours are mandatory, so completion is an explicit, separate
 * fact — onboarding_completed_at — never inferred from a filled-in field.
 *
 * There is no skip / finish-later button here, unlike web. That is a real
 * product choice, not an oversight.
 *
 * Avatar upload reuses lib/image-upload.ts#uploadAvatar and the exact
 * expo-image-picker pattern already shipped in app/edit-profile.tsx. The
 * Shetland area list is intentionally duplicated from edit-profile.tsx rather
 * than extracted to a shared constant — out of scope for this task.
 */
import React, { useState, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Image,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { sanitizeNext } from '@/lib/auth-redirect';
import { uploadAvatar } from '@/lib/image-upload';
import { cacheAudience, type Audience } from '@/lib/audience';
import { Input, KeyboardDoneBar } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useAlert } from '@/components/BrandedAlert';

// expo-image-picker is loaded lazily so the screen never hard-crashes if the
// native module is unavailable in a given build (mirrors edit-profile.tsx).
let ImagePicker: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ImagePicker = require('expo-image-picker');
} catch {
  ImagePicker = null;
}

// Mirrored from app/edit-profile.tsx by design — not extracted to a shared
// constant in this task (see file doc comment above).
const SHETLAND_AREAS = [
  'Lerwick', 'Scalloway', 'Brae', 'Voe', 'Vidlin', 'Laxo',
  'Mossbank', 'Sullom', 'Hillswick', 'Walls', 'Sandness', 'Bixter',
  'Tingwall', 'Whiteness', 'Weisdale', 'Cunningsburgh', 'Sandwick',
  'Bigton', 'Levenwick', 'Sumburgh', 'Boddam',
  'Yell', 'Unst', 'Fetlar', 'Whalsay', 'Skerries', 'Bressay',
  'Fair Isle', 'Foula', 'Papa Stour',
];

export default function OnboardingScreen() {
  const router = useRouter();
  const { next } = useLocalSearchParams<{ next?: string }>();
  const { profile, refreshProfile } = useAuth();
  const { alert } = useAlert();

  const [displayName, setDisplayName] = useState(profile?.full_name ?? '');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [audience, setAudience] = useState<Audience | null>(null);
  const [area, setArea] = useState('');
  const [showAreaPicker, setShowAreaPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const needsArea = audience === 'resident';
  const canSave =
    displayName.trim().length > 0 &&
    audience !== null &&
    (!needsArea || area.length > 0);

  const pickAvatar = async () => {
    if (!ImagePicker) {
      return alert({ title: 'Setup needed', message: 'Run `npx expo install expo-image-picker` and rebuild.' });
    }
    if (!profile?.id) return;

    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      return alert({ title: 'Permission needed', message: 'Allow photo access to choose a photo.' });
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions?.Images ?? ['images'],
      quality: 0.85,
      allowsEditing: true,
      aspect: [1, 1],
      allowsMultipleSelection: false,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];

    setUploadingAvatar(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const { publicUrl } = await uploadAvatar(profile.id, {
        uri: asset.uri,
        mimeType: asset.mimeType,
        ext: asset.fileName?.split('.').pop(),
      });
      setAvatarUrl(publicUrl);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      alert({ title: 'Upload failed', message: e instanceof Error ? e.message : 'Could not upload that photo.' });
    } finally {
      setUploadingAvatar(false);
    }
  };

  const pickAudience = (a: Audience) => {
    Haptics.selectionAsync();
    setAudience(a);
    if (a === 'visiting') { setArea(''); setShowAreaPicker(false); }
  };

  const handleComplete = async () => {
    if (savingRef.current) return;
    if (!profile?.id) return;
    if (!displayName.trim()) {
      return alert({ title: 'Required', message: 'Please enter a name people will see.' });
    }
    if (!audience) {
      return alert({ title: 'Required', message: 'Let us know if you live here or are visiting.' });
    }
    if (needsArea && !area) {
      return alert({ title: 'Required', message: 'Please choose your area.' });
    }

    savingRef.current = true;
    setSaving(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // One update, one moment of truth: the completion timestamp is written in
    // exactly the same call as the fields it certifies — never a separate
    // write, so there is no window where they could disagree.
    const { error } = await supabase
      .from('profiles')
      .update({
        display_name: displayName.trim(),
        avatar_url: avatarUrl || null,
        audience,
        location_area: needsArea ? area : null,
        onboarding_completed_at: new Date().toISOString(),
      })
      .eq('id', profile.id);

    if (error) {
      savingRef.current = false;
      setSaving(false);
      alert({ title: 'Could not save', message: error.message || 'Please try again.' });
      return;
    }

    // Keep Home's optimistic first-paint ranking in step (same cache the
    // audience switcher and the intro tour already write to).
    void cacheAudience(audience);

    // CRITICAL: refetch and update the in-memory profile BEFORE leaving this
    // screen. app/_layout.tsx's routing gate reads profile.onboarding_completed_at
    // from context, not from this screen's local state — navigating away
    // first would leave that context stale and immediately bounce back here.
    // refreshProfile() is the same mechanism app/edit-profile.tsx already
    // uses after a save; no second profile store is introduced.
    await refreshProfile();

    setSaving(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.replace((sanitizeNext(next) ?? '/(tabs)') as never);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardDoneBar />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={styles.eyebrow}>Welcome to OneShetland</Text>
          <Text style={styles.title}>Let&apos;s get you set up</Text>
          <Text style={styles.subtitle}>
            Just a few details — takes less than a minute.
          </Text>

          {/* ── Avatar (optional) ── */}
          <View style={styles.avatarRow}>
            <View style={styles.avatarPreview}>
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={styles.avatarImage} />
              ) : (
                <Text style={styles.avatarInitials}>
                  {(displayName.trim() || 'U').slice(0, 1).toUpperCase()}
                </Text>
              )}
              {uploadingAvatar && (
                <View style={styles.avatarUploading}>
                  <ActivityIndicator size="small" color="#fff" />
                </View>
              )}
            </View>
            <View style={{ flex: 1, gap: 8 }}>
              <TouchableOpacity
                style={styles.avatarBtn}
                onPress={pickAvatar}
                disabled={uploadingAvatar}
                activeOpacity={0.8}
              >
                <FontAwesome5 name="camera" size={12} color={colors.navy} />
                <Text style={styles.avatarBtnText}>
                  {uploadingAvatar ? 'Uploading…' : avatarUrl ? 'Change photo' : 'Add a photo'}
                </Text>
              </TouchableOpacity>
              <Text style={styles.optionalHint}>Optional — a photo is friendlier, that&apos;s all.</Text>
            </View>
          </View>

          {/* ── Display name (required) ── */}
          <Text style={styles.fieldLabel}>Name people see<Text style={styles.required}> *</Text></Text>
          <Input
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Your name"
            autoCapitalize="words"
            autoComplete="name"
            returnKeyType="done"
          />

          {/* ── Resident / visitor (required) ── */}
          <Text style={[styles.fieldLabel, { marginTop: spacing.lg }]}>
            What brings you to OneShetland?<Text style={styles.required}> *</Text>
          </Text>
          <View style={styles.audienceRow}>
            <TouchableOpacity
              style={[styles.audienceCard, audience === 'resident' && styles.audienceCardActive]}
              onPress={() => pickAudience('resident')}
              activeOpacity={0.85}
            >
              <Text style={styles.audienceEmoji}>🏠</Text>
              <Text style={styles.audienceTitle}>I live here</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.audienceCard, audience === 'visiting' && styles.audienceCardActive]}
              onPress={() => pickAudience('visiting')}
              activeOpacity={0.85}
            >
              <Text style={styles.audienceEmoji}>🧳</Text>
              <Text style={styles.audienceTitle}>I&apos;m visiting</Text>
            </TouchableOpacity>
          </View>

          {/* ── Shetland area (required only for residents) ── */}
          {needsArea && (
            <>
              <Text style={[styles.fieldLabel, { marginTop: spacing.lg }]}>
                Where in Shetland?<Text style={styles.required}> *</Text>
              </Text>
              <TouchableOpacity
                style={styles.inputWrap}
                onPress={() => { Haptics.selectionAsync(); setShowAreaPicker(!showAreaPicker); }}
                activeOpacity={0.8}
              >
                <Text style={[styles.input, !area && { color: colors.textLight }]}>
                  {area || 'Select your area…'}
                </Text>
                <FontAwesome5
                  name={showAreaPicker ? 'chevron-up' : 'chevron-down'}
                  size={11}
                  color={colors.textLight}
                />
              </TouchableOpacity>

              {showAreaPicker && (
                <View style={styles.areaPicker}>
                  {SHETLAND_AREAS.map(a => (
                    <TouchableOpacity
                      key={a}
                      style={[styles.areaOption, area === a && styles.areaOptionActive]}
                      onPress={() => { Haptics.selectionAsync(); setArea(a); setShowAreaPicker(false); }}
                      activeOpacity={0.7}
                    >
                      {area === a && (
                        <FontAwesome5 name="check" size={10} color={colors.accent} style={{ marginRight: 6 }} />
                      )}
                      <Text style={[styles.areaOptionText, area === a && styles.areaOptionTextActive]}>
                        {a}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </>
          )}

          <Button
            label="Complete setup"
            onPress={handleComplete}
            loading={saving}
            disabled={!canSave || uploadingAvatar}
            fullWidth
            size="lg"
            style={styles.submitBtn}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.white },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, padding: spacing.lg, paddingTop: spacing.xl },

  eyebrow: { fontSize: fontSize.sm, fontWeight: '700', color: colors.accent, textTransform: 'uppercase', letterSpacing: 0.5 },
  title: { fontSize: fontSize.xxxl, fontWeight: '800', color: colors.navy, marginTop: spacing.xs },
  subtitle: { fontSize: fontSize.md, color: colors.textMuted, marginTop: spacing.xs, marginBottom: spacing.xl },

  // Avatar
  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: spacing.xl },
  avatarPreview: {
    width: 76, height: 76, borderRadius: 38,
    backgroundColor: colors.navy,
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: { width: '100%', height: '100%' },
  avatarInitials: { fontSize: 30, fontWeight: '900', color: '#fff' },
  avatarUploading: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start',
    backgroundColor: '#fff', borderRadius: radius.full,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 9,
  },
  avatarBtnText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.navy },
  optionalHint: { fontSize: fontSize.xs, color: colors.textLight },

  fieldLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  required: { color: colors.error },

  // Audience
  audienceRow: { flexDirection: 'row', gap: spacing.sm },
  audienceCard: {
    flex: 1,
    borderWidth: 1.5, borderColor: colors.border, borderRadius: radius.md,
    paddingVertical: spacing.md, paddingHorizontal: spacing.sm,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  audienceCardActive: { borderColor: colors.navy, backgroundColor: colors.navy + '0D' },
  audienceEmoji: { fontSize: 24, marginBottom: 6 },
  audienceTitle: { fontSize: fontSize.sm, fontWeight: '700', color: colors.navy },

  // Area picker (mirrors edit-profile.tsx)
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, minHeight: 46,
  },
  input: { flex: 1, color: colors.textPrimary, fontSize: fontSize.sm, paddingVertical: 12 },
  areaPicker: {
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    marginTop: 4, overflow: 'hidden', maxHeight: 260,
  },
  areaOption: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  areaOptionActive: { backgroundColor: colors.accent + '18' },
  areaOptionText: { fontSize: fontSize.sm, color: colors.textPrimary },
  areaOptionTextActive: { color: colors.accent, fontWeight: '700' },

  submitBtn: { marginTop: spacing.xl },
});
