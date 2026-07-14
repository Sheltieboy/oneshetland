import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Image,
  TextInput, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { useAlert } from '@/components/BrandedAlert';
import {
  validateHandle, isHandleAvailable, HANDLE_MAX,
} from '@/lib/games-handle';
import { uploadAvatar, deleteUploadedImage, pathFromPublicUrl } from '@/lib/image-upload';

// expo-image-picker is loaded lazily so the screen never hard-crashes if the
// native module is unavailable in a given build (mirrors memory-new.tsx).
let ImagePicker: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ImagePicker = require('expo-image-picker');
} catch {
  ImagePicker = null;
}

const SHETLAND_AREAS = [
  'Lerwick', 'Scalloway', 'Brae', 'Voe', 'Vidlin', 'Laxo',
  'Mossbank', 'Sullom', 'Hillswick', 'Walls', 'Sandness', 'Bixter',
  'Tingwall', 'Whiteness', 'Weisdale', 'Cunningsburgh', 'Sandwick',
  'Bigton', 'Levenwick', 'Sumburgh', 'Boddam',
  'Yell', 'Unst', 'Fetlar', 'Whalsay', 'Skerries', 'Bressay',
  'Fair Isle', 'Foula', 'Papa Stour',
];

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>
        {label}{required ? <Text style={{ color: colors.shifts }}> *</Text> : null}
      </Text>
      {children}
    </View>
  );
}

