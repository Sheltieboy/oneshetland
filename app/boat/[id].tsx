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
import { colors, fontSize, spacing, radius, SIDEBAR_WIDTH } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { NavRail } from '@/components/NavRail';
import { HeroBackPill } from '@/components/ui/HeroBackPill';
import { Sheet } from '@/components/ui/Sheet';
import {
  fetchVesselProfile, fetchVesselTimeline,
  fetchVesselComments, threadComments,
  addVesselComment, editVesselComment, deleteVesselComment,
  VesselProfile, VesselTimelineEntry, VesselComment, Confidence,
  CommentSubject, COMMENT_SUBJECTS, commentSubjectLabel,
  vesselDisplayTitle, hullMaterialLabel, eventTypeLabel, confidenceLabel,
  fetchVesselEditState, proposeVesselEdit, voteVesselEdit,
  buildEditSummary, CONFIRM_THRESHOLD,
  VesselEditProposal, MyEditVotes, EditAction, EditTable, EditValueType,
} from '@/lib/boats-api';
import { PickedFile } from '@/lib/image-upload';
import DisplayText from '@/components/DisplayText';
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

const VOTE_GREEN = '#16A34A';

/**
 * A single editable element on the screen. `table`/`rowId`/`column` describe the
 * fact being changed; `actions` is which of correct/add/remove make sense here.
 * `removeTable`/`removeRowId` let an owner row (whose name lives in `owners`) be
 * removed via its `ownership_periods` row.
 */
interface EditTarget {
  table:           EditTable;
  rowId:           string | null;
  column:          string | null;
  label:           string;
  valueType:       EditValueType;
  currentValue:    string | null;
  actions:         EditAction[];
  addPayloadField?: string;
  removeTable?:    EditTable;
  removeRowId?:    string | null;
}

// ── Duplicate-row collapsing ────────────────────────────────────────────────
// The register often holds the same fact several times over (e.g. one name
// seen in many sources). We show the best-sourced copy and tuck the identical
// duplicates behind a "show duplicates" toggle — the data is all still there.

const CONF_RANK: Record<Confidence, number> = {
  confirmed: 4, probable: 3, possible: 2, unmatched: 1, conflict: 0,
};

const normKey = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

interface Grouped<T> { key: string; rep: T; others: T[] }

/**
 * Groups identical rows by `keyOf`, ordering groups by first appearance and
 * choosing the highest-`rankOf` member of each group as the one to show.
 */
function dedupeRows<T>(items: T[], keyOf: (x: T) => string, rankOf: (x: T) => number): Grouped<T>[] {
  const map = new Map<string, T[]>();
  const order: string[] = [];
  for (const it of items) {
    const k = keyOf(it);
    if (!map.has(k)) { map.set(k, []); order.push(k); }
    map.get(k)!.push(it);
  }
  return order.map(k => {
    const arr = map.get(k)!.slice().sort((a, b) => rankOf(b) - rankOf(a));
    return { key: k, rep: arr[0], others: arr.slice(1) };
  });
}

/** Open proposals that belong to a given target (used for the pending pills). */
function openForTarget(all: VesselEditProposal[], t: EditTarget): VesselEditProposal[] {
  return all.filter(p => {
    if (p.status !== 'open') return false;
    if (p.action === 'remove') {
      const tbl = t.removeTable ?? t.table;
      const rid = t.removeRowId ?? t.rowId;
      return t.actions.includes('remove') && p.target_table === tbl && p.target_row_id === rid;
    }
    if (p.action === 'add') {
      return t.actions.includes('add') && t.rowId === null && t.column === null
        && p.target_table === t.table;
    }
    return t.actions.includes('edit') && p.target_table === t.table
      && p.target_row_id === t.rowId
      && (t.column ? p.target_column === t.column : p.target_column === null);
  });
}

