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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, Image, KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter, useNavigation, Stack } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { track } from '@/lib/analytics';
import { SECTIONS } from '@/constants/sections';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/context/AuthContext';
import {
  createMemory, updateMemory, fetchMemoryDetail, uploadMemoryMedia, requestTranscription,
  MediaKind, MemoryVisibility, MediaUploadError,
} from '@/lib/memories-api';
import { PickedFile } from '@/lib/image-upload';
import { MEMORY_CATEGORIES } from '@/constants/memory-categories';
import MemoryMapNative from '@/components/MemoryMapNative';
import VoiceRecorder from '@/components/VoiceRecorder';
import { useAlert } from '@/components/BrandedAlert';

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
  /**
   * Set once this draft's upload has actually succeeded. Lets a retry after
   * a later file's upload failure skip files that already made it, instead
   * of re-uploading (and duplicating) them.
   */
  uploaded?:        boolean;
}

/** Plain-English name for a media kind, used only in user-facing copy —
 * never the raw `kind` value, and never any backend detail alongside it. */
function mediaKindLabel(kind: MediaKind | null): string {
  return kind === 'photo' ? 'photo' : kind === 'audio' ? 'voice note' : kind === 'video' ? 'video' : 'file';
}

const ERA_SUGGESTIONS = [
  'Pre-1900', 'Pre-war', '1920s', '1930s', 'WWII',
  '1950s', '1960s', '1970s', '1980s', '1990s',
  '2000s', 'Recent',
];

// ── Draft autosave ───────────────────────────────────────────────────────────
// A half-written story is precious — losing it to a phone call or an
// accidental back-swipe stings. We stash the text fields in AsyncStorage as
// the user types and offer to bring them back next time. Media drafts aren't
// persisted (the picked file URIs are transient), so we note how many were
// attached and gently remind the user to re-add them.
const DRAFT_KEY = '@memories:new-draft';

interface SavedDraft {
  title:      string;
  body:       string;
  era:        string;
  tags:       string[];
  placeName:  string;
  visibility: MemoryVisibility;
  point:      { lat: number; lng: number } | null;
  mediaCount: number;
  savedAt:    number;
}

const VISIBILITY_OPTIONS: { value: MemoryVisibility; label: string; sub: string }[] = [
  { value: 'public',    label: 'Public',    sub: 'Anyone can see this story' },
  { value: 'community', label: 'Community', sub: 'Signed-in OneShetland members only' },
  { value: 'private',   label: 'Private',   sub: 'Just for you' },
];

