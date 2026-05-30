/**
 * spik-filter.tsx
 *
 * Drill-in from the Origin / Usage cards on the Spik tab.
 * Lists every Spik word matching a single origin or usage_level slice.
 *
 * Params (one of):
 *   ?origin=scots         → words where origin = 'scots'
 *   ?usage=less common    → words where usage_level = 'less common'
 */

import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import {
  fetchSpikByOrigin, fetchSpikByUsage,
  type SpikListItem,
} from '@/lib/oneshetland-api';
import { paletteFor } from '@/lib/spik-palette';

const S = SECTIONS.spik;

function stripHtml(str: string): string {
  return str.replace(/<[^>]*>/g, '').trim();
}

function WordCard({ item, onPress }: { item: SpikListItem; onPress: () => void }) {
  const pal     = paletteFor(item.part_of_speech);
  const example = item.example_sentence ? stripHtml(item.example_sentence) : null;
  return (
    <TouchableOpacity
      style={[styles.card, { borderLeftColor: pal.bar }]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <View style={styles.cardTop}>
        <Text style={styles.wordText}>{item.word}</Text>
        {item.part_of_speech ? (
          <View style={[styles.posBadge, { backgroundColor: pal.bg }]}>
            <Text style={[styles.posText, { color: pal.text }]}>{item.part_of_speech}</Text>
          </View>
        ) : null}
      </View>
      {item.short_meaning ? (
        <Text style={styles.meaningText} numberOfLines={2}>{item.short_meaning}</Text>
      ) : null}
      {example ? (
        <Text style={styles.exampleText} numberOfLines={1}>"{example}"</Text>
      ) : null}
    </TouchableOpacity>
  );
}

export default function SpikFilterScreen() {
  const router = useRouter();
  const { origin, usage } = useLocalSearchParams<{ origin?: string; usage?: string }>();

  const [words,   setWords]   = useState<SpikListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  // Build the filter label and the fetch promise once per param change.
  const filterKind  = origin ? 'origin' : usage ? 'usage' : null;
  const filterValue = (origin ?? usage ?? '').trim();

  useEffect(() => {
    if (!filterKind || !filterValue) {
      setError('No filter specified.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const fetcher = filterKind === 'origin'
      ? fetchSpikByOrigin(filterValue)
      : fetchSpikByUsage(filterValue);
    fetcher
      .then(rows => setWords(rows))
      .catch(() => setError('Could not load words.'))
      .finally(() => setLoading(false));
  }, [filterKind, filterValue]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => { Haptics.selectionAsync(); router.back(); }}
          hitSlop={12}
        >
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Spik</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {filterKind === 'origin' ? 'Origin' : 'Usage'}
        </Text>
        <View style={{ width: 70 }} />
      </View>

      {/* Filter chip + count */}
      <View style={styles.subHeader}>
        <View style={[styles.filterChip, { backgroundColor: S.color }]}>
          <FontAwesome5
            name={filterKind === 'origin' ? 'globe-europe' : 'chart-pie'}
            size={11}
            color="#fff"
            solid
          />
          <Text style={styles.filterChipText}>{filterValue}</Text>
        </View>
        {!loading && (
          <Text style={styles.countText}>
            {words.length} word{words.length !== 1 ? 's' : ''}
          </Text>
        )}
      </View>

      {/* List */}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={S.color} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : (
        <FlatList
          data={words}
          keyExtractor={w => String(w.id)}
          renderItem={({ item }) => (
            <WordCard
              item={item}
              onPress={() => router.push({ pathname: '/spik-detail', params: { id: String(item.id) } })}
            />
          )}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.errorText}>No words in this slice.</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: colors.screenBackground },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 70 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '900' },

  subHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    backgroundColor: '#fff',
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  filterChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.full,
  },
  filterChipText: { color: '#fff', fontSize: fontSize.xs, fontWeight: '800', textTransform: 'capitalize' },
  countText:      { color: colors.textMuted, fontSize: fontSize.xs, fontWeight: '700' },

  listContent: { paddingBottom: 32 },

  card: {
    backgroundColor: colors.cardBackground,
    borderRadius: radius.lg,
    borderLeftWidth: 4,
    paddingHorizontal: 14, paddingTop: 14, paddingBottom: 12,
    marginHorizontal: spacing.md, marginTop: 10,
    shadowColor: '#0F1C26', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07, shadowRadius: 8, elevation: 2,
  },
  cardTop:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 6 },
  wordText:    { color: colors.textPrimary, fontSize: fontSize.xl, fontWeight: '800', flex: 1, lineHeight: 26 },
  posBadge:    { paddingHorizontal: 9, paddingVertical: 4, borderRadius: radius.full, flexShrink: 0, marginTop: 2 },
  posText:     { fontSize: 11, fontWeight: '700' },
  meaningText: { color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 20, marginBottom: 6 },
  exampleText: { color: colors.textLight, fontSize: fontSize.xs, lineHeight: 18, fontStyle: 'italic' },

  center:    { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 60 },
  errorText: { color: colors.textMuted, fontSize: fontSize.md, marginBottom: 12 },
});