export default function BoatProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { profile: viewer } = useAuth();
  const { isTablet } = useAppLayout();

  const [profile, setProfile]       = useState<VesselProfile | null>(null);
  const [timeline, setTimeline]     = useState<VesselTimelineEntry[]>([]);
  const [comments, setComments]     = useState<VesselComment[]>([]);
  const [loading, setLoading]       = useState(true);
  const [saved, setSaved]           = useState(false);
  const [showEvidence, setShowEv]   = useState(false);

  // Community corrections
  const [proposals, setProposals]   = useState<VesselEditProposal[]>([]);
  const [myVotes, setMyVotes]       = useState<MyEditVotes>({});
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [editMode, setEditMode]     = useState(false);

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
      const [p, t, isSaved, c, edits] = await Promise.all([
        fetchVesselProfile(id),
        fetchVesselTimeline(id),
        isBoatSaved(id),
        fetchVesselComments(id),
        fetchVesselEditState(id, viewer?.id ?? null),
      ]);
      setProfile(p);
      setTimeline(t);
      setSaved(isSaved);
      setComments(c);
      setProposals(edits.proposals);
      setMyVotes(edits.myVotes);

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
  }, [id, viewer?.id]);

  useEffect(() => { void load(); }, [load]);

  // ── Community corrections ─────────────────────────────────────────────────
  const refreshEdits = useCallback(async () => {
    if (!id) return;
    try {
      const { proposals: ps, myVotes: mv } = await fetchVesselEditState(id, viewer?.id ?? null);
      setProposals(ps);
      setMyVotes(mv);
    } catch { /* swallow */ }
  }, [id, viewer?.id]);

  const handleVote = useCallback(async (proposalId: string, vote: 'confirm' | 'dispute') => {
    if (!viewer?.id) { router.push('/(auth)/sign-in'); return; }
    try {
      const res = await voteVesselEdit(proposalId, vote);
      if (res.applied) {
        setEditTarget(null);
        await load();
        Alert.alert('Updated', 'Enough folk agreed — the boat’s details have been updated.');
      } else {
        await refreshEdits();
      }
    } catch (err: any) {
      Alert.alert('Could not record your vote', err?.message ?? '');
    }
  }, [viewer?.id, router, load, refreshEdits]);

  const handlePropose = useCallback(async (
    args: { action: EditAction; value: string; note: string },
  ): Promise<boolean> => {
    if (!viewer?.id) { setEditTarget(null); router.push('/(auth)/sign-in'); return false; }
    const t = editTarget;
    if (!t || !profile) return false;

    const summary = buildEditSummary({
      action: args.action, label: t.label, value: args.value, currentValue: t.currentValue,
    });
    let payload: Record<string, any> = {};
    if (args.action === 'edit')      payload = { value: args.value };
    else if (args.action === 'add')  payload = { [t.addPayloadField ?? 'value']: args.value };

    try {
      await proposeVesselEdit({
        vesselId:     profile.vessel.id,
        userId:       viewer.id,
        table:        args.action === 'remove' ? (t.removeTable ?? t.table) : t.table,
        rowId:        args.action === 'add'
                        ? null
                        : args.action === 'remove' ? (t.removeRowId ?? t.rowId) : t.rowId,
        column:       args.action === 'edit' ? t.column : null,
        action:       args.action,
        payload,
        currentValue: t.currentValue,
        summary,
        note:         args.note || null,
      });
      await refreshEdits();
      return true;
    } catch (err: any) {
      Alert.alert('Could not send your suggestion', err?.message ?? '');
      return false;
    }
  }, [viewer?.id, router, editTarget, profile, refreshEdits]);

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

  // Vessel-level edit targets (the header fields)
  const nameTarget: EditTarget = {
    table: 'vessels', rowId: null, column: 'canonical_name', label: 'Name',
    valueType: 'text', currentValue: vessel.canonical_name, actions: ['edit'],
  };
  const lkTarget: EditTarget = {
    table: 'vessels', rowId: null, column: 'primary_lk_number', label: 'LK number',
    valueType: 'text', currentValue: vessel.primary_lk_number, actions: ['edit'],
  };
  const builtTarget: EditTarget = {
    table: 'vessels', rowId: null, column: 'built_year', label: 'Built year',
    valueType: 'year', currentValue: vessel.built_year ? String(vessel.built_year) : null, actions: ['edit'],
  };
  const builderTarget: EditTarget = {
    table: 'vessels', rowId: null, column: 'builder', label: 'Builder',
    valueType: 'text', currentValue: vessel.builder, actions: ['edit'],
  };

  const openCount = proposals.filter(p => p.status === 'open').length;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <NavRail />
      <View style={{ flex: 1, paddingLeft: isTablet ? SIDEBAR_WIDTH : 0 }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* Top bar — anchored in the Da Boats section */}
        <View style={styles.topBar}>
          <HeroBackPill
            variant="tint"
            accent={SECTION.color}
            icon="ship"
            label="Da Boats"
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/da-boats'))}
          />
          <View style={{ flex: 1 }} />
          <TouchableOpacity
            onPress={() => setEditMode(m => !m)}
            style={[styles.editPill, editMode && { backgroundColor: SECTION.color, borderColor: SECTION.color }]}
            hitSlop={8}
            activeOpacity={0.85}
          >
            <FontAwesome5
              name={editMode ? 'check' : 'pencil-alt'}
              size={12}
              color={editMode ? '#fff' : SECTION.color}
              solid
            />
            <Text style={[styles.editPillText, { color: editMode ? '#fff' : SECTION.color }]}>
              {editMode ? 'Done' : 'Edit'}
            </Text>
            {!editMode && openCount > 0 ? (
              <View style={styles.editBadge}>
                <Text style={styles.editBadgeText}>{openCount}</Text>
              </View>
            ) : null}
          </TouchableOpacity>
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

        {/* Edit-mode helper banner */}
        {editMode ? (
          <View style={[styles.editHelp, { backgroundColor: SECTION.light }]}>
            <FontAwesome5 name="pencil-alt" size={12} color={SECTION.color} solid />
            <Text style={[styles.editHelpText, { color: SECTION.color }]}>
              Tap a pencil to suggest a change. Changes go live once {CONFIRM_THRESHOLD} people agree.
            </Text>
          </View>
        ) : null}

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
          <View style={styles.lkRow}>
            <Text style={[styles.lk, { color: SECTION.color }]}>
              {vessel.primary_lk_number ?? 'No LK number on file'}
            </Text>
            {editMode ? <SuggestPencil onPress={() => setEditTarget(lkTarget)} active={openForTarget(proposals, lkTarget).length > 0} /> : null}
          </View>
          <View style={styles.titleRow}>
            <DisplayText weight="black" style={[styles.title, { flexShrink: 1 }]}>{vessel.canonical_name}</DisplayText>
            {editMode ? <SuggestPencil onPress={() => setEditTarget(nameTarget)} active={openForTarget(proposals, nameTarget).length > 0} /> : null}
          </View>
          {(vessel.built_year || hull || vessel.builder) ? (
            <View style={styles.subtitleRow}>
              <FactChip
                text={vessel.built_year ? `Built ${vessel.built_year}` : 'Year unknown'}
                onSuggest={editMode ? () => setEditTarget(builtTarget) : undefined}
                active={openForTarget(proposals, builtTarget).length > 0}
              />
              {hull ? <Text style={styles.subtitleDot}>·</Text> : null}
              {hull ? <FactChip text={`${hull} hull`} /> : null}
              {vessel.builder ? <Text style={styles.subtitleDot}>·</Text> : null}
              {vessel.builder ? (
                <FactChip
                  text={vessel.builder}
                  onSuggest={editMode ? () => setEditTarget(builderTarget) : undefined}
                  active={openForTarget(proposals, builderTarget).length > 0}
                />
              ) : null}
            </View>
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
        {names.length ? (() => {
          const groups = dedupeRows(
            names,
            n => `${normKey(n.normalised_name || n.name)}|${n.start_year ?? ''}|${n.end_year ?? ''}|${normKey(n.date_text)}`,
            n => CONF_RANK[n.confidence] * 1_000_000 + (n.is_primary ? 100_000 : 0) + (n.source_record_id ? 1_000 : 0),
          );
          const renderName = (n: (typeof names)[number], dup: boolean) => {
            const t: EditTarget = {
              table: 'vessel_names', rowId: n.id, column: 'name',
              label: `Name “${n.name}”`, valueType: 'text', currentValue: n.name,
              actions: ['edit', 'remove'],
            };
            return (
              <BigRow
                key={n.id}
                primary={n.name}
                secondary={fmtYears(n.start_year, n.end_year, n.date_text)}
                badge={!dup && n.is_primary ? 'main name' : undefined}
                confidence={n.confidence}
                onSuggest={editMode ? () => setEditTarget(t) : undefined}
                pending={openForTarget(proposals, t).length}
              />
            );
          };
          return (
            <Section title="Names she went by" subtitle={groups.length === 1 ? '' : `${groups.length} known`}>
              {groups.map(g => (
                <DedupGroup key={g.key} rep={renderName(g.rep, false)} others={g.others.map(o => renderName(o, true))} />
              ))}
              {editMode ? (() => {
                const addT: EditTarget = {
                  table: 'vessel_names', rowId: null, column: null, label: 'a name she went by',
                  valueType: 'text', currentValue: null, actions: ['add'], addPayloadField: 'name',
                };
                return <AddSuggestRow label="a name she went by" onPress={() => setEditTarget(addT)} pending={openForTarget(proposals, addT).length} />;
              })() : null}
            </Section>
          );
        })() : null}

        {/* Numbers she carried */}
        {registrations.length ? (() => {
          const groups = dedupeRows(
            registrations,
            r => `${normKey(r.registration)}|${r.start_year ?? ''}|${r.end_year ?? ''}|${normKey(r.date_text)}`,
            r => CONF_RANK[r.confidence] * 1_000_000 + (r.is_primary ? 100_000 : 0) + (r.source_record_id ? 1_000 : 0),
          );
          const renderReg = (r: (typeof registrations)[number], dup: boolean) => {
            const t: EditTarget = {
              table: 'registrations', rowId: r.id, column: 'registration',
              label: `Number “${r.registration}”`, valueType: 'text', currentValue: r.registration,
              actions: ['edit', 'remove'],
            };
            return (
              <BigRow
                key={r.id}
                primary={r.registration}
                secondary={fmtYears(r.start_year, r.end_year, r.date_text)}
                pillColor={SECTION.color}
                badge={!dup && r.is_primary ? 'main number' : undefined}
                confidence={r.confidence}
                onSuggest={editMode ? () => setEditTarget(t) : undefined}
                pending={openForTarget(proposals, t).length}
              />
            );
          };
          return (
            <Section title="Numbers she carried" subtitle={groups.length === 1 ? '' : `${groups.length} known`}>
              {groups.map(g => (
                <DedupGroup key={g.key} rep={renderReg(g.rep, false)} others={g.others.map(o => renderReg(o, true))} />
              ))}
              {editMode ? (() => {
                const addT: EditTarget = {
                  table: 'registrations', rowId: null, column: null, label: 'a number she carried',
                  valueType: 'text', currentValue: null, actions: ['add'], addPayloadField: 'registration',
                };
                return <AddSuggestRow label="a number she carried" onPress={() => setEditTarget(addT)} pending={openForTarget(proposals, addT).length} />;
              })() : null}
            </Section>
          );
        })() : null}

        {/* Owners through the years */}
        {ownerships.length ? (() => {
          const groups = dedupeRows(
            ownerships,
            o => `${normKey(o.owner?.name)}|${o.start_year ?? ''}|${o.end_year ?? ''}|${normKey(o.date_text)}`,
            o => CONF_RANK[o.confidence] * 1_000_000 + (o.source_record_id ? 1_000 : 0),
          );
          const renderOwner = (o: (typeof ownerships)[number]) => {
            const t: EditTarget = o.owner?.id ? {
              table: 'owners', rowId: o.owner.id, column: 'name',
              label: `Owner “${o.owner.name}”`, valueType: 'text', currentValue: o.owner.name,
              actions: ['edit', 'remove'], removeTable: 'ownership_periods', removeRowId: o.id,
            } : {
              table: 'ownership_periods', rowId: o.id, column: null,
              label: 'this owner entry', valueType: 'text', currentValue: null, actions: ['remove'],
            };
            return (
              <BigRow
                key={o.id}
                primary={o.owner?.name ?? 'Unknown owner'}
                secondary={fmtYears(o.start_year, o.end_year, o.date_text) || (o.notes ?? '')}
                confidence={o.confidence}
                onSuggest={editMode ? () => setEditTarget(t) : undefined}
                pending={openForTarget(proposals, t).length}
              />
            );
          };
          return (
            <Section title="Owners through the years">
              {groups.map(g => (
                <DedupGroup key={g.key} rep={renderOwner(g.rep)} others={g.others.map(o => renderOwner(o))} />
              ))}
              {editMode ? (() => {
                const addT: EditTarget = {
                  table: 'ownership_periods', rowId: null, column: null, label: 'a previous owner',
                  valueType: 'text', currentValue: null, actions: ['add'], addPayloadField: 'owner',
                };
                return <AddSuggestRow label="a previous owner" onPress={() => setEditTarget(addT)} pending={openForTarget(proposals, addT).length} />;
              })() : null}
            </Section>
          );
        })() : null}

        {/* Her size */}
        {measurements.length ? (() => {
          const measureText = (m: (typeof measurements)[number]) => {
            const bits: string[] = [];
            if (m.length_m)        bits.push(`${Number(m.length_m).toFixed(1)} m long`);
            if (m.tonnage_text)    bits.push(m.tonnage_text);
            else if (m.tonnage)    bits.push(`${m.tonnage} tons`);
            if (m.engine_power_kw) bits.push(`${m.engine_power_kw} kW`);
            return bits.join('  ·  ') || 'Measurement on record';
          };
          const groups = dedupeRows(
            measurements,
            m => `${normKey(measureText(m))}|${m.measurement_year ?? ''}`,
            m => (m.source_record_id ? 1_000 : 0) + (m.measurement_year ?? 0),
          );
          const renderMeasure = (m: (typeof measurements)[number]) => {
            const primaryVal = measureText(m);
            const t: EditTarget = {
              table: 'measurements', rowId: m.id, column: null,
              label: 'this measurement', valueType: 'text', currentValue: primaryVal,
              actions: ['remove'],
            };
            return (
              <BigRow
                key={m.id}
                primary={primaryVal}
                secondary={[m.measurement_year, m.notes].filter(Boolean).join(' · ')}
                onSuggest={editMode ? () => setEditTarget(t) : undefined}
                pending={openForTarget(proposals, t).length}
              />
            );
          };
          return (
            <Section title="Her size">
              {groups.map(g => (
                <DedupGroup key={g.key} rep={renderMeasure(g.rep)} others={g.others.map(o => renderMeasure(o))} />
              ))}
            </Section>
          );
        })() : null}

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
      </View>

      {editTarget ? (
        <SuggestModal
          target={editTarget}
          proposals={openForTarget(proposals, editTarget)}
          myVotes={myVotes}
          viewerId={viewer?.id ?? null}
          onClose={() => setEditTarget(null)}
          onVote={handleVote}
          onPropose={handlePropose}
        />
      ) : null}
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
  primary, secondary, badge, pillColor, confidence, onSuggest, pending = 0,
}: {
  primary: string;
  secondary?: string;
  badge?: string;
  pillColor?: string;
  confidence?: Confidence;
  onSuggest?: () => void;
  pending?: number;
}) {
  return (
    <View style={styles.bigRowWrap}>
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
        {onSuggest ? <SuggestPencil onPress={onSuggest} active={pending > 0} /> : null}
      </View>
      {onSuggest && pending > 0 ? <PendingPill count={pending} onPress={onSuggest} /> : null}
    </View>
  );
}