export default function EditProfileScreen() {
  const router = useRouter();
  const { profile, refreshProfile } = useAuth();
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();

  const [fullName,     setFullName]     = useState(profile?.full_name     ?? '');
  const [displayName,  setDisplayName]  = useState(profile?.display_name  ?? '');
  const [avatarUrl,    setAvatarUrl]    = useState(profile?.avatar_url    ?? '');
  const [uploading,    setUploading]    = useState(false);
  const [bio,          setBio]          = useState(profile?.bio           ?? '');
  const [gamesHandle,  setGamesHandle]  = useState(profile?.games_handle  ?? '');
  const [locationArea, setLocationArea] = useState(profile?.location_area ?? '');
  const [phone,        setPhone]        = useState(profile?.phone         ?? '');
  const [saving,       setSaving]       = useState(false);
  const [showAreaPicker, setShowAreaPicker] = useState(false);

  // Games-handle live check: 'idle' before user touches, 'checking' while
  // debounced lookup is in flight, then 'free' | 'taken' | 'invalid'.
  type HandleStatus =
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'free' }
    | { kind: 'taken' }
    | { kind: 'invalid'; message: string };
  const [handleStatus, setHandleStatus] = useState<HandleStatus>({ kind: 'idle' });
  const handleCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setFullName(profile?.full_name ?? '');
    setDisplayName(profile?.display_name ?? '');
    setAvatarUrl(profile?.avatar_url ?? '');
    setBio(profile?.bio ?? '');
    setGamesHandle(profile?.games_handle ?? '');
    setLocationArea(profile?.location_area ?? '');
    setPhone(profile?.phone ?? '');
    setHandleStatus({ kind: 'idle' });
  }, [profile?.id]);

  // Validate + debounced availability check whenever the handle changes
  useEffect(() => {
    if (handleCheckTimer.current) clearTimeout(handleCheckTimer.current);

    const trimmed = gamesHandle.trim();
    // Empty handle is allowed (null on save → "Anon" on leaderboards)
    if (!trimmed) { setHandleStatus({ kind: 'idle' }); return; }
    // Unchanged from the saved value → no need to check
    if (trimmed === (profile?.games_handle ?? '').trim()) {
      setHandleStatus({ kind: 'idle' }); return;
    }

    const v = validateHandle(trimmed);
    if (!v.ok) { setHandleStatus({ kind: 'invalid', message: v.message }); return; }

    setHandleStatus({ kind: 'checking' });
    handleCheckTimer.current = setTimeout(async () => {
      if (!profile?.id) return;
      const free = await isHandleAvailable(trimmed, profile.id);
      setHandleStatus(free ? { kind: 'free' } : { kind: 'taken' });
    }, 400);

    return () => {
      if (handleCheckTimer.current) clearTimeout(handleCheckTimer.current);
    };
  }, [gamesHandle, profile?.id, profile?.games_handle]);

  const handleNormalised = gamesHandle.trim() || null;
  const savedHandle      = profile?.games_handle ?? null;

  const isDirty =
    fullName.trim()     !== (profile?.full_name     ?? '').trim() ||
    displayName.trim()  !== (profile?.display_name  ?? '').trim() ||
    (avatarUrl || null) !== (profile?.avatar_url    ?? null)      ||
    bio.trim()          !== (profile?.bio           ?? '').trim() ||
    handleNormalised    !== savedHandle                           ||
    locationArea        !== (profile?.location_area ?? '')        ||
    (phone.trim() || null) !== (profile?.phone ?? null);

  // Block save if the handle has an active problem. 'checking' is fine — the
  // DB unique index will catch a race-condition clash.
  const handleSaveable =
    handleStatus.kind !== 'invalid' && handleStatus.kind !== 'taken';

  // ── Avatar pick / upload / remove ─────────────────────────────────────────
  const pickAvatar = async () => {
    if (!ImagePicker) {
      return alert({ title: 'Setup needed', message: 'Run `npx expo install expo-image-picker` and rebuild.' });
    }
    if (!profile?.id) return;

    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      return alert({ title: 'Permission needed', message: 'Allow photo access to choose an avatar.' });
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

    setUploading(true);
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
      setUploading(false);
    }
  };

  const removeAvatar = () => {
    Haptics.selectionAsync();
    setAvatarUrl('');
  };

  const handleSave = async () => {
    if (!fullName.trim()) return alert({ title: 'Required', message: 'Please enter your full name.' });
    if (!handleSaveable) return alert({ title: 'Fix your handle', message: 'Pick a different Games handle before saving.' });

    setSaving(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const newAvatar = avatarUrl || null;

    const { error } = await supabase
      .from('profiles')
      .update({
        full_name:     fullName.trim(),
        display_name:  displayName.trim() || null,
        avatar_url:    newAvatar,
        bio:           bio.trim() || null,
        games_handle:  handleNormalised,
        location_area: locationArea || null,
        phone:         phone.trim() || null,
      })
      .eq('id', profile!.id);

    setSaving(false);

    // Best-effort cleanup of the previous avatar object once the new URL (or
    // removal) is safely persisted. Failures are non-fatal.
    if (!error) {
      const prevAvatar = profile?.avatar_url ?? null;
      if (prevAvatar && prevAvatar !== newAvatar) {
        const ref = pathFromPublicUrl(prevAvatar);
        if (ref) deleteUploadedImage(ref.bucket, ref.path).catch(() => {});
      }
    }

    if (error) {
      // Only treat as "taken" on a real unique-violation (Postgres 23505).
      // Otherwise surface the real error — most often it's "column does not
      // exist" because migration 023_games_handle.sql hasn't been applied yet.
      const code = (error as { code?: string }).code;
      const isUniqueViolation =
        code === '23505' || /duplicate key|unique constraint/i.test(error.message);
      const msg = isUniqueViolation
        ? 'That Games handle was just taken. Try another.'
        : error.message;
      alert({ title: 'Could not save', message: msg });
    } else {
      await refreshProfile();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    }
  };

  return (
    <ScreenScaffold
      header={<ScreenHeader title="Edit profile" accent={colors.accent} onBack={() => router.back()} />}
    >
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >

          {/* ── Avatar ─────────────────────────────────────────────────────── */}
          <View style={styles.avatarRow}>
            <View style={styles.avatarPreview}>
              {avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={styles.avatarImage} />
              ) : (
                <Text style={styles.avatarInitials}>
                  {(fullName.trim() || 'U').slice(0, 1).toUpperCase()}
                </Text>
              )}
              {uploading && (
                <View style={styles.avatarUploading}>
                  <ActivityIndicator size="small" color="#fff" />
                </View>
              )}
            </View>
            <View style={{ flex: 1, gap: 8 }}>
              <TouchableOpacity
                style={styles.avatarBtn}
                onPress={pickAvatar}
                disabled={uploading}
                activeOpacity={0.8}
              >
                <FontAwesome5 name="camera" size={12} color={colors.navy} />
                <Text style={styles.avatarBtnText}>
                  {uploading ? 'Uploading…' : avatarUrl ? 'Change photo' : 'Add photo'}
                </Text>
              </TouchableOpacity>
              {avatarUrl ? (
                <TouchableOpacity onPress={removeAvatar} disabled={uploading} activeOpacity={0.7}>
                  <Text style={styles.avatarRemove}>Remove photo</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>

          <Field label="Full name" required>
            <View style={styles.inputWrap}>
              <TextInput
                style={styles.input}
                value={fullName}
                onChangeText={setFullName}
                placeholder="Your full name"
                placeholderTextColor={colors.textLight}
                autoCapitalize="words"
              />
            </View>
          </Field>

          <Field label="Display name">
            <View style={styles.inputWrap}>
              <TextInput
                style={styles.input}
                value={displayName}
                onChangeText={setDisplayName}
                placeholder="Shown publicly (optional)"
                placeholderTextColor={colors.textLight}
                autoCapitalize="words"
              />
            </View>
            <Text style={styles.hint}>Your public-facing name across OneShetland. Leave blank to use your full name.</Text>
          </Field>

          <Field label="Bio">
            <View style={[styles.inputWrap, { height: 90, alignItems: 'flex-start' }]}>
              <TextInput
                style={[styles.input, { height: 80, textAlignVertical: 'top', paddingTop: 4 }]}
                value={bio}
                onChangeText={setBio}
                placeholder="A short intro — what you do, where you're based, what you're interested in…"
                placeholderTextColor={colors.textLight}
                multiline
              />
            </View>
            <Text style={styles.hint}>Shown on your shift applications and your public profile.</Text>
          </Field>

          <Field label="Games handle">
            <View style={[
              styles.inputWrap,
              handleStatus.kind === 'invalid' && { borderColor: colors.error },
              handleStatus.kind === 'taken'   && { borderColor: colors.error },
              handleStatus.kind === 'free'    && { borderColor: SECTIONS.games.color },
            ]}>
              <FontAwesome5
                name="gamepad"
                size={13}
                color={SECTIONS.games.color}
                style={{ marginRight: 8 }}
                solid
              />
              <TextInput
                style={styles.input}
                value={gamesHandle}
                onChangeText={setGamesHandle}
                placeholder="e.g. PeerieWhaup"
                placeholderTextColor={colors.textLight}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={HANDLE_MAX}
              />
              {handleStatus.kind === 'checking' && (
                <ActivityIndicator size="small" color={colors.textMuted} />
              )}
              {handleStatus.kind === 'free' && (
                <FontAwesome5 name="check-circle" size={14} color={SECTIONS.games.color} solid />
              )}
              {(handleStatus.kind === 'taken' || handleStatus.kind === 'invalid') && (
                <FontAwesome5 name="exclamation-circle" size={14} color={colors.error} solid />
              )}
            </View>
            {handleStatus.kind === 'invalid' ? (
              <Text style={[styles.hint, { color: colors.error }]}>{handleStatus.message}</Text>
            ) : handleStatus.kind === 'taken' ? (
              <Text style={[styles.hint, { color: colors.error }]}>That handle is already taken — try another.</Text>
            ) : handleStatus.kind === 'free' ? (
              <Text style={[styles.hint, { color: SECTIONS.games.color }]}>Looks good — that handle is free.</Text>
            ) : (
              <Text style={styles.hint}>
                Your name on Games leaderboards. Keep it clean-ish. Optional — leave blank to play as "Anon".
              </Text>
            )}
          </Field>

          <Field label="Area">
            <TouchableOpacity
              style={styles.inputWrap}
              onPress={() => { Haptics.selectionAsync(); setShowAreaPicker(!showAreaPicker); }}
              activeOpacity={0.8}
            >
              <Text style={[styles.input, !locationArea && { color: colors.textLight }]}>
                {locationArea || 'Select your area…'}
              </Text>
              <FontAwesome5
                name={showAreaPicker ? 'chevron-up' : 'chevron-down'}
                size={11}
                color={colors.textLight}
              />
            </TouchableOpacity>

            {showAreaPicker && (
              <View style={styles.areaPicker}>
                {SHETLAND_AREAS.map(area => (
                  <TouchableOpacity
                    key={area}
                    style={[
                      styles.areaOption,
                      locationArea === area && { backgroundColor: colors.shifts + '18' },
                    ]}
                    onPress={() => {
                      Haptics.selectionAsync();
                      setLocationArea(area);
                      setShowAreaPicker(false);
                    }}
                    activeOpacity={0.7}
                  >
                    {locationArea === area && (
                      <FontAwesome5 name="check" size={10} color={colors.shifts} style={{ marginRight: 6 }} />
                    )}
                    <Text style={[
                      styles.areaOptionText,
                      locationArea === area && { color: colors.shifts, fontWeight: '700' },
                    ]}>
                      {area}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </Field>

          <Field label="Phone number">
            <View style={styles.inputWrap}>
              <TextInput
                style={styles.input}
                value={phone}
                onChangeText={setPhone}
                placeholder="+44 7700 000000"
                placeholderTextColor={colors.textLight}
                keyboardType="phone-pad"
              />
            </View>
            <Text style={styles.hint}>Not shown publicly. Used only for account recovery.</Text>
          </Field>

          <Button
            label="Save changes"
            icon="check"
            onPress={handleSave}
            disabled={!isDirty || !handleSaveable}
            loading={saving}
            fullWidth
            style={styles.saveBtn}
          />

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },

  content: { padding: spacing.md, gap: 0, paddingBottom: 60 },

  // Avatar
  avatarRow: {
    flexDirection: 'row', alignItems: 'center', gap: 16,
    marginBottom: spacing.lg,
  },
  avatarPreview: {
    width: 76, height: 76, borderRadius: 38,
    backgroundColor: colors.navy,
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage:    { width: '100%', height: '100%' },
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
  avatarRemove:  { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted },

  field:      { marginBottom: spacing.lg },
  fieldLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginBottom: 8 },
  hint:       { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 6, lineHeight: 16 },

  inputWrap: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, minHeight: 46,
  },
  input: { flex: 1, color: colors.textPrimary, fontSize: fontSize.sm, paddingVertical: 12 },

  // Area picker
  areaPicker: {
    backgroundColor: '#fff', borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    marginTop: 4, overflow: 'hidden',
  },
  areaOption: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  areaOptionText: { fontSize: fontSize.sm, color: colors.textPrimary },

  saveBtn: { marginTop: 8 },
});
