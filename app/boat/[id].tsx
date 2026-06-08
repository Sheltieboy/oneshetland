/**
 * app/boat/[id].tsx
 *
 * Vessel profile — scrapbook redesign for an older audience.
 *
 * Same data as before, but presented like a memorial card rather than a
 * database record:
 *   * 32 px hero name, 18 px body, no faint grey metas
 *   * Plain-English section labels: "Names she went by", "Numbers she
 *     carried", "Owners through the years", "Her size", "Photos",
 *     "Her story", "How we know"
 *   * Confidence chips read as full English ("Almost certain") not as DB
 *     enum slugs
 *   * Save heart in the header — toggles AsyncStorage-backed saved list
 *   * pushRecentBoat() fires on first load so the landing's "You looked
 *     at" row picks the vessel up
 *   * Evidence drawer (now "How we know") is even further out of the way
 *     — collapsed by default, plain wording, monospace raw text only
 *     visible when expanded
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator,
  TouchableOpacity, Image, Linking, Share, TextInput, Alert,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS } from '@/constants/sections';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import {
  fetchVesselProfile, fetchVesselTimeline,
  fetchVesselComments, threadComments,
  addVesselComment, editVesselComment, deleteVesselComment,
  VesselProfile, VesselTimelineEntry, VesselComment, Confidence,
  CommentSubject, COMMENT_SUBJECTS, commentSubjectLabel,
  vesselDisplayTitle, hullMaterialLabel, eventTypeLabel, confidenceLabel,
} from '@/lib/boats-api';
import { PickedFile } from '@/lib/image-upload';
import {
  isBoatSaved, toggleSavedBoat, pushRecentBoat,
} from '@/lib/boats-prefs';
import { useAuth } from '@/context/AuthContext';

const SECTION = SECTIONS.daBoats;

// Soft-load the picker so a missing dep alerts instead of crashing the bundle.
let ImagePicker: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ImagePicker = require('expo-image-picker');
} catch {
  ImagePicker = null;
}

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
  const { profile: viewer } = useAuth();

  const [profile, setProfile]       = useState<VesselProfile | null>(null);
  const [timeline, setTimeline]     = useState<VesselTimelineEntry[]>([]);
  const [comments, setComments]     = useState<VesselComment[]>([]);
  const [loading, setLoading]       = useState(true);
  const [saved, setSaved]           = useState(false);
  const [showEvidence, setShowEv]   = useState(false);

  // Composer state
  const [draft, setDraft]                 = useState('');
  const [draftSubject, setDraftSubject]   = useState<CommentSubject>('general');
  const [replyTo, setReplyTo]             = useState<VesselComment | null>(null);
  const [posting, setPosting]             = useState(false);
  const [editingId, setEditingId]         = useState<string | null>(null);

  /** Local preview URI for a freshly-picked image (before upload). */
  const [draftPhoto, setDraftPhoto]       = useState<PickedFile | null>(null);
  /** When editing, the existing image_url + path so we can show or replace. */
  const [editingPhotoUrl, setEditingPhotoUrl]   = useState<string | null>(null);
  const [editingPhotoPath, setEditingPhotoPath] = useState<string | null>(null);
  /** True when the user has explicitly removed an existing photo while editing. */
  const [removeExistingPhoto, setRemoveExisting] = useState(false);

  const pickPhoto = async () => {
    if (!ImagePicker) {
      Alert.alert(
        'Setup needed',
        'Run `npx expo install expo-image-picker` and rebuild.',
      );
      return;
    }
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission needed', 'OneShetland needs access to your photos.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions?.Images ?? ['images'],
        allowsEditing: false,
        quality: 0.85,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      setDraftPhoto({
        uri:      asset.uri,
        mimeType: asset.mimeType,
        ext:      asset.fileName?.split('.').pop(),
      });
      setRemoveExisting(false);
    } catch (err: any) {
      Alert.alert('Could not pick a photo', err?.message ?? '');
    }
  };

  const clearDraftPhoto = () => {
    setDraftPhoto(null);
    if (editingId) setRemoveExisting(true);
  };

  const reloadComments = useCallback(async () => {
    if (!id) return;
    try {
      const c = await fetchVesselComments(id);
      setComments(c);
    } catch { /* swallow */ }
  }, [id]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [p, t, isSaved, c] = await Promise.all([
        fetchVesselProfile(id),
        fetchVesselTimeline(id),
        isBoatSaved(id),
        fetchVesselComments(id),
      ]);
      setProfile(p);
      setTimeline(t);
      setSaved(isSaved);
      setComments(c);

      // Stash a stub on the recently-viewed list for the landing screen.
      if (p) {
        const heroUrl = p.media.find(m => m.media?.image_url)?.media?.image_url ?? null;
        void pushRecentBoat({
          id: p.vessel.id,
          lk_number: p.vessel.primary_lk_number,
          canonical_name: p.vessel.canonical_name,
          built_year: p.vessel.built_year,
          hero_url: heroUrl,
        });
      }
    } catch {
      setProfile(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  const handleSaveToggle = async () => {
    if (!profile) return;
    const heroUrl = profile.media.find(m => m.media?.image_url)?.media?.image_url ?? null;
    const isNowSaved = await toggleSavedBoat({
      id: profile.vessel.id,
      lk_number: profile.vessel.primary_lk_number,
      canonical_name: profile.vessel.canonical_name,
      built_year: profile.vessel.built_year,
      hero_url: heroUrl,
    });
    setSaved(isNowSaved);
  };

  const handleShare = async () => {
    if (!profile) return;
    const title = vesselDisplayTitle(profile.vessel);
    try {
      await Share.share({
        message: `Looking at ${title} on OneShetland — Da Boats heritage register.`,
      });
    } catch { /* user cancelled */ }
  };

  // ── Comments ────────────────────────────────────────────────────────────

  const submitComment = async () => {
    if (!viewer?.id) {
      router.push('/(auth)/sign-in');
      return;
    }
    if (!profile) return;
    const body = draft.trim();
    // Either body or a photo is enough to post; both is fine too.
    if (!body && !draftPhoto && !editingPhotoUrl) return;

    setPosting(true);
    try {
      if (editingId) {
        await editVesselComment(editingId, body, {
          newImageFile:      draftPhoto,
          removeImage:       removeExistingPhoto && !draftPhoto,
          authorId:          viewer.id,
          previousImagePath: editingPhotoPath,
        });
      } else {
        await addVesselComment({
          vesselId:        profile.vessel.id,
          authorId:        viewer.id,
          body,
          subjectType:     draftSubject,
          parentCommentId: replyTo?.id ?? null,
          imageFile:       draftPhoto,
        });
      }
      setDraft('');
      setReplyTo(null);
      setEditingId(null);
      setDraftSubject('general');
      setDraftPhoto(null);
      setEditingPhotoUrl(null);
      setEditingPhotoPath(null);
      setRemoveExisting(false);
      await reloadComments();
    } catch (err: any) {
      Alert.alert('Could not post', err?.message ?? '');
    } finally {
      setPosting(false);
    }
  };

  const startEdit = (c: VesselComment) => {
    setEditingId(c.id);
    setDraftSubject(c.subject_type);
    setDraft(c.body);
    setReplyTo(null);
    setDraftPhoto(null);
    setEditingPhotoUrl(c.image_url);
    setEditingPhotoPath(c.image_path);
    setRemoveExisting(false);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft('');
    setReplyTo(null);
    setDraftSubject('general');
    setDraftPhoto(null);
    setEditingPhotoUrl(null);
    setEditingPhotoPath(null);
    setRemoveExisting(false);
  };

  const removeComment = (c: VesselComment) => {
    Alert.alert(
      'Delete comment?',
      'This can\'t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            try {
              await deleteVesselComment(c.id);
              await reloadComments();
            } catch (err: any) {
              Alert.alert('Failed', err?.message ?? '');
            }
          },
        },
      ],
    );
  };

  const threaded = useMemo(() => threadComments(comments), [comments]);

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, styles.center]}>
        <ActivityIndicator color={SECTION.color} size="large" />
      </SafeAreaView>
    );
  }
  if (!profile) {
    return (
      <SafeAreaView style={[styles.container, styles.center]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={styles.bodyMuted}>Couldn't find that boat.</Text>
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
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* Top bar */}
        <View style={styles.topBar}>
          <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} hitSlop={12}>
            <FontAwesome5 name="chevron-left" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          <TouchableOpacity onPress={handleShare} style={styles.iconBtn} hitSlop={12}>
            <FontAwesome5 name="share-alt" size={20} color={colors.textSecondary} />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleSaveToggle} style={styles.iconBtn} hitSlop={12}>
            <FontAwesome5
              name="heart"
              size={22}
              color={saved ? SECTION.color : colors.textSecondary}
              solid={saved}
            />
          </TouchableOpacity>
        </View>

        {/* Hero photo — proper aspect ratio, edge-to-edge */}
        {heroPhoto?.image_url ? (
          <View style={styles.heroWrap}>
            <Image source={{ uri: heroPhoto.image_url }} style={styles.hero} resizeMode="cover" />
          </View>
        ) : (
          <View style={styles.heroPlaceholder}>
            <FontAwesome5 name="ship" size={64} color={SECTION.color} />
          </View>
        )}

        {/* Name + LK */}
        <View style={styles.headerBlock}>
          <Text style={[styles.lk, { color: SECTION.color }]}>
            {vessel.primary_lk_number ?? 'No LK number on file'}
          </Text>
          <Text style={styles.title}>{vessel.canonical_name}</Text>
          {(vessel.built_year || hull) ? (
            <Text style={styles.subtitle}>
              {vessel.built_year ? `Built ${vessel.built_year}` : 'Year unknown'}
              {hull ? `  ·  ${hull} hull` : ''}
              {vessel.builder ? `  ·  ${vessel.builder}` : ''}
            </Text>
          ) : null}
        </View>

        {/* Confidence callout — explains what level of certainty we're at */}
        <View style={[
          styles.confCallout,
          { backgroundColor: CONFIDENCE_TONE[vessel.identity_confidence].bg },
        ]}>
          <FontAwesome5
            name={vessel.identity_confidence === 'confirmed' ? 'check-circle' : 'info-circle'}
            size={16}
            color={CONFIDENCE_TONE[vessel.identity_confidence].text}
            solid
          />
          <Text style={[styles.confCalloutText, { color: CONFIDENCE_TONE[vessel.identity_confidence].text }]}>
            {confidenceText(vessel.identity_confidence)}
          </Text>
        </View>

        {/* Names she went by */}
        {names.length ? (
          <Section title="Names she went by" subtitle={names.length === 1 ? '' : `${names.length} known`}>
            {names.map(n => (
              <BigRow
                key={n.id}
                primary={n.name}
                secondary={fmtYears(n.start_year, n.end_year, n.date_text)}
                badge={n.is_primary ? 'main name' : undefined}
                confidence={n.confidence}
              />
            ))}
          </Section>
        ) : null}

        {/* Numbers she carried */}
        {registrations.length ? (
          <Section title="Numbers she carried" subtitle={registrations.length === 1 ? '' : `${registrations.length} known`}>
            {registrations.map(r => (
              <BigRow
                key={r.id}
                primary={r.registration}
                secondary={fmtYears(r.start_year, r.end_year, r.date_text)}
                pillColor={SECTION.color}
                badge={r.is_primary ? 'main number' : undefined}
                confidence={r.confidence}
              />
            ))}
          </Section>
        ) : null}

        {/* Owners through the years */}
        {ownerships.length ? (
          <Section title="Owners through the years">
            {ownerships.map(o => (
              <BigRow
                key={o.id}
                primary={o.owner?.name ?? 'Unknown owner'}
                secondary={fmtYears(o.start_year, o.end_year, o.date_text) || (o.notes ?? '')}
                confidence={o.confidence}
              />
            ))}
          </Section>
        ) : null}

        {/* Her size */}
        {measurements.length ? (
          <Section title="Her size">
            {measurements.map(m => {
              const bits: string[] = [];
              if (m.length_m)      bits.push(`${Number(m.length_m).toFixed(1)} m long`);
              if (m.tonnage_text)  bits.push(m.tonnage_text);
              else if (m.tonnage)  bits.push(`${m.tonnage} tons`);
              if (m.engine_power_kw) bits.push(`${m.engine_power_kw} kW`);
              return (
                <BigRow
                  key={m.id}
                  primary={bits.join('  ·  ') || 'Measurement on record'}
                  secondary={[m.measurement_year, m.notes].filter(Boolean).join(' · ')}
                />
              );
            })}
          </Section>
        ) : null}

        {/* Photos */}
        {media.length ? (
          <Section
            title="Photos"
            subtitle={
              media.filter(m => m.media?.image_url).length === 0
                ? 'Photo references only — tap to find the original'
                : `${media.length} on file`
            }
          >
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
                        <FontAwesome5 name="camera" size={22} color={SECTION.color} />
                        <Text style={styles.photoPlaceholderText} numberOfLines={2}>
                          {mm.external_ref ?? 'See original'}
                        </Text>
                      </View>
                    )}
                    {mm.page_url && !mm.image_url ? (
                      <View style={styles.photoCatalogue}>
                        <FontAwesome5 name="external-link-alt" size={9} color="#fff" />
                      </View>
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          </Section>
        ) : null}

        {/* Her story (timeline) */}
        {timeline.length ? (
          <Section title="Her story" subtitle="Through the years">
            {timeline.map((t, i) => (
              <View key={i} style={styles.timelineRow}>
                <View style={[styles.year, { backgroundColor: SECTION.light }]}>
                  <Text style={[styles.yearText, { color: SECTION.color }]}>{t.year ?? '—'}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.timelineEvent}>{eventTypeLabel(t.item_type)}</Text>
                  <Text style={styles.timelineDesc}>{t.description}</Text>
                  {t.date_text ? (
                    <Text style={styles.timelineMeta}>{t.date_text}</Text>
                  ) : null}
                </View>
              </View>
            ))}
          </Section>
        ) : null}

        {/* How we know (evidence drawer) */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>How we know</Text>
          <Text style={styles.sectionSubtitle}>
            Every fact above came from one of these sources. Tap to see the raw record.
          </Text>
          <TouchableOpacity
            onPress={() => setShowEv(s => !s)}
            style={[styles.drawerToggle, { backgroundColor: SECTION.light }]}
          >
            <FontAwesome5
              name={showEvidence ? 'chevron-down' : 'chevron-right'}
              size={14}
              color={SECTION.color}
            />
            <Text style={[styles.drawerToggleText, { color: SECTION.color }]}>
              {showEvidence
                ? 'Hide sources'
                : `Show ${evidence.length} source${evidence.length === 1 ? '' : 's'}`}
            </Text>
          </TouchableOpacity>

          {showEvidence ? (
            <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
              {evidence.map(ev => {
                const sr = ev.source_record;
                const doc = (sr as any)?.document;
                return (
                  <View key={ev.id} style={styles.evidenceCard}>
                    <View style={styles.evidenceTopRow}>
                      <Text style={styles.evidenceType} numberOfLines={1}>
                        {humaniseRecordType(sr?.record_type ?? '')}
                      </Text>
                      <ConfidencePill value={ev.confidence} />
                    </View>
                    {sr?.raw_text ? (
                      <Text style={styles.evidenceRaw} numberOfLines={6}>
                        {sr.raw_text}
                      </Text>
                    ) : null}
                    {doc?.title ? (
                      <TouchableOpacity
                        onPress={() => doc.url ? Linking.openURL(doc.url) : null}
                        disabled={!doc.url}
                      >
                        <Text style={[styles.evidenceSource, doc.url && { textDecorationLine: 'underline' }]}>
                          From: {doc.title}
                          {doc.publisher ? ` (${doc.publisher})` : ''}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                    {sr?.source_page ? (
                      <Text style={styles.evidencePage}>Page {sr.source_page}</Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>

        {vessel.identity_notes ? (
          <Text style={styles.footnote}>{vessel.identity_notes}</Text>
        ) : null}

        {/* ── Discussion ──────────────────────────────────────────── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Discussion</Text>
          <Text style={styles.sectionSubtitle}>
            Share what you remember. Got a correction or a story — it belongs here.
          </Text>

          {/* Comments list */}
          <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
            {threaded.length === 0 ? (
              <Text style={styles.emptyComments}>
                No one's added anything yet. Be the first.
              </Text>
            ) : (
              threaded.map(c => (
                <CommentNode
                  key={c.id}
                  comment={c}
                  viewerId={viewer?.id ?? null}
                  isAuthor={c.author_id === viewer?.id}
                  onReply={() => { setReplyTo(c); setEditingId(null); setDraft(''); }}
                  onEdit={() => startEdit(c)}
                  onDelete={() => removeComment(c)}
                  startEdit={startEdit}
                  removeComment={removeComment}
                  setReplyTo={(rt) => { setReplyTo(rt); setEditingId(null); setDraft(''); }}
                />
              ))
            )}
          </View>

          {/* Composer */}
          <View style={styles.composer}>
            {/* Reply / edit banner */}
            {(replyTo || editingId) ? (
              <View style={styles.composerBanner}>
                <Text style={styles.composerBannerText}>
                  {editingId
                    ? 'Editing your comment'
                    : `Replying to ${replyTo?.author?.full_name ?? 'comment'}`}
                </Text>
                <TouchableOpacity onPress={cancelEdit} hitSlop={8}>
                  <FontAwesome5 name="times" size={14} color={colors.textMuted} />
                </TouchableOpacity>
              </View>
            ) : null}

            {/* Subject chip row */}
            {!editingId && !replyTo ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.subjectRow}
              >
                {COMMENT_SUBJECTS.map(s => {
                  const active = draftSubject === s.slug;
                  return (
                    <TouchableOpacity
                      key={s.slug}
                      onPress={() => setDraftSubject(s.slug)}
                      style={[
                        styles.subjectChip,
                        active && { backgroundColor: SECTION.color, borderColor: SECTION.color },
                      ]}
                    >
                      <FontAwesome5
                        name={s.icon}
                        size={11}
                        color={active ? '#fff' : SECTION.color}
                        solid
                      />
                      <Text style={[styles.subjectChipText, active && { color: '#fff' }]}>
                        {s.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            ) : null}

            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={
                viewer
                  ? editingId
                    ? 'Update your comment…'
                    : replyTo
                      ? 'Write your reply…'
                      : 'Share what you know about this boat…'
                  : 'Sign in to add to the discussion'
              }
              placeholderTextColor={colors.textMuted}
              multiline
              editable={!!viewer}
              style={styles.composerInput}
            />

            {/* Photo preview — shows the new pick, OR the existing photo while
                editing (unless the user has cleared it). */}
            {(() => {
              const previewUri = draftPhoto?.uri
                ?? (editingId && !removeExistingPhoto ? editingPhotoUrl : null);
              if (!previewUri) return null;
              return (
                <View style={styles.draftPhotoWrap}>
                  <Image source={{ uri: previewUri }} style={styles.draftPhoto} resizeMode="cover" />
                  <TouchableOpacity onPress={clearDraftPhoto} style={styles.draftPhotoClear} hitSlop={10}>
                    <FontAwesome5 name="times" size={12} color="#fff" />
                  </TouchableOpacity>
                </View>
              );
            })()}

            <View style={styles.composerActions}>
              {/* Photo button on the left */}
              {viewer ? (
                <TouchableOpacity
                  onPress={pickPhoto}
                  style={[styles.iconAction, { borderColor: SECTION.color }]}
                  hitSlop={8}
                >
                  <FontAwesome5
                    name="camera"
                    size={18}
                    color={SECTION.color}
                  />
                  {draftPhoto || (editingId && editingPhotoUrl && !removeExistingPhoto) ? (
                    <Text style={[styles.iconActionText, { color: SECTION.color }]}>1</Text>
                  ) : null}
                </TouchableOpacity>
              ) : null}

              <View style={{ flex: 1 }} />

              {/* Post / Sign-in on the right */}
              {!viewer ? (
                <TouchableOpacity
                  onPress={() => router.push('/(auth)/sign-in')}
                  style={[styles.postBtn, { backgroundColor: SECTION.color }]}
                >
                  <FontAwesome5 name="sign-in-alt" size={14} color="#fff" />
                  <Text style={styles.postBtnText}>Sign in</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  onPress={submitComment}
                  disabled={posting || (!draft.trim() && !draftPhoto && !editingPhotoUrl)}
                  style={[
                    styles.postBtn,
                    {
                      backgroundColor: SECTION.color,
                      opacity: (posting || (!draft.trim() && !draftPhoto && !editingPhotoUrl)) ? 0.45 : 1,
                    },
                  ]}
                >
                  {posting ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <FontAwesome5
                        name={editingId ? 'check' : 'paper-plane'}
                        size={14}
                        color="#fff"
                      />
                      <Text style={styles.postBtnText}>
                        {editingId ? 'Save' : replyTo ? 'Reply' : 'Post'}
                      </Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Comment thread node ─────────────────────────────────────────────────────

function CommentNode({
  comment, viewerId, isAuthor,
  onReply, onEdit, onDelete,
  startEdit, removeComment, setReplyTo,
  depth = 0,
}: {
  comment: VesselComment;
  viewerId: string | null;
  isAuthor: boolean;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  startEdit: (c: VesselComment) => void;
  removeComment: (c: VesselComment) => void;
  setReplyTo: (c: VesselComment | null) => void;
  depth?: number;
}) {
  return (
    <View style={[styles.commentNode, depth > 0 && styles.commentReply]}>
      <View style={[styles.commentAvatar, { backgroundColor: SECTION.light }]}>
        {comment.author?.avatar_url ? (
          <Image source={{ uri: comment.author.avatar_url }} style={StyleSheet.absoluteFill} />
        ) : (
          <FontAwesome5 name="user" size={13} color={SECTION.color} />
        )}
      </View>

      <View style={{ flex: 1 }}>
        <View style={styles.commentTopRow}>
          <Text style={styles.commentAuthor}>
            {comment.author?.full_name ?? 'Anonymous'}
          </Text>
          {comment.subject_type && comment.subject_type !== 'general' ? (
            <View style={[styles.commentSubject, { backgroundColor: SECTION.light }]}>
              <Text style={[styles.commentSubjectText, { color: SECTION.color }]}>
                {commentSubjectLabel(comment.subject_type)}
              </Text>
            </View>
          ) : null}
        </View>

        {comment.body ? (
          <Text style={styles.commentBody}>{comment.body}</Text>
        ) : null}

        {comment.image_url ? (
          <TouchableOpacity
            onPress={() => Linking.openURL(comment.image_url!)}
            activeOpacity={0.9}
            style={styles.commentPhotoWrap}
          >
            <Image
              source={{ uri: comment.image_url }}
              style={styles.commentPhoto}
              resizeMode="cover"
            />
          </TouchableOpacity>
        ) : null}

        <View style={styles.commentMeta}>
          <Text style={styles.commentTime}>
            {fmtRelative(comment.created_at)}
            {comment.edited_at ? ' · edited' : ''}
          </Text>
          {depth === 0 ? (
            <TouchableOpacity onPress={onReply} hitSlop={6}>
              <Text style={[styles.commentLink, { color: SECTION.color }]}>Reply</Text>
            </TouchableOpacity>
          ) : null}
          {isAuthor ? (
            <>
              <TouchableOpacity onPress={onEdit} hitSlop={6}>
                <Text style={styles.commentLink}>Edit</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={onDelete} hitSlop={6}>
                <Text style={[styles.commentLink, { color: colors.error }]}>Delete</Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>

        {/* Nested replies */}
        {comment.replies && comment.replies.length > 0 ? (
          <View style={{ marginTop: spacing.sm, gap: spacing.sm }}>
            {comment.replies.map(r => (
              <CommentNode
                key={r.id}
                comment={r}
                viewerId={viewerId}
                isAuthor={r.author_id === viewerId}
                onReply={() => setReplyTo(comment)}
                onEdit={() => startEdit(r)}
                onDelete={() => removeComment(r)}
                startEdit={startEdit}
                removeComment={removeComment}
                setReplyTo={setReplyTo}
                depth={depth + 1}
              />
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function fmtRelative(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1)    return 'just now';
  if (mins < 60)   return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)    return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7)    return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5)   return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtYears(start: number | null, end: number | null, dateText: string | null): string {
  if (dateText) return dateText;
  if (start && end)   return `${start}–${end}`;
  if (start)          return `From ${start}`;
  if (end)            return `Until ${end}`;
  return '';
}

function humaniseRecordType(t: string): string {
  if (!t) return 'Source record';
  return t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function confidenceText(c: Confidence): string {
  switch (c) {
    case 'confirmed': return 'This boat is confirmed in the official register.';
    case 'probable':  return 'Almost certainly this boat — strong matching evidence.';
    case 'possible':  return 'Likely this boat, but we\'re still tying off the details.';
    case 'unmatched': return 'Awaiting more evidence to be confident.';
    case 'conflict':  return 'Sources disagree about this boat — see below.';
  }
}

function Section({
  title, subtitle, children,
}: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {subtitle ? <Text style={styles.sectionSubtitle}>{subtitle}</Text> : null}
      <View style={{ gap: 4, marginTop: spacing.sm }}>{children}</View>
    </View>
  );
}

function BigRow({
  primary, secondary, badge, pillColor, confidence,
}: {
  primary: string;
  secondary?: string;
  badge?: string;
  pillColor?: string;
  confidence?: Confidence;
}) {
  return (
    <View style={styles.bigRow}>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {pillColor ? (
            <View style={[styles.regPill, { backgroundColor: pillColor }]}>
              <Text style={styles.regPillText} numberOfLines={1}>{primary}</Text>
            </View>
          ) : (
            <Text style={styles.bigPrimary}>{primary}</Text>
          )}
          {badge ? (
            <View style={styles.badgeChip}>
              <Text style={styles.badgeChipText}>{badge}</Text>
            </View>
          ) : null}
        </View>
        {secondary ? <Text style={styles.bigSecondary}>{secondary}</Text> : null}
      </View>
      {confidence ? <ConfidencePill value={confidence} /> : null}
    </View>
  );
}

function ConfidencePill({ value }: { value: Confidence }) {
  const t = CONFIDENCE_TONE[value];
  return (
    <View style={[styles.confPill, { backgroundColor: t.bg }]}>
      <Text style={[styles.confPillText, { color: t.text }]}>{confidenceLabel(value)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.screenBackground },
  scroll:    { paddingBottom: spacing.xxl, gap: spacing.lg },
  center:    { alignItems: 'center', justifyContent: 'center' },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  iconBtn: {
    width: 44, height: 44,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: 22,
  },

  heroWrap: {
    width: '100%',
    aspectRatio: 16 / 10,
    backgroundColor: '#000',
  },
  hero: { width: '100%', height: '100%' },
  heroPlaceholder: {
    width: '100%',
    aspectRatio: 16 / 10,
    backgroundColor: SECTION.light,
    alignItems: 'center',
    justifyContent: 'center',
  },

  headerBlock: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: 4,
  },
  lk: {
    fontSize: 15,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 1.5,
  },
  title: {
    fontSize: 32,
    fontWeight: '900',
    color: colors.textPrimary,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 17,
    color: colors.textSecondary,
    marginTop: 4,
    fontWeight: '500',
  },

  confCallout: {
    marginHorizontal: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  confCalloutText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 19,
  },

  section: {
    marginHorizontal: spacing.lg,
    padding: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  sectionSubtitle: {
    fontSize: 14,
    color: colors.textMuted,
    marginTop: 2,
  },

  bigRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  bigPrimary: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  bigSecondary: {
    fontSize: 15,
    color: colors.textSecondary,
    marginTop: 2,
  },

  regPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  regPillText: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 14,
    letterSpacing: 0.5,
  },

  badgeChip: {
    backgroundColor: colors.offWhite,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  badgeChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  confPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  confPillText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.2,
  },

  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: spacing.sm,
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
    fontSize: 11,
    fontWeight: '700',
    color: colors.textMuted,
    textAlign: 'center',
  },
  photoCatalogue: {
    position: 'absolute',
    top: 6, right: 6,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: 'rgba(15, 28, 38, 0.7)',
    alignItems: 'center', justifyContent: 'center',
  },

  timelineRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  year: {
    minWidth: 56,
    height: 32,
    paddingHorizontal: 8,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  yearText: { fontSize: 13, fontWeight: '900' },
  timelineEvent: { fontSize: 13, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  timelineDesc:  { fontSize: 16, color: colors.textPrimary, marginTop: 2, lineHeight: 22 },
  timelineMeta:  { fontSize: 13, color: colors.textMuted, marginTop: 2 },

  drawerToggle: {
    marginTop: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    alignSelf: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 999,
  },
  drawerToggleText: { fontSize: 15, fontWeight: '800' },

  evidenceCard: {
    padding: spacing.md,
    backgroundColor: colors.offWhite,
    borderRadius: radius.md,
    gap: 6,
  },
  evidenceTopRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  evidenceType: {
    flex: 1,
    fontSize: 13,
    fontWeight: '800',
    color: colors.textSecondary,
  },
  evidenceRaw: {
    fontSize: 13,
    color: colors.textPrimary,
    fontFamily: 'Courier',
    backgroundColor: colors.white,
    padding: 8,
    borderRadius: 6,
    lineHeight: 18,
  },
  evidenceSource: { fontSize: 14, color: colors.textSecondary, fontWeight: '600' },
  evidencePage:   { fontSize: 12, color: colors.textMuted },

  bodyMuted: { fontSize: 17, color: colors.textSecondary, marginBottom: spacing.md },
  backBtnSmall: {
    backgroundColor: SECTION.color,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  backBtnSmallText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  footnote: {
    paddingHorizontal: spacing.lg,
    fontSize: 13,
    color: colors.textMuted,
    fontStyle: 'italic',
    lineHeight: 18,
  },

  // ── Discussion ────────────────────────────────────────────────────────────
  emptyComments: {
    fontSize: 15,
    color: colors.textMuted,
    fontStyle: 'italic',
    paddingVertical: spacing.sm,
  },
  commentNode: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: 8,
  },
  commentReply: {
    paddingLeft: 0,
  },
  commentAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  commentTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  commentAuthor: {
    fontSize: 15,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  commentSubject: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  commentSubjectText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  commentBody: {
    fontSize: 16,
    color: colors.textPrimary,
    lineHeight: 22,
    marginTop: 2,
  },
  commentMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 6,
  },
  commentTime: {
    fontSize: 12,
    color: colors.textMuted,
  },
  commentLink: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textSecondary,
  },

  composer: {
    marginTop: spacing.lg,
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
  },
  composerBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.offWhite,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  composerBannerText: {
    flex: 1,
    fontSize: 13,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  subjectRow: {
    gap: 6,
    paddingVertical: 4,
  },
  subjectChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.white,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  subjectChipText: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textSecondary,
  },
  composerInput: {
    minHeight: 88,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 16,
    color: colors.textPrimary,
    backgroundColor: colors.white,
    textAlignVertical: 'top',
  },
  composerActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  postBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: 999,
  },
  postBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
  },

  // Composer photo
  iconAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 2,
    backgroundColor: colors.white,
  },
  iconActionText: {
    fontSize: 13,
    fontWeight: '800',
  },
  draftPhotoWrap: {
    position: 'relative',
    borderRadius: radius.md,
    overflow: 'hidden',
    alignSelf: 'flex-start',
    maxWidth: '60%',
  },
  draftPhoto: {
    width: 220,
    aspectRatio: 4 / 3,
  },
  draftPhotoClear: {
    position: 'absolute',
    top: 6, right: 6,
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: 'rgba(15, 28, 38, 0.78)',
    alignItems: 'center', justifyContent: 'center',
  },

  // Comment-rendered photo
  commentPhotoWrap: {
    marginTop: 8,
    borderRadius: radius.md,
    overflow: 'hidden',
    alignSelf: 'flex-start',
    maxWidth: '88%',
  },
  commentPhoto: {
    width: '100%',
    aspectRatio: 4 / 3,
    maxWidth: 320,
    minWidth: 200,
  },
});
