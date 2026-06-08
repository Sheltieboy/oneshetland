/**
 * app/memory-new.tsx
 *
 * Create-a-memory flow. Two ways to land here:
 *
 *   1. With ?lat=…&lng=… query params — set by tapping the map.
 *   2. With no params — opens with a "tap the map to anchor your memory"
 *      mini-map.
 *
 * Optional ?parent_id=… adds the new memory as a child of an existing
 * one (used by the "Add to this memory" button on the detail screen,
 * which threads sub-memories below a root).
 *
 * Saves the memory FIRST (so the storage RLS check can verify ownership)
 * then uploads each piece of media against the new memory_id.
 */

import React, { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Alert, Image, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS } from '@/constants/sections';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import {
  createMemory, uploadMemoryMedia, requestTranscription,
  MediaKind, MemoryVisibility,
} from '@/lib/memories-api';
import { PickedFile } from '@/lib/image-upload';
import MemoryMapNative from '@/components/MemoryMapNative';
import VoiceRecorder from '@/components/VoiceRecorder';

const SECTION = SECTIONS.memories;

// Soft-load expo-image-picker for photos + videos.
let ImagePicker: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ImagePicker = require('expo-image-picker');
} catch {
  ImagePicker = null;
}

interface DraftMedia {
  kind:             MediaKind;
  file:             PickedFile;
  caption?:         string;
  durationSeconds?: number;
  /** Preview URI used by the local UI before upload. */
  previewUri:       string;
}

const ERA_SUGGESTIONS = [
  'Pre-1900', 'Pre-war', '1920s', '1930s', 'WWII',
  '1950s', '1960s', '1970s', '1980s', '1990s',
  '2000s', 'Recent',
];

const VISIBILITY_OPTIONS: { value: MemoryVisibility; label: string; sub: string }[] = [
  { value: 'public',    label: 'Public',    sub: 'Anyone can see this memory' },
  { value: 'community', label: 'Community', sub: 'Signed-in OneShetland members only' },
  { value: 'private',   label: 'Private',   sub: 'Just for you' },
];