/** Faint pencil affordance — turns the section colour when a change is pending. */
function SuggestPencil({ onPress, active }: { onPress: () => void; active?: boolean }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      hitSlop={12}
      style={styles.pencilBtn}
      accessibilityLabel="Suggest a change"
    >
      <FontAwesome5
        name="pencil-alt"
        size={12}
        color={active ? SECTION.color : colors.textMuted}
        style={{ opacity: active ? 1 : 0.45 }}
      />
    </TouchableOpacity>
  );
}

/** Quiet "N changes suggested · tap to review" pill under a row. */
function PendingPill({ count, onPress }: { count: number; onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.pendingPill, { backgroundColor: SECTION.light }]}
      activeOpacity={0.8}
    >
      <FontAwesome5 name="users" size={10} color={SECTION.color} solid />
      <Text style={[styles.pendingPillText, { color: SECTION.color }]}>
        {count === 1 ? '1 change suggested' : `${count} changes suggested`} · tap to review
      </Text>
    </TouchableOpacity>
  );
}

/** A section-level "suggest something missing" link (drives an 'add' target). */
function AddSuggestRow({ label, onPress, pending }: { label: string; onPress: () => void; pending: number }) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.addRow} activeOpacity={0.7}>
      <FontAwesome5 name="plus" size={11} color={SECTION.color} />
      <Text style={[styles.addRowText, { color: SECTION.color }]}>
        Suggest {label}{pending > 0 ? `  ·  ${pending} pending` : ''}
      </Text>
    </TouchableOpacity>
  );
}