export default function MemoryNewScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { profile } = useAuth();
  const { alert } = useAlert();
  const { screenWidth, screenHeight } = useAppLayout();
  // A useful working map, not a preview strip — but still responsive on a
  // short phone screen. Clamped between "always genuinely usable" and
  // "never swallows the whole screen".
  const mapHeight = Math.round(Math.max(400, Math.min(560, screenHeight * 0.5)));
  const { lat: latParam, lng: lngParam, parent_id: parentIdParam, memory_id: memoryIdParam } =
    useLocalSearchParams<{ lat?: string; lng?: string; parent_id?: string; memory_id?: string }>();

  const isEditing = !!memoryIdParam;

  const initialPoint = useMemo(() => {
    if (latParam && lngParam) {
      const lat = Number(latParam);
      const lng = Number(lngParam);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    }
    return null;
  }, [latParam, lngParam]);

  const [loadedIsChild, setLoadedIsChild] = useState(false);
  const isChild = !!parentIdParam || loadedIsChild;

  const [point, setPoint]           = useState<{ lat: number; lng: number } | null>(initialPoint);
  const [placeName, setPlaceName]   = useState('');
  const [title, setTitle]           = useState('');
  const [body, setBody]             = useState('');
  const [era, setEra]               = useState('');
  const [tags, setTags]             = useState<string[]>([]);
  const [visibility, setVisibility] = useState<MemoryVisibility>('public');
  const [drafts, setDrafts]         = useState<DraftMedia[]>([]);
  const [recording, setRecording]   = useState(false);
  const [saving, setSaving]         = useState(false);
  const [loadingExisting, setLoadingExisting] = useState(isEditing);
  // Upload progress: which file we're on (1-based) out of how many. null =
  // not uploading. On slow island connections this is the difference between
  // "it hung, force-quit" and "ah, it's working through my three photos".
  const [uploadProg, setUploadProg] = useState<{ current: number; total: number } | null>(null);
  // A recovered draft, offered for one-tap restore. Only ever set for a
  // brand-new story (we never autosave over an edit or a threaded reply).
  const [recoverable, setRecoverable] = useState<SavedDraft | null>(null);
  // Whether a finger is currently down on the map. While true the outer
  // ScrollView's own scrolling is suspended so react-native-maps' pan/pinch
  // recognizers get the touch stream uncontested — see mapPane below.
  const [mapInteracting, setMapInteracting] = useState(false);
  // Set when the memory itself saved but at least one media file didn't.
  // Rendered as a PERSISTENT banner near the Save button — deliberately not
  // just an Alert, which is easy to dismiss/miss without reading (a real
  // physical-device attempt showed exactly that: the failure was real, the
  // memory row was genuinely safe, but nothing on screen kept saying so
  // after the alert closed).
  const [partialSaveNotice, setPartialSaveNotice] = useState<string | null>(null);

  // Drafts are only for the plain "new story" flow — not edits, not sub-
  // memories (those carry their own context we don't want to mix up).
  const draftEligible = !isEditing && !isChild;

  // True once this attempt has already created the memory row (a later
  // media upload then failed and the user retried) — Save must reuse it
  // rather than creating a second story from one tap-turned-two-taps.
  const createdMemoryIdRef = useRef<string | null>(null);
  // Set right before the post-save navigation so the unsaved-changes guard
  // below doesn't mistake a successful save's own redirect for the user
  // abandoning their story.
  const justSavedRef = useRef(false);
  // Synchronous re-entrancy guard, checked and set BEFORE any await. React's
  // own `saving` state disables the button too, but that disabling only
  // takes effect after a re-render — a fast second tap can land inside that
  // window. This ref closes it deterministically, with no render in between.
  const savingRef = useRef(false);

  // Same threshold the autosave effect already used, hoisted so the
  // leave-without-saving guard can reuse the exact same definition of
  // "there's something here worth protecting."
  const hasMeaningfulContent =
    !!(title.trim() || body.trim() || drafts.length > 0 || point);

  const clearDraft = useCallback(async () => {
    try { await AsyncStorage.removeItem(DRAFT_KEY); } catch { /* non-fatal */ }
  }, []);

  // Edit mode: pull the existing memory and pre-fill every field. Existing
  // media stays attached to the memory — any drafts added here are appended.
  useEffect(() => {
    if (!memoryIdParam) return;
    let alive = true;
    (async () => {
      try {
        const m = await fetchMemoryDetail(memoryIdParam, profile?.id ?? null);
        if (!alive || !m) return;
        if (m.parent_id) setLoadedIsChild(true);
        setTitle(m.title ?? '');
        setBody(m.body ?? '');
        setEra(m.era ?? '');
        setTags(m.tags ?? []);
        setPlaceName(m.place_name ?? '');
        setVisibility(m.visibility);
        if (m.lat != null && m.lng != null) setPoint({ lat: m.lat, lng: m.lng });
      } catch {
        if (alive) alert({ title: 'Could not load', message: 'This story could not be loaded for editing.' });
      } finally {
        if (alive) setLoadingExisting(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryIdParam, profile?.id]);

  // On mount (new-story flow only), look for a saved draft and offer to
  // resume it rather than restoring silently — the user might want a fresh
  // start. We skip drafts that are effectively empty or stale (>7 days).
  useEffect(() => {
    if (!draftEligible) return;
    let alive = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(DRAFT_KEY);
        if (!raw || !alive) return;
        const d = JSON.parse(raw) as SavedDraft;
        const hasContent = d.title?.trim() || d.body?.trim() || d.mediaCount > 0 || d.point;
        const fresh = d.savedAt && Date.now() - d.savedAt < 7 * 24 * 60 * 60 * 1000;
        if (hasContent && fresh) setRecoverable(d);
        else void clearDraft();
      } catch { /* non-fatal */ }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftEligible]);

  const restoreDraft = () => {
    if (!recoverable) return;
    setTitle(recoverable.title ?? '');
    setBody(recoverable.body ?? '');
    setEra(recoverable.era ?? '');
    setTags(recoverable.tags ?? []);
    setPlaceName(recoverable.placeName ?? '');
    setVisibility(recoverable.visibility ?? 'public');
    if (recoverable.point) setPoint(recoverable.point);
    setRecoverable(null);
  };

  const dismissDraft = () => {
    setRecoverable(null);
    void clearDraft();
  };

  // Autosave the text fields as the user types. Debounced so we're not
  // hammering AsyncStorage on every keystroke. Skipped until the screen is
  // settled (and never while saving/uploading).
  const hadContent = useRef(false);
  useEffect(() => {
    if (!draftEligible || saving) return;
    // Don't write an empty draft on first paint; but once there's been
    // content, keep saving (so clearing a field still persists).
    if (!hasMeaningfulContent && !hadContent.current) return;
    hadContent.current = true;
    const t = setTimeout(() => {
      const payload: SavedDraft = {
        title, body, era, tags, placeName, visibility, point,
        mediaCount: drafts.length,
        savedAt: Date.now(),
      };
      void AsyncStorage.setItem(DRAFT_KEY, JSON.stringify(payload)).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, body, era, tags, placeName, visibility, point, drafts.length, draftEligible, saving]);

  // Leaving with a composed-but-unsaved story (back gesture, hardware back,
  // or the header's close button — all of these remove this screen the same
  // way) asks first instead of silently discarding it. New stories only
  // (draftEligible): an edit screen starts pre-filled from the existing
  // memory, so "meaningful content" would be true from the first frame and
  // this would fire on every untouched visit — that's a separate, later
  // concern, not this slice's. Suspended for the screen's own successful
  // save (justSavedRef) and while a save is actively in flight (saving),
  // so this never contests a save this screen itself just asked for.
  useEffect(() => {
    if (!draftEligible) return;
    const unsubscribe = navigation.addListener('beforeRemove', (e: any) => {
      if (justSavedRef.current || saving || !hasMeaningfulContent) return;
      e.preventDefault();
      alert({
        title: 'Discard this story?',
        message: 'You have unsaved changes. If you leave now they will be lost.',
        icon: 'exclamation-triangle',
        accent: colors.error,
        actions: [
          { label: 'Keep editing', style: 'cancel' },
          { label: 'Discard', style: 'destructive', onPress: () => navigation.dispatch(e.data.action) },
        ],
      });
    });
    return unsubscribe;
  }, [navigation, draftEligible, saving, hasMeaningfulContent, alert]);

  // ── Attach media ─────────────────────────────────────────────────────────

  const pickPhoto = async () => {
    if (!ImagePicker) {
      alert({ title: 'Setup needed', message: 'Run `npx expo install expo-image-picker` and rebuild.' });
      return;
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions?.Images ?? ['images'],
      quality: 0.85,
      allowsMultipleSelection: false,
      // Without this, iOS hands back the library asset in its OWN native
      // format — HEIC for most photos on a real iPhone, since that's the
      // device default. memories-media's Storage bucket only allows
      // jpeg/jpg/png/webp; HEIC isn't in that list, so an unconverted photo
      // is rejected by Storage before it ever reaches memory_media (proven
      // directly against the live bucket: image/heic -> 400 invalid_mime_type,
      // image/jpeg -> passes that check). "Compatible" asks the OS's own
      // picker to hand back JPEG (Apple's documented PHPicker behaviour for
      // this exact case) instead of re-encoding client-side ourselves.
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode?.Compatible,
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
      alert({ title: 'Setup needed', message: 'Run `npx expo install expo-image-picker` and rebuild.' });
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
    // Synchronous re-entrancy guard — set before any await, so a second tap
    // landing before the button visually disables still can't start a
    // second attempt. Cleared in `finally`, same as `saving`.
    if (savingRef.current) return;
    if (!profile?.id) {
      alert({ title: 'Sign in first', message: 'You need to be signed in to add a story.' });
      return;
    }
    if (!isChild && !point) {
      alert({ title: 'Pin missing', message: 'Tap on the map to set where this story belongs.' });
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setPartialSaveNotice(null);
    // Tracks which draft is being uploaded RIGHT NOW, so the catch block
    // below can say which kind of file failed even though the thrown error
    // itself doesn't carry that context.
    let attemptingKind: MediaKind | null = null;
    try {
      // 1. Create the memory shell — or, in edit mode, update the existing
      //    one. If a PREVIOUS tap already got as far as creating the row and
      //    then failed on a media upload, createdMemoryIdRef already holds
      //    its id — reuse it rather than creating a second story, so a user
      //    retrying after a failed upload can never end up with a duplicate.
      let memoryId: string;
      if (isEditing && memoryIdParam) {
        await updateMemory(memoryIdParam, {
          lat:        isChild ? null : point!.lat,
          lng:        isChild ? null : point!.lng,
          place_name: placeName.trim() || null,
          era:        era.trim()        || null,
          tags,
          title:      title.trim()      || null,
          body:       body.trim()       || null,
          visibility,
        });
        memoryId = memoryIdParam;
      } else if (createdMemoryIdRef.current) {
        memoryId = createdMemoryIdRef.current;
      } else {
        const memory = await createMemory({
          author_id:  profile.id,
          lat:        isChild ? null : point!.lat,
          lng:        isChild ? null : point!.lng,
          place_name: placeName.trim() || null,
          parent_id:  parentIdParam ?? null,
          era:        era.trim()        || null,
          tags,
          title:      title.trim()      || null,
          body:       body.trim()       || null,
          visibility,
        });
        memoryId = memory.id;
        createdMemoryIdRef.current = memoryId;
        track('memory_created', { props: { has_media: drafts.length > 0 } });
      }

      // 2. Upload whichever media hasn't already made it up (skips anything
      //    an earlier, partially-failed attempt already uploaded — see the
      //    `uploaded` flag on DraftMedia). Sequential (small N) keeps UI
      //    predictable and display_order stable; "Uploading N of M…"
      //    advances per finished file since the REST/FormData uploader
      //    doesn't expose per-byte progress.
      const pending = drafts
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => !d.uploaded);
      for (let n = 0; n < pending.length; n++) {
        const { d, i } = pending[n];
        attemptingKind = d.kind;
        setUploadProg({ current: n + 1, total: pending.length });
        const media = await uploadMemoryMedia({
          memoryId,
          uploaderId:      profile.id,
          kind:            d.kind,
          file:            d.file,
          caption:         d.caption,
          durationSeconds: d.durationSeconds,
          displayOrder:    i,
        });
        setDrafts(prev => prev.map((dd, ii) => (ii === i ? { ...dd, uploaded: true } : dd)));
        // Fire-and-forget transcription for voice notes. Never let this
        // reject unhandled, and never let a transcription failure (missing
        // key, rate limit, Whisper error, network) touch the save itself —
        // the memory and its audio are already safely persisted by this
        // point regardless of what transcription does next.
        if (d.kind === 'audio') {
          requestTranscription(media.id).catch(err => {
            console.warn('[memory-new] transcription request failed (non-blocking):', err?.message ?? err);
            // Privacy-safe: which memory/media, and that a request failed —
            // never the audio itself, never the transcript, never a URL.
            track('memory_transcription_request_failed', {
              objectType: 'memory',
              objectId: memoryId,
              props: { media_id: media.id, message: String(err?.message ?? err).slice(0, 200) },
            });
          });
        }
      }
      setUploadProg(null);

      // Story (and all its media) saved cleanly — drop any recovered draft
      // so we don't offer to resume something that's already published.
      void clearDraft();

      // 3. Off to the detail screen, with a one-time flag the detail screen
      //    reads to show a brief "Story saved" confirmation — Save alone
      //    (a spinner, then a screen change) wasn't unambiguous enough.
      //    Pin will be visible on next focus of the map screen too (it
      //    reloads on focus). justSavedRef is flagged first so the
      //    unsaved-changes guard doesn't mistake this screen's own redirect
      //    for the user abandoning their story.
      justSavedRef.current = true;
      router.replace(`/memory/${memoryId}?justSaved=1`);
    } catch (err: any) {
      // If the memory row already exists (this attempt or an earlier one),
      // it and any media that already uploaded are genuinely safe — only
      // the failing file is missing. Say so honestly instead of a blanket
      // "could not save" that would invite a retry that recreates the story.
      const alreadySaved = !isEditing && !!createdMemoryIdRef.current;
      const stage = err instanceof MediaUploadError ? err.stage : 'unknown';
      const kindLabel = mediaKindLabel(attemptingKind);

      // User-facing copy is deliberately plain English only — no HTTP
      // status, no backend JSON, no MIME string, no Supabase error code.
      // A real physical-device failure (Storage's 400/InvalidMimeType body)
      // was previously interpolated straight into this message; that raw
      // text is now confined to the track() call below, never shown here.
      // "Safe" is only ever said about a file that genuinely uploaded —
      // built from the drafts actually marked `uploaded`, not assumed.
      const safeKinds = [...new Set(
        drafts.filter(d => d.uploaded).map(d => mediaKindLabel(d.kind)),
      )];
      const storyAnd = safeKinds.length ? ` and ${safeKinds.join(' and ')}` : '';
      const verb = safeKinds.length ? 'are' : 'is';
      const message = alreadySaved
        ? `Your story${storyAnd} ${verb} safe, but we couldn't upload the ${kindLabel}. Tap Retry upload to try again.`
        : 'We couldn’t save your story. Please check your connection and try again.';

      // Privacy-safe diagnostics: which stage failed and for which media
      // kind, and the real backend detail — never the file itself, the
      // story text, or any token/URL. This is exactly the signal a real
      // incident (a HEIC photo, then an audio/x-m4a alias, both silently
      // rejected by Storage's MIME allowlist) needed and didn't have; it is
      // deliberately kept OUT of the user-facing message above.
      track('memory_media_upload_failed', {
        objectType: 'memory',
        objectId: createdMemoryIdRef.current ?? undefined,
        props: { stage, kind: attemptingKind, already_saved: alreadySaved, detail: String(err?.message ?? err).slice(0, 200) },
      });

      alert({
        title: alreadySaved ? 'Story saved — one file needs retrying' : 'Could not save',
        message,
      });
      // Persistent, not transient — stays on screen (next to Save) until a
      // retry succeeds or the user removes the failing draft, unlike the
      // alert above which is easy to dismiss without fully reading.
      if (alreadySaved) setPartialSaveNotice(message);
    } finally {
      savingRef.current = false;
      setSaving(false);
      setUploadProg(null);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScreenHeader
        title={isEditing ? 'Edit story' : isChild ? 'Add to this story' : 'New story'}
        onClose={() => router.back()}
        accent={SECTION.color}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
      {loadingExisting ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={SECTION.color} />
          <Text style={[styles.sectionHint, { marginTop: spacing.md }]}>Loading story…</Text>
        </View>
      ) : (
      <ScrollView
        contentContainerStyle={[styles.scroll, contentContainer(screenWidth)]}
        keyboardShouldPersistTaps="handled"
        scrollEnabled={!mapInteracting}
      >
        {/* Resume-your-draft affordance */}
        {recoverable ? (
          <View style={styles.draftBanner}>
            <View style={styles.draftBannerIcon}>
              <FontAwesome5 name="history" size={14} color={SECTION.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.draftBannerTitle}>Pick up whaur you left aff?</Text>
              <Text style={styles.draftBannerSub}>
                We saved a draft o your story{recoverable.mediaCount > 0
                  ? ` (you'll need tae re-add ${recoverable.mediaCount} ${recoverable.mediaCount === 1 ? 'file' : 'files'})`
                  : ''}.
              </Text>
              <View style={styles.draftBannerActions}>
                <TouchableOpacity onPress={restoreDraft} style={styles.draftRestoreBtn}>
                  <Text style={styles.draftRestoreText}>Resume draft</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={dismissDraft} style={styles.draftDiscardBtn}>
                  <Text style={styles.draftDiscardText}>Start fresh</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        ) : null}

        {/* Location picker (skip for sub-memories — they inherit) */}
        {!isChild ? (
          <View style={styles.cardSection}>
            <Text style={styles.sectionLabel}>Where</Text>
            <Text style={styles.sectionHint}>
              Type a place in the map's search box (like Lerwick) and pick it from the list, or tap the map to choose where this memory happened. You can move and zoom the map to find the right spot.
            </Text>
            {!point ? (
              <View style={styles.pinNotice}>
                <FontAwesome5 name="map-marker-alt" size={13} color={SECTION.color} />
                <Text style={styles.pinNoticeText}>
                  Set where your story belongs before saving: use the search box on the map (e.g. type Lerwick) and pick your place, or tap the map. Every story needs a spot on Shetland.
                </Text>
              </View>
            ) : null}
            {/*
              Suspends the outer ScrollView's own scrolling for the duration
              of any touch that starts here, so react-native-maps' pan/pinch
              recognizers get the touch stream uncontested instead of racing
              the ScrollView's pan responder for it. onTouchEnd only re-arms
              scrolling once every finger is up (touches.length === 0), so a
              two-finger pinch surviving one finger lifting doesn't get cut
              off mid-gesture.
            */}
            <View
              style={{ marginTop: spacing.sm }}
              onTouchStart={() => setMapInteracting(true)}
              onTouchEnd={e => {
                if (!e.nativeEvent.touches || e.nativeEvent.touches.length === 0) setMapInteracting(false);
              }}
              onTouchCancel={() => setMapInteracting(false)}
            >
              <MemoryMapNative
                pins={[]}
                pendingPoint={point}
                onDropPin={p => setPoint(p)}
                // Picking a place from the search box also drops the pin
                // there, AND pre-fills the place_name field — so "find
                // Hillswick → tap save" is now a viable one-tap flow when
                // the location is good enough as-is.
                onPlacePicked={p => {
                  setPoint({ lat: Number(p.lat), lng: Number(p.lng) });
                  if (!placeName.trim()) setPlaceName(p.name);
                }}
                height={mapHeight}
                picker
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
          <Text style={styles.sectionLabel}>The story</Text>
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

        {/* Categories */}
        <View style={styles.cardSection}>
          <Text style={styles.sectionLabel}>What's it about</Text>
          <Text style={styles.sectionHint}>
            Tag this story so others can find it. Pick as many as fit.
          </Text>
          <View style={styles.tagGrid}>
            {MEMORY_CATEGORIES.map(cat => {
              const active = tags.includes(cat.slug);
              const accent = cat.color ?? SECTION.color;
              return (
                <TouchableOpacity
                  key={cat.slug}
                  onPress={() =>
                    setTags(prev =>
                      prev.includes(cat.slug)
                        ? prev.filter(s => s !== cat.slug)
                        : [...prev, cat.slug],
                    )
                  }
                  style={[
                    styles.tagChip,
                    active && { backgroundColor: accent + '15', borderColor: accent },
                  ]}
                >
                  <FontAwesome5
                    name={cat.icon}
                    size={12}
                    color={active ? accent : colors.textMuted}
                    solid
                  />
                  <Text
                    style={[
                      styles.tagChipText,
                      active && { color: accent, fontWeight: '700' },
                    ]}
                  >
                    {cat.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Media */}
        <View style={styles.cardSection}>
          <Text style={styles.sectionLabel}>{isEditing ? 'Add more photos, video, voice' : 'Attach photos, video, voice'}</Text>
          {isEditing ? (
            <Text style={styles.sectionHint}>Photos, videos and voice notes already on this story stay attached. Anything you add here joins them.</Text>
          ) : null}
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

          {/* Compact, one-time guidance — never repeated per attached item,
              and deliberately careful not to imply either thing happens
              before Save: photo annotation and transcription both only
              start once the story is actually saved. */}
          {drafts.some(d => d.kind === 'photo') ? (
            <Text style={styles.mediaGuidance}>
              After you save, you can tap a spot in the photo to ask who or what it is.
            </Text>
          ) : null}
          {drafts.some(d => d.kind === 'audio') ? (
            <Text style={styles.mediaGuidance}>
              After you save, we'll upload your voice note and transcribe it automatically. The transcript may take a moment to appear.
            </Text>
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

        {/* Upload progress — per-file + overall so a slow island upload reads
            as steady progress, not a hang. */}
        {uploadProg ? (
          <View style={styles.uploadCard}>
            <View style={styles.uploadRow}>
              <ActivityIndicator size="small" color={SECTION.color} />
              <Text style={styles.uploadText}>
                Uploading {uploadProg.current} of {uploadProg.total}…
              </Text>
              <Text style={styles.uploadPct}>
                {Math.round((uploadProg.current / uploadProg.total) * 100)}%
              </Text>
            </View>
            <View style={styles.uploadTrack}>
              <View
                style={[
                  styles.uploadFill,
                  {
                    width: `${Math.round((uploadProg.current / uploadProg.total) * 100)}%`,
                    backgroundColor: SECTION.color,
                  },
                ]}
              />
            </View>
            <Text style={styles.uploadHint}>
              Haud on — dinna close the app till your story's awa.
            </Text>
          </View>
        ) : null}

        {/* Partial-save notice — the memory itself is genuinely saved, but a
            media file isn't. Stays visible (not an Alert that closes and is
            gone) until a retry succeeds or the failing draft is removed. */}
        {partialSaveNotice ? (
          <View style={styles.partialSaveCard}>
            <FontAwesome5 name="exclamation-circle" size={14} color={colors.warningDark} />
            <Text style={styles.partialSaveText}>{partialSaveNotice}</Text>
          </View>
        ) : null}

        {/* Save */}
        <Button
          label={
            uploadProg
              ? `Uploading ${uploadProg.current}/${uploadProg.total}…`
              : partialSaveNotice
              ? 'Retry upload'
              : isEditing ? 'Save changes' : isChild ? 'Add to story' : 'Save story'
          }
          icon="check"
          color={SECTION.color}
          fullWidth
          loading={saving}
          disabled={!canSave}
          onPress={handleSave}
          style={styles.saveBtn}
        />

      </ScrollView>
      )}
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
  pinNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: SECTION.color,
    backgroundColor: SECTION.light,
  },
  pinNoticeText: {
    flex: 1,
    fontSize: fontSize.xs,
    fontWeight: '600',
    color: colors.textPrimary,
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
  tagGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: spacing.sm,
  },
  tagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: colors.offWhite,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tagChipText: {
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
  mediaGuidance: {
    marginTop: spacing.sm,
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 16,
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
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
  },
  draftBanner: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: SECTION.color,
    backgroundColor: SECTION.light,
  },
  draftBannerIcon: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.white,
  },
  draftBannerTitle: {
    fontSize: fontSize.sm,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  draftBannerSub: {
    fontSize: fontSize.xs,
    color: colors.textSecondary,
    marginTop: 2,
  },
  draftBannerActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  draftRestoreBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: SECTION.color,
  },
  draftRestoreText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: fontSize.xs,
  },
  draftDiscardBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  draftDiscardText: {
    color: colors.textMuted,
    fontWeight: '600',
    fontSize: fontSize.xs,
  },
  uploadCard: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
    gap: spacing.sm,
  },
  uploadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  uploadText: {
    flex: 1,
    fontSize: fontSize.sm,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  uploadPct: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: colors.textMuted,
  },
  uploadTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.offWhite,
    overflow: 'hidden',
  },
  uploadFill: {
    height: '100%',
    borderRadius: 3,
  },
  uploadHint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  partialSaveCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.warning,
    backgroundColor: colors.warningLight,
  },
  partialSaveText: {
    flex: 1,
    fontSize: fontSize.xs,
    fontWeight: '600',
    color: colors.warningDark,
    lineHeight: 18,
  },
});