export default function MemoryNewScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { lat: latParam, lng: lngParam, parent_id: parentIdParam } =
    useLocalSearchParams<{ lat?: string; lng?: string; parent_id?: string }>();

  const initialPoint = useMemo(() => {
    if (latParam && lngParam) {
      const lat = Number(latParam);
      const lng = Number(lngParam);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
    return null;
  }, [latParam, lngParam]);

  const isChild = !!parentIdParam;

  const [point, setPoint]           = useState<{ lat: number; lng: number } | null>(initialPoint);
  const [placeName, setPlaceName]   = useState('');
  const [title, setTitle]           = useState('');
  const [body, setBody]             = useState('');
  const [era, setEra]               = useState('');
  const [visibility, setVisibility] = useState<MemoryVisibility>('public');
  const [drafts, setDrafts]         = useState<DraftMedia[]>([]);
  const [recording, setRecording]   = useState(false);
  const [saving, setSaving]         = useState(false);

  // ── Attach media ─────────────────────────────────────────────────────────

  const pickPhoto = async () => {
    if (!ImagePicker) {
      Alert.alert('Setup needed', 'Run `npx expo install expo-image-picker` and rebuild.');
      return;
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions?.Images ?? ['images'],
      quality: 0.85,
      allowsMultipleSelection: false,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setDrafts(prev => [...prev, {
      kind: 'photo',
      file: { uri: asset.uri, mimeType: asset.mimeType, ext: asset.fileName?.split('.').pop() },
      previewUri: asset.uri,
    }]);
  };

  const pickVideo = async () => {
    if (!ImagePicker) {
      Alert.alert('Setup needed', 'Run `npx expo install expo-image-picker` and rebuild.');
      return;
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions?.Videos ?? ['videos'],
      quality: 0.7,
      videoMaxDuration: 120,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    setDrafts(prev => [...prev, {
      kind: 'video',
      file: { uri: asset.uri, mimeType: asset.mimeType, ext: asset.fileName?.split('.').pop() ?? 'mp4' },
      durationSeconds: asset.duration ? Math.round(asset.duration / 1000) : undefined,
      previewUri: asset.uri,
    }]);
  };

  const handleVoiceFinish = (file: PickedFile, durationSeconds: number) => {
    setDrafts(prev => [...prev, { kind: 'audio', file, durationSeconds, previewUri: file.uri }]);
    setRecording(false);
  };

  const removeDraft = (idx: number) => {
    setDrafts(prev => prev.filter((_, i) => i !== idx));
  };

  // ── Save ─────────────────────────────────────────────────────────────────

  const canSave = !!profile?.id
    && !!(point || isChild)
    && (!!title.trim() || !!body.trim() || drafts.length > 0)
    && !saving;

  const handleSave = async () => {
    if (!profile?.id) {
      Alert.alert('Sign in first', 'You need to be signed in to add a memory.');
      return;
    }
    if (!isChild && !point) {
      Alert.alert('Pin missing', 'Tap on the map to set where this memory belongs.');
      return;
    }

    setSaving(true);
    try {
      // 1. Create the memory shell.
      const memory = await createMemory({
        author_id:  profile.id,
        lat:        isChild ? null : point!.lat,
        lng:        isChild ? null : point!.lng,
        place_name: placeName.trim() || null,
        parent_id:  parentIdParam ?? null,
        era:        era.trim()        || null,
        title:      title.trim()      || null,
        body:       body.trim()       || null,
        visibility,
      });

      // 2. Upload media sequentially (small N — keeps UI predictable, and
      //    keeps display_order stable).
      for (let i = 0; i < drafts.length; i++) {
        const d = drafts[i];
        const media = await uploadMemoryMedia({
          memoryId:        memory.id,
          uploaderId:      profile.id,
          kind:            d.kind,
          file:            d.file,
          caption:         d.caption,
          durationSeconds: d.durationSeconds,
          displayOrder:    i,
        });
        // Fire-and-forget transcription for voice notes.
        if (d.kind === 'audio') {
          void requestTranscription(media.id);
        }
      }

      // 3. Off to the detail screen — pin will be visible on next focus
      //    of the map screen too (it reloads on focus).
      router.replace(`/memory/${memory.id}`);
    } catch (err: any) {
      Alert.alert('Could not save', err?.message ?? 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} hitSlop={10}>
            <FontAwesome5 name="chevron-left" size={18} color={colors.textPrimary} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>
            {isChild ? 'Add to this memory' : 'New memory'}
          </Text>
          <View style={{ width: 36 }} />
        </View>

        {/* Location picker (skip for sub-memories — they inherit) */}
        {!isChild ? (
          <View style={styles.cardSection}>
            <Text style={styles.sectionLabel}>Where</Text>
            <Text style={styles.sectionHint}>
              Tap to place — or drag the map under the pin to refine.
            </Text>
            <View style={{ marginTop: spacing.sm }}>
              <MemoryMapNative
                pins={[]}
                pendingPoint={point}
                onDropPin={p => setPoint(p)}
                height={260}
              />
            </View>
            <View style={styles.coordsRow}>
              <FontAwesome5 name="map-pin" size={11} color={SECTION.color} />
              <Text style={styles.coordsText}>
                {point
                  ? `${point.lat.toFixed(4)}°N, ${(-point.lng).toFixed(4)}°W`
                  : 'No pin set yet'}
              </Text>
            </View>
            <TextInput
              value={placeName}
              onChangeText={setPlaceName}
              placeholder="Place name (optional, e.g. Hillswick Pier)"
              placeholderTextColor={colors.textLight}
              style={styles.input}
            />
          </View>
        ) : null}

        {/* Story */}
        <View style={styles.cardSection}>
          <Text style={styles.sectionLabel}>The memory</Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Title (optional)"
            placeholderTextColor={colors.textLight}
            style={styles.input}
          />
          <TextInput
            value={body}
            onChangeText={setBody}
            placeholder="Tell the story…"
            placeholderTextColor={colors.textLight}
            multiline
            style={[styles.input, styles.inputMulti]}
          />

          {/* Era chips */}
          <Text style={[styles.sectionLabel, { marginTop: spacing.md }]}>When (optional)</Text>
          <View style={styles.eraRow}>
            {ERA_SUGGESTIONS.map(e => {
              const active = era === e;
              return (
                <TouchableOpacity
                  key={e}
                  onPress={() => setEra(active ? '' : e)}
                  style={[
                    styles.eraChip,
                    active && { backgroundColor: SECTION.color, borderColor: SECTION.color },
                  ]}
                >
                  <Text style={[styles.eraChipText, active && { color: '#fff' }]}>{e}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <TextInput
            value={era}
            onChangeText={setEra}
            placeholder="…or type your own era"
            placeholderTextColor={colors.textLight}
            style={[styles.input, { marginTop: spacing.sm }]}
          />
        </View>

        {/* Media */}
        <View style={styles.cardSection}>
          <Text style={styles.sectionLabel}>Attach photos, video, voice</Text>
          <View style={styles.attachRow}>
            <AttachButton icon="image"      label="Photo" onPress={pickPhoto} />
            <AttachButton icon="video"      label="Video" onPress={pickVideo} />
            <AttachButton icon="microphone" label="Voice" onPress={() => setRecording(true)} />
          </View>

          {recording ? (
            <View style={{ marginTop: spacing.md }}>
              <VoiceRecorder
                onFinish={handleVoiceFinish}
                onCancel={() => setRecording(false)}
              />
            </View>
          ) : null}

          {drafts.length > 0 ? (
            <View style={styles.draftList}>
              {drafts.map((d, i) => (
                <View key={i} style={styles.draftRow}>
                  <View style={[styles.draftThumb, { backgroundColor: SECTION.light }]}>
                    {d.kind === 'photo' ? (
                      <Image source={{ uri: d.previewUri }} style={StyleSheet.absoluteFill} />
                    ) : (
                      <FontAwesome5
                        name={d.kind === 'audio' ? 'microphone' : 'video'}
                        size={20}
                        color={SECTION.color}
                      />
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.draftKind}>{d.kind.toUpperCase()}</Text>
                    {d.durationSeconds ? (
                      <Text style={styles.draftMeta}>{d.durationSeconds}s</Text>
                    ) : null}
                  </View>
                  <TouchableOpacity onPress={() => removeDraft(i)} hitSlop={6}>
                    <FontAwesome5 name="times" size={16} color={colors.error} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          ) : null}
        </View>

        {/* Visibility */}
        <View style={styles.cardSection}>
          <Text style={styles.sectionLabel}>Who can see it</Text>
          <View style={{ marginTop: spacing.xs, gap: spacing.xs }}>
            {VISIBILITY_OPTIONS.map(opt => {
              const active = visibility === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  onPress={() => setVisibility(opt.value)}
                  style={[styles.visRow, active && { borderColor: SECTION.color, backgroundColor: SECTION.light }]}
                >
                  <View
                    style={[styles.radioOuter, active && { borderColor: SECTION.color }]}
                  >
                    {active ? <View style={[styles.radioInner, { backgroundColor: SECTION.color }]} /> : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.visLabel}>{opt.label}</Text>
                    <Text style={styles.visSub}>{opt.sub}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Save */}
        <TouchableOpacity
          onPress={handleSave}
          disabled={!canSave}
          style={[
            styles.saveBtn,
            { backgroundColor: SECTION.color, opacity: canSave ? 1 : 0.45 },
          ]}
        >
          {saving ? <ActivityIndicator color="#fff" /> : (
            <>
              <FontAwesome5 name="check" size={14} color="#fff" />
              <Text style={styles.saveBtnText}>Save memory</Text>
            </>
          )}
        </TouchableOpacity>

      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function AttachButton({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.attachBtn} onPress={onPress}>
      <View style={[styles.attachIcon, { backgroundColor: SECTION.light }]}>
        <FontAwesome5 name={icon} size={18} color={SECTION.color} />
      </View>
      <Text style={styles.attachLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.screenBackground },
  scroll:    { paddingBottom: spacing.xxl },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  iconBtn: {
    width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18,
  },
  headerTitle: {
    flex: 1,
    fontSize: fontSize.lg,
    fontWeight: '800',
    color: colors.textPrimary,
    textAlign: 'center',
  },
  cardSection: {
    backgroundColor: colors.white,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sectionLabel: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  sectionHint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: 4,
  },
  input: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.md,
    color: colors.textPrimary,
    backgroundColor: colors.offWhite,
  },
  inputMulti: {
    minHeight: 110,
    textAlignVertical: 'top',
  },
  coordsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: spacing.sm,
  },
  coordsText: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  eraRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: spacing.sm,
  },
  eraChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.offWhite,
    borderWidth: 1,
    borderColor: colors.border,
  },
  eraChipText: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  attachRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  attachBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.offWhite,
  },
  attachIcon: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 6,
  },
  attachLabel: {
    fontSize: fontSize.xs,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  draftList: {
    marginTop: spacing.md,
    gap: spacing.xs,
  },
  draftRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
  },
  draftThumb: {
    width: 44, height: 44, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  draftKind: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.textPrimary,
    letterSpacing: 0.5,
  },
  draftMeta: {
    fontSize: 11,
    color: colors.textMuted,
  },
  visRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.white,
  },
  radioOuter: {
    width: 20, height: 20, borderRadius: 10,
    borderWidth: 2, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  radioInner: {
    width: 10, height: 10, borderRadius: 5,
  },
  visLabel: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  visSub:   { fontSize: 11, color: colors.textMuted },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  saveBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: fontSize.md,
  },
});