/** Header fact (built year / builder) rendered with its own faint pencil. */
function FactChip({ text, onSuggest, active }: { text: string; onSuggest?: () => void; active?: boolean }) {
  return (
    <View style={styles.factChip}>
      <Text style={styles.subtitle}>{text}</Text>
      {onSuggest ? <SuggestPencil onPress={onSuggest} active={active} /> : null}
    </View>
  );
}

/**
 * Shows the representative row, with a quiet toggle to reveal identical
 * duplicates beneath it (kept dimmed + indented so the screen stays clean).
 */
function DedupGroup({ rep, others }: { rep: React.ReactNode; others: React.ReactNode[] }) {
  const [open, setOpen] = useState(false);
  if (others.length === 0) return <>{rep}</>;
  return (
    <View>
      {rep}
      <TouchableOpacity onPress={() => setOpen(o => !o)} style={styles.dupToggle} activeOpacity={0.7}>
        <FontAwesome5 name={open ? 'chevron-up' : 'layer-group'} size={11} color={SECTION.color} solid />
        <Text style={[styles.dupToggleText, { color: SECTION.color }]}>
          {open ? 'Hide duplicates' : `Show ${others.length} duplicate${others.length === 1 ? '' : 's'}`}
        </Text>
      </TouchableOpacity>
      {open ? <View style={styles.dupWrap}>{others}</View> : null}
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

// ── Suggest / review change sheet ───────────────────────────────────────────

function SuggestModal({
  target, proposals, myVotes, viewerId, onClose, onVote, onPropose,
}: {
  target: EditTarget;
  proposals: VesselEditProposal[];
  myVotes: MyEditVotes;
  viewerId: string | null;
  onClose: () => void;
  onVote: (proposalId: string, vote: 'confirm' | 'dispute') => void;
  onPropose: (args: { action: EditAction; value: string; note: string }) => Promise<boolean>;
}) {
  const defaultAction: EditAction = target.actions.includes('edit') ? 'edit' : target.actions[0];
  const [action, setAction] = useState<EditAction>(defaultAction);
  const [value, setValue]   = useState(
    defaultAction === 'edit' && target.currentValue ? target.currentValue : '',
  );
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const keyboard = (target.valueType === 'year' || target.valueType === 'number')
    ? 'number-pad' : 'default';
  const needsValue = action !== 'remove';
  const isValid = needsValue ? value.trim().length > 0 : true;

  const onChangeAction = (a: EditAction) => {
    setAction(a);
    if (a === 'edit' && target.currentValue) setValue(target.currentValue);
    else if (a !== 'remove') setValue('');
  };

  const submit = async () => {
    if (busy || !isValid) return;
    setBusy(true);
    const ok = await onPropose({ action, value: value.trim(), note: note.trim() });
    setBusy(false);
    if (ok) {
      setNote('');
      if (action !== 'edit') setValue('');
    }
  };

  const actionLabel: Record<EditAction, string> = {
    edit: 'Correct it', add: 'Add it', remove: 'Remove it',
  };

  return (
    <Sheet visible onClose={onClose} title={target.label} maxHeightPct={0.88}>
      <Text style={styles.modalCurrent}>
        {target.currentValue ? `Currently: ${target.currentValue}` : 'Not recorded yet'}
      </Text>

      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: spacing.lg }} style={{ flexShrink: 1 }}>
            {proposals.length > 0 ? (
              <View style={styles.modalSection}>
                <Text style={styles.modalSectionTitle}>Suggestions so far</Text>
                <Text style={styles.modalHint}>
                  {CONFIRM_THRESHOLD} people need to agree before a change goes live.
                </Text>
                {proposals.map(p => (
                  <ProposalCard
                    key={p.id}
                    p={p}
                    mine={myVotes[p.id] ?? null}
                    isProposer={!!viewerId && p.proposed_by === viewerId}
                    onVote={onVote}
                  />
                ))}
              </View>
            ) : null}

            <View style={styles.modalSection}>
              <Text style={styles.modalSectionTitle}>
                {proposals.length > 0 ? 'Suggest a different change' : 'Suggest a change'}
              </Text>

              {target.actions.length > 1 ? (
                <View style={styles.actionChipRow}>
                  {target.actions.map(a => {
                    const on = action === a;
                    return (
                      <TouchableOpacity
                        key={a}
                        onPress={() => onChangeAction(a)}
                        style={[styles.actionChip, on && { backgroundColor: SECTION.color, borderColor: SECTION.color }]}
                      >
                        <Text style={[styles.actionChipText, on && { color: '#fff' }]}>{actionLabel[a]}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              ) : null}

              {needsValue ? (
                <TextInput
                  value={value}
                  onChangeText={setValue}
                  placeholder={action === 'add' ? `New ${target.label.toLowerCase()}…` : 'Corrected value…'}
                  placeholderTextColor={colors.textMuted}
                  keyboardType={keyboard as any}
                  style={styles.valueInput}
                />
              ) : (
                <Text style={styles.removeNote}>
                  You’re suggesting this is removed because it doesn’t belong to this boat.
                </Text>
              )}

              <TextInput
                value={note}
                onChangeText={setNote}
                placeholder="Add a note (optional) — how do you know?"
                placeholderTextColor={colors.textMuted}
                style={styles.noteInput}
                multiline
              />

              <TouchableOpacity
                onPress={submit}
                disabled={busy || !isValid}
                style={[styles.submitBtn, { backgroundColor: SECTION.color, opacity: (busy || !isValid) ? 0.45 : 1 }]}
              >
                {busy ? <ActivityIndicator color="#fff" /> : (
                  <>
                    <FontAwesome5 name="paper-plane" size={13} color="#fff" />
                    <Text style={styles.submitBtnText}>Send suggestion</Text>
                  </>
                )}
              </TouchableOpacity>
              <Text style={styles.modalFinePrint}>
                Suggestions are settled by the community — others confirm or correct them, and you can’t vote on your own.
              </Text>
            </View>
          </ScrollView>
    </Sheet>
  );
}

function ProposalCard({
  p, mine, isProposer, onVote,
}: {
  p: VesselEditProposal;
  mine: 'confirm' | 'dispute' | null;
  isProposer: boolean;
  onVote: (proposalId: string, vote: 'confirm' | 'dispute') => void;
}) {
  const remaining = Math.max(0, CONFIRM_THRESHOLD - p.confirm_count);
  return (
    <View style={styles.proposalCard}>
      <Text style={styles.proposalSummary}>{p.summary}</Text>
      {p.note ? <Text style={styles.proposalNote}>“{p.note}”</Text> : null}
      <Text style={styles.proposalMeta}>
        {p.confirm_count} of {CONFIRM_THRESHOLD} confirmed
        {p.dispute_count > 0 ? `  ·  ${p.dispute_count} disagree` : ''}
      </Text>

      {isProposer ? (
        <Text style={styles.proposalMine}>
          Your suggestion — waiting for {remaining} more {remaining === 1 ? 'person' : 'people'} to agree.
        </Text>
      ) : (
        <View style={styles.voteRow}>
          <TouchableOpacity
            onPress={() => onVote(p.id, 'confirm')}
            style={[styles.voteBtn, mine === 'confirm' && { backgroundColor: VOTE_GREEN, borderColor: VOTE_GREEN }]}
            activeOpacity={0.85}
          >
            <FontAwesome5 name="check" size={12} color={mine === 'confirm' ? '#fff' : VOTE_GREEN} />
            <Text style={[styles.voteBtnText, { color: mine === 'confirm' ? '#fff' : VOTE_GREEN }]}>
              Yes, that’s right
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => onVote(p.id, 'dispute')}
            style={[styles.voteBtn, mine === 'dispute' && { backgroundColor: colors.error, borderColor: colors.error }]}
            activeOpacity={0.85}
          >
            <FontAwesome5 name="times" size={12} color={mine === 'dispute' ? '#fff' : colors.error} />
            <Text style={[styles.voteBtnText, { color: mine === 'dispute' ? '#fff' : colors.error }]}>
              No, that’s wrong
            </Text>
          </TouchableOpacity>
        </View>
      )}
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
  backToBoats: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingVertical: 8, paddingHorizontal: 12,
    borderRadius: radius.full, backgroundColor: SECTION.color + '14',
  },
  backToBoatsText: { color: SECTION.color, fontSize: fontSize.sm, fontWeight: '800' },

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

  bigRowWrap: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingBottom: 6,
  },
  bigRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: spacing.sm,
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

  // ── Community corrections ───────────────────────────────────────────────────
  editPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999,
    borderWidth: 1.5, borderColor: SECTION.color, backgroundColor: SECTION.color + '14',
  },
  editPillText: { fontSize: 13, fontWeight: '800' },
  editBadge: {
    minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
    backgroundColor: SECTION.color, alignItems: 'center', justifyContent: 'center', marginLeft: 2,
  },
  editBadgeText: { color: '#fff', fontSize: 11, fontWeight: '900' },
  editHelp: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: spacing.lg, marginTop: spacing.sm,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md,
  },
  editHelpText: { flex: 1, fontSize: 13, fontWeight: '700', lineHeight: 18 },

  dupToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingVertical: 8, alignSelf: 'flex-start',
  },
  dupToggleText: { fontSize: 13, fontWeight: '800' },
  dupWrap: {
    borderLeftWidth: 2, borderLeftColor: colors.border,
    paddingLeft: spacing.sm, marginLeft: 2, marginBottom: 4, opacity: 0.7,
  },

  lkRow:    { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginTop: 4 },
  subtitleDot: { fontSize: 17, color: colors.textMuted, marginHorizontal: 6 },
  factChip: { flexDirection: 'row', alignItems: 'center', gap: 5 },

  pencilBtn: {
    paddingHorizontal: 4, paddingVertical: 2,
    alignItems: 'center', justifyContent: 'center',
  },

  pendingPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 999, marginBottom: 8,
  },
  pendingPillText: { fontSize: 12, fontWeight: '800' },

  addRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 10, marginTop: 2,
  },
  addRowText: { fontSize: 14, fontWeight: '800' },

  // Modal
  modalCurrent: { fontSize: 14, color: colors.textSecondary, marginTop: 2, marginBottom: spacing.sm },

  modalSection: {
    backgroundColor: colors.white,
    borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, marginTop: spacing.sm, gap: spacing.sm,
  },
  modalSectionTitle: { fontSize: 16, fontWeight: '900', color: colors.textPrimary },
  modalHint: { fontSize: 13, color: colors.textMuted, marginTop: -4 },
  modalFinePrint: { fontSize: 12, color: colors.textMuted, lineHeight: 17, marginTop: 2 },

  proposalCard: {
    backgroundColor: colors.offWhite,
    borderRadius: radius.md, padding: spacing.md, gap: 6,
  },
  proposalSummary: { fontSize: 15, fontWeight: '800', color: colors.textPrimary, lineHeight: 21 },
  proposalNote: { fontSize: 14, color: colors.textSecondary, fontStyle: 'italic', lineHeight: 19 },
  proposalMeta: { fontSize: 13, color: colors.textMuted, fontWeight: '700' },
  proposalMine: { fontSize: 13, color: colors.textSecondary, fontWeight: '600', marginTop: 2 },

  voteRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  voteBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, borderRadius: 999,
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.white,
  },
  voteBtnText: { fontSize: 13, fontWeight: '800' },

  actionChipRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  actionChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.border,
  },
  actionChipText: { fontSize: 13, fontWeight: '800', color: colors.textSecondary },

  valueInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    fontSize: 16, color: colors.textPrimary, backgroundColor: colors.white,
  },
  noteInput: {
    minHeight: 60, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    fontSize: 15, color: colors.textPrimary, backgroundColor: colors.white,
    textAlignVertical: 'top',
  },
  removeNote: { fontSize: 15, color: colors.textSecondary, lineHeight: 21 },

  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: spacing.md, borderRadius: 999, marginTop: 2,
  },
  submitBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
