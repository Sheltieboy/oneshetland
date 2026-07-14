/**
 * (admin)/spik-suggestions.tsx
 *
 * Review incoming Spik dictionary suggestions.
 * Copy values to paste into WordPress ACF, then mark as reviewed.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Share,
  RefreshControl,
} from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { colors, fontSize, radius, spacing, shadow, contentContainer } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAlert } from '@/components/BrandedAlert';

type Status = 'pending' | 'reviewed' | 'all';

interface Suggestion {
  id: string;
  word_id: number;
  word: string;
  field_name: string;
  field_label: string;
  current_value: string | null;
  suggested_value: string;
  submitter_name: string | null;
  show_name: boolean;
  status: string;
  created_at: string;
}

interface WordGroup {
  word: string;
  word_id: number;
  suggestions: Suggestion[];
}

function groupByWord(rows: Suggestion[]): WordGroup[] {
  const map: Record<string, WordGroup> = {};
  for (const s of rows) {
    if (!map[s.word]) map[s.word] = { word: s.word, word_id: s.word_id, suggestions: [] };
    map[s.word].suggestions.push(s);
  }
  return Object.values(map).sort((a, b) => a.word.localeCompare(b.word));
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 2)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

// ── Suggestion card ───────────────────────────────────────────────────────────

function SuggestionCard({
  suggestion,
  onMarkReviewed,
  onMarkPending,
  onApprove,
}: {
  suggestion: Suggestion;
  onMarkReviewed: (id: string) => void;
  onMarkPending: (id: string) => void;
  onApprove: (id: string) => Promise<void> | void;
}) {
  const [copying, setCopying] = useState(false);
  const [approving, setApproving] = useState(false);
  const isReviewed = suggestion.status === 'reviewed';
  const isApproved = suggestion.status === 'approved';

  const handleShare = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCopying(true);
    try {
      await Share.share({ message: suggestion.suggested_value });
    } catch { /* dismissed */ }
    finally { setCopying(false); }
  };

  return (
    <View style={[styles.suggCard, isReviewed && styles.suggCardReviewed]}>
      {/* Field label + meta */}
      <View style={styles.suggHeader}>
        <View style={styles.suggFieldBadge}>
          <Text style={styles.suggFieldText}>{suggestion.field_label}</Text>
        </View>
        <Text style={styles.suggMeta}>
          {timeAgo(suggestion.created_at)}
          {suggestion.submitter_name && suggestion.show_name
            ? `  ·  ${suggestion.submitter_name}`
            : suggestion.submitter_name
            ? '  ·  anonymous'
            : ''}
        </Text>
      </View>

      {/* Current value */}
      {suggestion.current_value ? (
        <View style={styles.currentBlock}>
          <Text style={styles.blockLabel}>CURRENT</Text>
          <Text style={styles.currentText} selectable>{suggestion.current_value}</Text>
        </View>
      ) : (
        <View style={styles.currentBlock}>
          <Text style={styles.blockLabel}>CURRENT</Text>
          <Text style={styles.emptyText}>Not set</Text>
        </View>
      )}

      {/* Suggested value — selectable + share */}
      <View style={[styles.suggestedBlock, isReviewed && styles.suggestedBlockReviewed]}>
        <View style={styles.suggestedTop}>
          <Text style={styles.blockLabel}>SUGGESTED</Text>
          <TouchableOpacity
            style={styles.shareBtn}
            onPress={handleShare}
            hitSlop={8}
          >
            {copying
              ? <ActivityIndicator size="small" color={colors.accent} />
              : <>
                  <FontAwesome5 name="copy" size={11} color={colors.accent} />
                  <Text style={styles.shareBtnText}>Copy</Text>
                </>
            }
          </TouchableOpacity>
        </View>
        <Text style={styles.suggestedText} selectable>{suggestion.suggested_value}</Text>
      </View>

      {/* Actions */}
      {isApproved ? (
        <View style={styles.publishedPill}>
          <FontAwesome5 name="check-circle" size={11} color="#059669" />
          <Text style={styles.publishedPillText}>Published to the live word</Text>
        </View>
      ) : (
        <>
          {!isReviewed && !!suggestion.word_id && (
            <TouchableOpacity
              style={styles.approveBtn}
              disabled={approving}
              onPress={async () => { setApproving(true); try { await onApprove(suggestion.id); } finally { setApproving(false); } }}
            >
              {approving
                ? <ActivityIndicator size="small" color="#fff" />
                : <>
                    <FontAwesome5 name="check-circle" size={11} color="#fff" />
                    <Text style={styles.approveBtnText}>Approve &amp; publish</Text>
                  </>}
            </TouchableOpacity>
          )}
      {isReviewed ? (
        <TouchableOpacity
          style={styles.undoBtn}
          onPress={() => onMarkPending(suggestion.id)}
        >
          <FontAwesome5 name="undo" size={11} color={colors.textMuted} />
          <Text style={styles.undoBtnText}>Mark as pending again</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={styles.reviewedBtn}
          onPress={() => onMarkReviewed(suggestion.id)}
        >
          <FontAwesome5 name="check" size={11} color="#fff" />
          <Text style={styles.reviewedBtnText}>Mark as reviewed</Text>
        </TouchableOpacity>
      )}
        </>
      )}
    </View>
  );
}

