/**
 * app/memory/[id].tsx
 *
 * Memory detail — the rich page behind every pin on the map.
 *
 * Shows:
 *   * author, place, era, story body
 *   * media carousel (photos, videos, voice notes)
 *   * image pins (annotations) overlaid on photos, with a help-me-identify
 *     workflow — tap a pin to read the prompt, reply in the comments
 *   * reactions row (heart / applaud / compass / scroll)
 *   * comments thread
 *   * children: "Memories added to this" — sub-memories pinned to the
 *     same place / story, each opening their own detail page
 *
 * Edit / delete affordances appear when the viewer is the author.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator,
  TouchableOpacity, Image, TextInput, Alert,
  KeyboardAvoidingView, Platform, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { SECTIONS } from '@/constants/sections';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { useAuth } from '@/context/AuthContext';
import {
  fetchMemoryDetail, Memory, MemoryMedia, MemoryImagePin,
  addImagePin, resolveImagePin, deleteImagePin,
  suggestImagePinAnswer, deletePinSuggestion, acceptImagePinSuggestion,
  addComment, deleteComment,
  toggleReaction, ReactionKind,
  deleteMemory,
} from '@/lib/memories-api';
import ImageAnnotationOverlay from '@/components/ImageAnnotationOverlay';
import { MEMORY_CATEGORY_BY_SLUG } from '@/constants/memory-categories';

const SECTION = SECTIONS.memories;

const REACTIONS: { kind: ReactionKind; icon: string; label: string }[] = [
  { kind: 'heart',   icon: 'heart',     label: 'Love it'   },
  { kind: 'applaud', icon: 'hands-wash', label: 'Bravo'    },
  { kind: 'compass', icon: 'compass',   label: 'Helpful'   },
  { kind: 'scroll',  icon: 'scroll',    label: 'Heritage'  },
];

export default function MemoryDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useAuth();

  const [memory, setMemory] = useState<Memory | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Image-pin modal state
  const [activePin, setActivePin]                     = useState<MemoryImagePin | null>(null);
  const [pinPromptDraft, setPinPromptDraft]           = useState('');
  const [pendingPinXY, setPendingPinXY]               = useState<{ x: number; y: number; mediaId: string } | null>(null);

  // Comment composer
  const [commentDraft, setCommentDraft] = useState('');
  const [commenting, setCommenting]     = useState(false);

  const isAuthor = !!(memory && profile && memory.author_id === profile.id);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const m = await fetchMemoryDetail(id, profile?.id ?? null);
      setMemory(m);
    } catch {
      setMemory(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id, profile?.id]);

  useEffect(() => { void load(); }, [load]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  // ── Reactions ────────────────────────────────────────────────────────────

  const onReact = async (kind: ReactionKind) => {
    if (!profile?.id || !memory) {
      router.push('/(auth)/sign-in');
      return;
    }
    // Optimistic flip
    setMemory(m => {
      if (!m) return m;
      const had = m.my_reactions?.includes(kind);
      const next = { ...m };
      next.my_reactions = had
        ? (m.my_reactions ?? []).filter(k => k !== kind)
        : [ ...(m.my_reactions ?? []), kind ];
      next.reactions_by_kind = { ...(m.reactions_by_kind as any) };
      next.reactions_by_kind[kind] = (m.reactions_by_kind?.[kind] ?? 0) + (had ? -1 : 1);
      next.reaction_count = (m.reaction_count ?? 0) + (had ? -1 : 1);
      return next;
    });
    try {
      await toggleReaction(memory.id, profile.id, kind);
    } catch (err: any) {
      Alert.alert('Could not react', err?.message ?? '');
      void load();
    }
  };

  // ── Image pins ───────────────────────────────────────────────────────────

  const onTapEmptyOnImage = (media: MemoryMedia, point: { x: number; y: number }) => {
    if (!isAuthor) return;  // only the memory author can add pins to their own photo
    setPendingPinXY({ x: point.x, y: point.y, mediaId: media.id });
    setPinPromptDraft('');
  };

  const submitNewImagePin = async () => {
    if (!pendingPinXY || !profile?.id || !pinPromptDraft.trim()) return;
    try {
      await addImagePin({
        mediaId:  pendingPinXY.mediaId,
        authorId: profile.id,
        x: pendingPinXY.x,
        y: pendingPinXY.y,
        prompt: pinPromptDraft.trim(),
      });
      setPendingPinXY(null);
      setPinPromptDraft('');
      void load();
    } catch (err: any) {
      Alert.alert('Could not save pin', err?.message ?? '');
    }
  };

  const onTapPin = (pin: MemoryImagePin) => setActivePin(pin);

  const onResolvePin = async (pin: MemoryImagePin, answer: string) => {
    if (!profile?.id) return;
    try {
      await resolveImagePin(pin.id, answer, profile.id);
      setActivePin(null);
      void load();
    } catch (err: any) {
      Alert.alert('Could not resolve', err?.message ?? '');
    }
  };

  const onDeletePin = async (pin: MemoryImagePin) => {
    Alert.alert('Remove pin?', 'This deletes the question, not the photo.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: async () => {
          try {
            await deleteImagePin(pin.id);
            setActivePin(null);
            void load();
          } catch (err: any) {
            Alert.alert('Failed', err?.message ?? '');
          }
        },
      },
    ]);
  };

  // ── Comments ─────────────────────────────────────────────────────────────

  const submitComment = async (imagePinId?: string | null) => {
    if (!profile?.id || !memory || !commentDraft.trim()) return;
    setCommenting(true);
    try {
      await addComment({
        memoryId: memory.id,
        authorId: profile.id,
        body:     commentDraft.trim(),
        imagePinId,
      });
      setCommentDraft('');
      void load();
    } catch (err: any) {
      Alert.alert('Could not post', err?.message ?? '');
    } finally {
      setCommenting(false);
    }
  };

  const onDeleteComment = async (commentId: string) => {
    try {
      await deleteComment(commentId);
      void load();
    } catch (err: any) {
      Alert.alert('Failed', err?.message ?? '');
    }
  };

  // ── Author actions ───────────────────────────────────────────────────────

  const onDeleteMemory = () => {
    if (!memory) return;
    Alert.alert(
      'Delete this memory?',
      'Photos, voice notes, comments and child memories will be removed. This can\'t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            try {
              await deleteMemory(memory.id);
              router.back();
            } catch (err: any) {
              Alert.alert('Failed', err?.message ?? '');
            }
          },
        },
      ],
    );
  };

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, styles.centerFill]}>
        <ActivityIndicator color={SECTION.color} />
      </SafeAreaView>
    );
  }

  if (!memory) {
    return (
      <SafeAreaView style={[styles.container, styles.centerFill]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Text style={styles.bodyText}>Memory not found.</Text>
        <TouchableOpacity onPress={() => router.back()} style={[styles.actionBtn, { marginTop: spacing.md }]}>
          <Text style={styles.actionBtnText}>Go back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={SECTION.color}
            onRefresh={() => { setRefreshing(true); void load(); }}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} hitSlop={10}>
            <FontAwesome5 name="chevron-left" size={18} color={colors.textPrimary} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            {memory.place_name ? (
              <Text style={[styles.eyebrow, { color: SECTION.color }]} numberOfLines={1}>
                {memory.place_name}
              </Text>
            ) : null}
            <Text style={styles.title} numberOfLines={2}>{memory.title ?? 'Untitled memory'}</Text>
          </View>
          {isAuthor ? (
            <TouchableOpacity onPress={onDeleteMemory} style={styles.iconBtn} hitSlop={10}>
              <FontAwesome5 name="trash" size={16} color={colors.error} />
            </TouchableOpacity>
          ) : <View style={{ width: 36 }} />}
        </View>

        {/* Author + era */}
        <View style={styles.authorRow}>
          <View style={[styles.avatar, { backgroundColor: SECTION.light }]}>
            {memory.author?.avatar_url ? (
              <Image source={{ uri: memory.author.avatar_url }} style={StyleSheet.absoluteFill} />
            ) : (
              <FontAwesome5 name="user" size={14} color={SECTION.color} />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.authorName}>{memory.author?.full_name ?? 'Anonymous'}</Text>
            <Text style={styles.authorMeta}>
              {new Date(memory.created_at).toLocaleDateString(undefined, {
                day: 'numeric', month: 'short', year: 'numeric',
              })}
              {memory.era ? ` · ${memory.era}` : ''}
            </Text>
          </View>
        </View>

        {/* Tags */}
        {memory.tags?.length ? (
          <View style={styles.tagRow}>
            {memory.tags.map(slug => {
              const cat = MEMORY_CATEGORY_BY_SLUG[slug];
              if (!cat) return null;
              const accent = cat.color ?? SECTION.color;
              return (
                <View
                  key={slug}
                  style={[styles.tagChip, { backgroundColor: accent + '15', borderColor: accent }]}
                >
                  <FontAwesome5 name={cat.icon} size={11} color={accent} solid />
                  <Text style={[styles.tagChipText, { color: accent }]}>{cat.label}</Text>
                </View>
              );
            })}
          </View>
        ) : null}

        {/* Body */}
        {memory.body ? (
          <Text style={styles.body}>{memory.body}</Text>
        ) : null}

        {/* Media */}
        {memory.media?.length ? (
          <View style={styles.mediaSection}>
            {memory.media.map(mm => (
              <MediaTile
                key={mm.id}
                media={mm}
                pins={(memory.pins ?? []).filter(p => p.media_id === mm.id)}
                isAuthor={isAuthor}
                onTapPin={onTapPin}
                onTapEmpty={point => onTapEmptyOnImage(mm, point)}
              />
            ))}
          </View>
        ) : null}

        {/* Reactions */}
        <View style={styles.reactionsRow}>
          {REACTIONS.map(r => {
            const active = memory.my_reactions?.includes(r.kind);
            const count  = memory.reactions_by_kind?.[r.kind] ?? 0;
            return (
              <TouchableOpacity
                key={r.kind}
                onPress={() => onReact(r.kind)}
                style={[
                  styles.reactionChip,
                  active && { backgroundColor: SECTION.light, borderColor: SECTION.color },
                ]}
              >
                <FontAwesome5
                  name={r.icon}
                  size={13}
                  color={active ? SECTION.color : colors.textMuted}
                  solid={active}
                />
                {count > 0 ? <Text style={styles.reactionCount}>{count}</Text> : null}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Pending pin sheet (inline) */}
        {pendingPinXY ? (
          <View style={styles.inlineSheet}>
            <Text style={styles.sheetTitle}>What are you asking about?</Text>
            <Text style={styles.sheetHint}>
              Drop a clue — "Who's the man on the left?" — and the community can answer below.
            </Text>
            <TextInput
              value={pinPromptDraft}
              onChangeText={setPinPromptDraft}
              placeholder="e.g. Who is this?"
              placeholderTextColor={colors.textLight}
              style={styles.input}
              autoFocus
            />
            <View style={styles.sheetActions}>
              <TouchableOpacity onPress={() => setPendingPinXY(null)} style={styles.actionBtnGhost}>
                <Text style={styles.actionBtnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submitNewImagePin}
                disabled={!pinPromptDraft.trim()}
                style={[styles.actionBtn, !pinPromptDraft.trim() && { opacity: 0.5 }]}
              >
                <Text style={styles.actionBtnText}>Add pin</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {/* Active pin viewer */}
        {activePin ? (
          <ActivePinPanel
            pin={
              // Use the latest copy from memory.pins so suggestions stay
              // fresh after a write — activePin is a snapshot.
              memory.pins?.find(p => p.id === activePin.id) ?? activePin
            }
            isAuthor={isAuthor}
            viewerId={profile?.id ?? null}
            onClose={() => setActivePin(null)}
            onResolve={ans => onResolvePin(activePin, ans)}
            onDelete={() => onDeletePin(activePin)}
            onSuggest={async (answer) => {
              if (!profile?.id) {
                router.push('/(auth)/sign-in');
                return;
              }
              try {
                await suggestImagePinAnswer({
                  pinId: activePin.id,
                  suggesterId: profile.id,
                  answer,
                });
                void load();
              } catch (err: any) {
                Alert.alert('Could not suggest', err?.message ?? '');
              }
            }}
            onAccept={async (suggestionId) => {
              try {
                await acceptImagePinSuggestion(suggestionId);
                setActivePin(null);
                void load();
              } catch (err: any) {
                Alert.alert('Could not accept', err?.message ?? '');
              }
            }}
            onWithdrawSuggestion={async (suggestionId) => {
              try {
                await deletePinSuggestion(suggestionId);
                void load();
              } catch (err: any) {
                Alert.alert('Could not withdraw', err?.message ?? '');
              }
            }}
          />
        ) : null}

        {/* Add to this memory */}
        <View style={styles.threadCallout}>
          <TouchableOpacity
            style={styles.addChildBtn}
            onPress={() => router.push({ pathname: '/memory-new', params: { parent_id: memory.id } })}
          >
            <FontAwesome5 name="layer-group" size={14} color={SECTION.color} />
            <Text style={[styles.addChildText, { color: SECTION.color }]}>Add to this memory</Text>
          </TouchableOpacity>
          <Text style={styles.threadHint}>
            Got a related story, photo, or voice note? Thread it onto this memory so it lives here too.
          </Text>
        </View>

        {/* Sub-memories */}
        {memory.children?.length ? (
          <View style={styles.children}>
            <Text style={styles.sectionTitle}>Added to this memory ({memory.children.length})</Text>
            {memory.children.map(child => (
              <TouchableOpacity
                key={child.id}
                onPress={() => router.push(`/memory/${child.id}`)}
                style={styles.childCard}
              >
                <View style={[styles.avatar, { backgroundColor: SECTION.light }]}>
                  {child.author?.avatar_url ? (
                    <Image source={{ uri: child.author.avatar_url }} style={StyleSheet.absoluteFill} />
                  ) : (
                    <FontAwesome5 name="user" size={12} color={SECTION.color} />
                  )}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.childTitle} numberOfLines={1}>
                    {child.title ?? child.body?.slice(0, 60) ?? 'Untitled'}
                  </Text>
                  <Text style={styles.childMeta}>{child.author?.full_name ?? 'Anonymous'}</Text>
                </View>
                <FontAwesome5 name="chevron-right" size={12} color={colors.textLight} />
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {/* Comments */}
        <View style={styles.commentsBlock}>
          <Text style={styles.sectionTitle}>Comments ({memory.comments?.length ?? 0})</Text>

          {memory.comments?.length ? memory.comments.map(c => (
            <View key={c.id} style={styles.commentRow}>
              <View style={[styles.avatarSm, { backgroundColor: SECTION.light }]}>
                {c.author?.avatar_url ? (
                  <Image source={{ uri: c.author.avatar_url }} style={StyleSheet.absoluteFill} />
                ) : (
                  <FontAwesome5 name="user" size={10} color={SECTION.color} />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.commentAuthor}>{c.author?.full_name ?? 'Anonymous'}</Text>
                {c.image_pin_id ? (
                  <View style={[styles.pinReplyChip, { backgroundColor: SECTION.light }]}>
                    <FontAwesome5 name="question" size={9} color={SECTION.color} />
                    <Text style={[styles.pinReplyChipText, { color: SECTION.color }]}>
                      answer on a pin
                    </Text>
                  </View>
                ) : null}
                <Text style={styles.commentBody}>{c.body}</Text>
              </View>
              {(profile?.id === c.author_id) ? (
                <TouchableOpacity onPress={() => onDeleteComment(c.id)} hitSlop={6}>
                  <FontAwesome5 name="trash" size={11} color={colors.textLight} />
                </TouchableOpacity>
              ) : null}
            </View>
          )) : (
            <Text style={styles.emptyHint}>No comments yet — be the first.</Text>
          )}
        </View>

        {/* Composer */}
        <View style={styles.composer}>
          <TextInput
            value={commentDraft}
            onChangeText={setCommentDraft}
            placeholder="Add a comment or share what you know…"
            placeholderTextColor={colors.textLight}
            multiline
            style={[styles.input, { minHeight: 60, flex: 1 }]}
          />
          <TouchableOpacity
            onPress={() => submitComment(null)}
            disabled={!commentDraft.trim() || commenting}
            style={[
              styles.sendBtn,
              { backgroundColor: SECTION.color, opacity: (!commentDraft.trim() || commenting) ? 0.45 : 1 },
            ]}
          >
            {commenting ? <ActivityIndicator color="#fff" /> : <FontAwesome5 name="paper-plane" size={14} color="#fff" />}
          </TouchableOpacity>
        </View>
      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Media tile ──────────────────────────────────────────────────────────────

function MediaTile({
  media, pins, isAuthor, onTapPin, onTapEmpty,
}: {
  media:      MemoryMedia;
  pins:       MemoryImagePin[];
  isAuthor:   boolean;
  onTapPin:   (pin: MemoryImagePin) => void;
  onTapEmpty: (point: { x: number; y: number }) => void;
}) {
  if (media.kind === 'photo') {
    return (
      <View style={styles.mediaTile}>
        <ImageAnnotationOverlay
          uri={media.url}
          pins={pins}
          mode={isAuthor ? 'annotate' : 'view'}
          onTapPin={onTapPin}
          onTapEmpty={onTapEmpty}
        />
        {media.caption ? <Text style={styles.caption}>{media.caption}</Text> : null}
      </View>
    );
  }

  if (media.kind === 'video') {
    return (
      <View style={styles.mediaTile}>
        <TouchableOpacity style={styles.videoFrame} onPress={() => {/* fullscreen player TBD */}}>
          {media.thumb_url ? (
            <Image source={{ uri: media.thumb_url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />
          )}
          <View style={styles.videoPlay}>
            <FontAwesome5 name="play" size={20} color="#fff" solid />
          </View>
        </TouchableOpacity>
        {media.caption ? <Text style={styles.caption}>{media.caption}</Text> : null}
      </View>
    );
  }

  // audio
  return (
    <View style={[styles.mediaTile, styles.audioTile]}>
      <View style={[styles.avatar, { backgroundColor: SECTION.light }]}>
        <FontAwesome5 name="microphone" size={18} color={SECTION.color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.audioTitle}>Voice note</Text>
        <Text style={styles.audioMeta}>
          {media.duration_seconds ? `${media.duration_seconds}s` : ''}
          {media.transcript_status === 'pending' ? ' · transcribing…' : ''}
          {media.transcript_status === 'failed'  ? ' · transcription failed' : ''}
        </Text>
        {media.transcript ? (
          <Text style={styles.transcript}>"{media.transcript}"</Text>
        ) : null}
      </View>
    </View>
  );
}

// ── Active pin panel ────────────────────────────────────────────────────────

function ActivePinPanel({
  pin, isAuthor, viewerId, onClose, onResolve, onDelete,
  onSuggest, onAccept, onWithdrawSuggestion,
}: {
  pin:                   MemoryImagePin;
  isAuthor:              boolean;
  viewerId:              string | null;
  onClose:               () => void;
  onResolve:             (answer: string) => void;
  onDelete:              () => void;
  onSuggest:             (answer: string) => void | Promise<void>;
  onAccept:              (suggestionId: string) => void | Promise<void>;
  onWithdrawSuggestion:  (suggestionId: string) => void | Promise<void>;
}) {
  const [answer, setAnswer]       = useState(pin.resolved_answer ?? '');
  const [suggest, setSuggest]     = useState('');
  const [busy, setBusy]           = useState(false);

  const suggestions = pin.suggestions ?? [];
  // Has this viewer already suggested? Used to swap the composer for a
  // "you suggested X" row so we don't invite spam.
  const mySuggestion = viewerId
    ? suggestions.find(s => s.suggester_id === viewerId)
    : null;

  return (
    <View style={styles.inlineSheet}>
      <View style={styles.pinSheetHeader}>
        <View style={[styles.pinHeadMini, { backgroundColor: pin.resolved ? colors.success : SECTION.color }]}>
          <FontAwesome5 name={pin.resolved ? 'check' : 'question'} size={10} color="#fff" solid />
        </View>
        <Text style={styles.sheetTitle}>{pin.prompt}</Text>
        <TouchableOpacity onPress={onClose} hitSlop={10}>
          <FontAwesome5 name="times" size={16} color={colors.textMuted} />
        </TouchableOpacity>
      </View>

      {/* Resolved answer */}
      {pin.resolved ? (
        <Text style={styles.resolvedAnswer}>
          <Text style={{ fontWeight: '700' }}>Identified as: </Text>
          {pin.resolved_answer}
        </Text>
      ) : null}

      {/* Existing community suggestions */}
      {!pin.resolved && suggestions.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={styles.sheetSubLabel}>
            {suggestions.length === 1 ? '1 suggestion' : `${suggestions.length} suggestions`}
          </Text>
          {suggestions.map(s => {
            const mine = s.suggester_id === viewerId;
            return (
              <View key={s.id} style={styles.suggestionRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.suggestionAnswer}>{s.answer}</Text>
                  <Text style={styles.suggestionMeta}>
                    {s.suggester?.full_name ?? 'Anonymous'}
                  </Text>
                </View>
                {isAuthor ? (
                  <TouchableOpacity
                    onPress={async () => { setBusy(true); await onAccept(s.id); setBusy(false); }}
                    disabled={busy}
                    style={styles.acceptBtn}
                  >
                    <FontAwesome5 name="check" size={11} color="#fff" solid />
                    <Text style={styles.acceptBtnText}>Accept</Text>
                  </TouchableOpacity>
                ) : null}
                {mine ? (
                  <TouchableOpacity
                    onPress={() => onWithdrawSuggestion(s.id)}
                    hitSlop={8}
                    style={{ paddingHorizontal: 6 }}
                  >
                    <FontAwesome5 name="times" size={12} color={colors.textMuted} />
                  </TouchableOpacity>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

      {/* Viewer is NOT author + pin NOT resolved → invite a suggestion */}
      {!pin.resolved && !isAuthor && !mySuggestion ? (
        <>
          <Text style={styles.sheetHint}>
            Recognise this? Help the author identify it — your suggestion goes to them to accept.
          </Text>
          <TextInput
            value={suggest}
            onChangeText={setSuggest}
            placeholder="e.g. That's my grandfather, John Anderson"
            placeholderTextColor={colors.textLight}
            style={styles.input}
            multiline
          />
          <View style={styles.sheetActions}>
            <TouchableOpacity
              onPress={async () => {
                if (!suggest.trim()) return;
                setBusy(true);
                await onSuggest(suggest.trim());
                setSuggest('');
                setBusy(false);
              }}
              disabled={busy || !suggest.trim()}
              style={[styles.actionBtn, (!suggest.trim() || busy) && { opacity: 0.5 }]}
            >
              <FontAwesome5 name="lightbulb" size={11} color="#fff" solid />
              <Text style={styles.actionBtnText}>Suggest</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : null}

      {/* Already suggested (viewer is non-author) */}
      {!pin.resolved && !isAuthor && mySuggestion ? (
        <Text style={styles.sheetHint}>
          You've suggested "{mySuggestion.answer}". The author will see it next time they look.
        </Text>
      ) : null}

      {/* Author actions: type your own answer OR remove the pin entirely */}
      {isAuthor ? (
        <>
          {!pin.resolved ? (
            <Text style={styles.sheetHint}>
              {suggestions.length
                ? 'Or type your own answer below.'
                : 'When you know the answer, type it here to tag the photo for everyone.'}
            </Text>
          ) : null}
          <TextInput
            value={answer}
            onChangeText={setAnswer}
            placeholder="Answer (e.g. 'My grandfather, John Anderson')"
            placeholderTextColor={colors.textLight}
            style={styles.input}
            multiline
          />
          <View style={styles.sheetActions}>
            <TouchableOpacity onPress={onDelete} style={styles.actionBtnDanger}>
              <FontAwesome5 name="trash" size={11} color="#fff" />
              <Text style={styles.actionBtnText}>Remove pin</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onResolve(answer.trim())}
              disabled={!answer.trim()}
              style={[styles.actionBtn, !answer.trim() && { opacity: 0.5 }]}
            >
              <Text style={styles.actionBtnText}>{pin.resolved ? 'Update tag' : 'Tag photo'}</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.screenBackground },
  centerFill: { alignItems: 'center', justifyContent: 'center' },
  scroll: { paddingBottom: spacing.xxl },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  iconBtn: {
    width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18,
  },
  eyebrow: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  title: {
    fontSize: fontSize.xl,
    fontWeight: '900',
    color: colors.textPrimary,
    marginTop: 2,
  },

  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
  },
  avatar: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarSm: {
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  authorName: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  authorMeta: { fontSize: 11, color: colors.textMuted },

  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  tagChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  tagChipText: {
    fontSize: 11,
    fontWeight: '700',
  },

  body: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
    fontSize: fontSize.md,
    color: colors.textPrimary,
    lineHeight: 22,
  },
  bodyText: { color: colors.textSecondary },

  mediaSection: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
    gap: spacing.md,
  },
  mediaTile: {
    gap: spacing.xs,
  },
  caption: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
  videoFrame: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  videoPlay: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  audioTile: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: colors.white,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  audioTitle: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  audioMeta:  { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  transcript: {
    marginTop: spacing.xs,
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    fontStyle: 'italic',
    lineHeight: 19,
  },

  reactionsRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
    flexWrap: 'wrap',
  },
  reactionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.white,
  },
  reactionCount: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textPrimary,
  },

  inlineSheet: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  pinSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  pinHeadMini: {
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  sheetTitle: { flex: 1, fontSize: fontSize.md, fontWeight: '700', color: colors.textPrimary },
  sheetHint:  { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16 },
  sheetSubLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: SECTION.color,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: SECTION.light,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  suggestionAnswer: {
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  suggestionMeta: {
    fontSize: 11,
    color: colors.textMuted,
  },
  acceptBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.success,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  acceptBtnText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
  },
  sheetActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    justifyContent: 'flex-end',
    marginTop: spacing.xs,
  },
  resolvedAnswer: {
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    backgroundColor: colors.successLight,
    padding: spacing.sm,
    borderRadius: radius.sm,
    lineHeight: 19,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.md,
    color: colors.textPrimary,
    backgroundColor: colors.offWhite,
    minHeight: 44,
  },
  actionBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: SECTION.color,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  actionBtnText: { color: '#fff', fontWeight: '700', fontSize: fontSize.sm },
  actionBtnGhost: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  actionBtnGhostText: { color: colors.textMuted, fontWeight: '600' },
  actionBtnDanger: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.error,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },

  threadCallout: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    padding: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  addChildBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  addChildText: {
    fontWeight: '800',
    fontSize: fontSize.sm,
  },
  threadHint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 16,
  },

  children: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
    gap: spacing.xs,
  },
  sectionTitle: {
    fontSize: fontSize.md,
    fontWeight: '800',
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  },
  childCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radius.md,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  childTitle: { fontSize: fontSize.sm, fontWeight: '600', color: colors.textPrimary },
  childMeta:  { fontSize: 11, color: colors.textMuted },

  commentsBlock: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  commentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  commentAuthor: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textPrimary },
  commentBody:   { fontSize: fontSize.sm, color: colors.textPrimary, marginTop: 2, lineHeight: 19 },
  pinReplyChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    marginTop: 2,
  },
  pinReplyChipText: { fontSize: 9, fontWeight: '700' },
  emptyHint: { fontSize: fontSize.sm, color: colors.textMuted, fontStyle: 'italic' },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
});