// ── Word group ────────────────────────────────────────────────────────────────

function WordGroupBlock({
  group,
  onMarkReviewed,
  onMarkPending,
  onApprove,
}: {
  group: WordGroup;
  onMarkReviewed: (id: string) => void;
  onMarkPending: (id: string) => void;
  onApprove: (id: string) => Promise<void> | void;
}) {
  const pendingCount = group.suggestions.filter(s => s.status === 'pending').length;

  return (
    <View style={styles.groupBlock}>
      <View style={styles.groupHeader}>
        <Text style={styles.groupWord}>{group.word}</Text>
        {pendingCount > 0 && (
          <View style={styles.pendingBadge}>
            <Text style={styles.pendingBadgeText}>{pendingCount} pending</Text>
          </View>
        )}
      </View>
      {group.suggestions.map(s => (
        <SuggestionCard
          key={s.id}
          suggestion={s}
          onMarkReviewed={onMarkReviewed}
          onMarkPending={onMarkPending}
          onApprove={onApprove}
        />
      ))}
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function SpikSuggestionsScreen() {
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();
  const [filter, setFilter]       = useState<Status>('pending');
  const [groups, setGroups]       = useState<WordGroup[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [totalPending, setTotalPending] = useState(0);

  const load = useCallback(async (status: Status, isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      let query = supabase
        .from('spik_suggestions')
        .select('*')
        .order('created_at', { ascending: false });

      if (status !== 'all') query = query.eq('status', status);

      const { data, error } = await query;
      if (error) throw error;

      setGroups(groupByWord(data ?? []));

      // Always get pending count for the badge
      const { count } = await supabase
        .from('spik_suggestions')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending');
      setTotalPending(count ?? 0);

    } catch (e) {
      alert({ title: 'Error', message: 'Could not load suggestions' });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(filter); }, [filter, load]);

  const handleMarkReviewed = useCallback(async (id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await supabase
      .from('spik_suggestions')
      .update({ status: 'reviewed', reviewed_at: new Date().toISOString() })
      .eq('id', id);
    load(filter);
  }, [filter, load]);

  const handleMarkPending = useCallback(async (id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await supabase
      .from('spik_suggestions')
      .update({ status: 'pending', reviewed_at: null })
      .eq('id', id);
    load(filter);
  }, [filter, load]);

  // Approve & publish: apply the edit to the live dictionary word + credit the
  // submitter, via the admin-only RPC.
  const handleApprove = useCallback(async (id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const { error } = await supabase.rpc('approve_spik_suggestion', { p_id: id });
    if (error) { alert({ title: 'Could not publish', message: error.message }); return; }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    load(filter);
  }, [filter, load, alert]);

  const FILTERS: { key: Status; label: string }[] = [
    { key: 'pending',  label: `Pending${totalPending > 0 ? ` (${totalPending})` : ''}` },
    { key: 'reviewed', label: 'Reviewed' },
    { key: 'all',      label: 'All' },
  ];

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="Spik Suggestions"
          subtitle="Review · copy · paste into WordPress"
          accent={colors.accent}
          onBack={() => router.back()}
        />
      }
    >
      {/* Filter tabs */}
      <View style={styles.filterRow}>
        {FILTERS.map(f => (
          <TouchableOpacity
            key={f.key}
            style={[styles.filterTab, filter === f.key && styles.filterTabActive]}
            onPress={() => { Haptics.selectionAsync(); setFilter(f.key); }}
          >
            <Text style={[styles.filterTabText, filter === f.key && styles.filterTabTextActive]}>
              {f.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Workflow hint */}
      <View style={styles.workflowHint}>
        <FontAwesome5 name="info-circle" size={11} color={colors.textLight} />
        <Text style={styles.workflowText}>
          Tap <Text style={styles.workflowBold}>Copy</Text> to share the value, paste it into WordPress ACF, then mark as reviewed.
        </Text>
      </View>

      {/* Content */}
      {loading ? (
        <LoadingState accent={colors.accent} />
      ) : groups.length === 0 ? (
        <EmptyState
          icon="check-circle"
          title={filter === 'pending' ? 'No pending suggestions' : 'Nothing here yet'}
          body={filter === 'pending' ? 'All caught up.' : 'Suggestions will appear here once submitted.'}
          accent={colors.accent}
          variant="card"
        />
      ) : (
        <ScrollView
          contentContainerStyle={[styles.listContent, contentContainer(screenWidth)]}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load(filter, true)}
              tintColor={colors.accent}
            />
          }
        >
          {groups.map(g => (
            <WordGroupBlock
              onApprove={handleApprove}
              key={g.word}
              group={g}
              onMarkReviewed={handleMarkReviewed}
              onMarkPending={handleMarkPending}
            />
          ))}
        </ScrollView>
      )}
    </ScreenScaffold>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  filterRow: {
    flexDirection: 'row',
    backgroundColor: colors.white,
    paddingHorizontal: spacing.md,
    paddingTop: 12,
    paddingBottom: 12,
    gap: 8,
  },
  filterTab: {
    paddingHorizontal: 14, paddingVertical: 7,
    borderRadius: radius.full,
    backgroundColor: colors.offWhite,
  },
  filterTabActive: { backgroundColor: colors.accent },
  filterTabText:   { color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '600' },
  filterTabTextActive: { color: '#fff' },

  workflowHint: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 7,
    backgroundColor: colors.infoLight,
    paddingHorizontal: spacing.md, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  workflowText:  { color: colors.textSecondary, fontSize: fontSize.xs, flex: 1, lineHeight: 16 },
  workflowBold:  { fontWeight: '700', color: colors.textPrimary },

  listContent: { padding: spacing.md, gap: 16, paddingBottom: 40 },

  // Word group
  groupBlock:  { gap: 8 },
  groupHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 2 },
  groupWord:   { color: colors.navy, fontSize: fontSize.lg, fontWeight: '900' },
  pendingBadge:{ backgroundColor: colors.warning, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.full },
  pendingBadgeText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '700' },

  // Suggestion card
  suggCard: {
    backgroundColor: '#fff',
    borderRadius: radius.lg,
    overflow: 'hidden',
    ...shadow.card,
  },
  suggCardReviewed: { opacity: 0.7 },

  suggHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  suggFieldBadge: {
    backgroundColor: colors.navy,
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: radius.full,
  },
  suggFieldText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '700' },
  suggMeta:      { color: colors.textLight, fontSize: fontSize.xs },

  currentBlock: {
    paddingHorizontal: 14, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: colors.border,
    backgroundColor: colors.offWhite,
  },
  blockLabel:   { color: colors.textLight, fontSize: 10, fontWeight: '700', letterSpacing: 1, marginBottom: 4 },
  currentText:  { color: colors.textMuted, fontSize: fontSize.sm, lineHeight: 18 },
  emptyText:    { color: colors.textLight, fontSize: fontSize.sm, fontStyle: 'italic' },

  suggestedBlock: {
    paddingHorizontal: 14, paddingVertical: 10,
    backgroundColor: '#F0FDF4',
  },
  suggestedBlockReviewed: { backgroundColor: colors.offWhite },
  suggestedTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  suggestedText: { color: colors.textPrimary, fontSize: fontSize.md, lineHeight: 20, fontWeight: '500' },

  shareBtn:     { flexDirection: 'row', alignItems: 'center', gap: 5 },
  shareBtnText: { color: colors.accent, fontSize: fontSize.xs, fontWeight: '700' },

  reviewedBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: colors.navy,
    paddingVertical: 12,
  },
  reviewedBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '700' },

  approveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: '#059669',
    paddingVertical: 12,
    marginBottom: 8,
    borderRadius: radius.md,
  },
  approveBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  publishedPill: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    backgroundColor: '#ECFDF5', paddingVertical: 10, borderRadius: radius.md,
  },
  publishedPillText: { color: '#059669', fontSize: fontSize.sm, fontWeight: '700' },

  undoBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    paddingVertical: 12,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  undoBtnText: { color: colors.textMuted, fontSize: fontSize.sm },
});
