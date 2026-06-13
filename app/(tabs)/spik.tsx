import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Pressable,
  Animated,
  Easing,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { colors, fontSize, radius, spacing } from '@/constants/theme';
import { useAppLayout } from '@/hooks/useAppLayout';
import { SECTIONS } from '@/constants/sections';
import {
  fetchSpikByLetter,
  fetchSpikStats,
  searchSpik,
  type SpikListItem,
  type SpikStats,
} from '@/lib/oneshetland-api';
import { paletteFor } from '@/lib/spik-palette';
import SpikStatsHeader from '@/components/SpikStatsHeader';
import { TabScreenHeader } from '@/components/TabScreenHeader';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

function stripHtml(str: string): string {
  return str.replace(/<[^>]*>/g, '').trim();
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ── Word card ─────────────────────────────────────────────────────────────────

function WordCard({ item }: { item: SpikListItem }) {
  const pal     = paletteFor(item.part_of_speech);
  const example = item.example_sentence ? stripHtml(item.example_sentence) : null;
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const onPressIn = () => {
    Haptics.selectionAsync();
    Animated.timing(scaleAnim, {
      toValue: 0.97, duration: 80,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  };

  const onPressOut = () => {
    Animated.spring(scaleAnim, {
      toValue: 1, friction: 5,
      useNativeDriver: true,
    }).start();
  };

  return (
    <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
      <TouchableOpacity
        style={[styles.card, { borderLeftColor: pal.bar }]}
        onPress={() => router.push({ pathname: '/spik-detail', params: { id: String(item.id) } })}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        activeOpacity={1}
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

        {item.pronunciation ? (
          <View style={styles.pronChip}>
            <Text style={styles.pronChipText}>/{item.pronunciation}/</Text>
          </View>
        ) : null}

        {example ? (
          <Text style={styles.exampleText} numberOfLines={1}>"{example}"</Text>
        ) : null}

        <View style={styles.cardFooter}>
          <Text style={[styles.openEntry, { color: pal.bar }]}>Open full entry</Text>
          <FontAwesome5 name="arrow-right" size={10} color={pal.bar} />
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function SpikTab() {
  const { isTablet } = useAppLayout();
  const numCols = isTablet ? 2 : 1;
  const [activeLetter, setActiveLetter] = useState('a');
  const [searchQuery, setSearchQuery]   = useState('');
  const [words, setWords]               = useState<SpikListItem[]>([]);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [stats, setStats]               = useState<SpikStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [showScrollTop, setShowScrollTop] = useState(false);

  const debouncedQuery = useDebounce(searchQuery, 300);
  const letterCache    = useRef<Record<string, SpikListItem[]>>({});
  const listRef        = useRef<FlatList>(null);
  const scrollTopAnim  = useRef(new Animated.Value(0)).current;

  const loadLetter = useCallback(async (letter: string) => {
    if (letterCache.current[letter]) { setWords(letterCache.current[letter]); return; }
    setLoading(true); setError(null);
    try {
      const data = await fetchSpikByLetter(letter);
      letterCache.current[letter] = data;
      setWords(data);
    } catch { setError('Could not load words'); }
    finally   { setLoading(false); }
  }, []);

  const loadSearch = useCallback(async (q: string) => {
    if (q.length < 2) return;
    setLoading(true); setError(null);
    try   { setWords(await searchSpik(q)); }
    catch { setError('Search failed'); }
    finally { setLoading(false); }
  }, []);

  // Load stats once on mount
  useEffect(() => {
    fetchSpikStats()
      .then(setStats)
      .catch(() => {})
      .finally(() => setStatsLoading(false));
  }, []);

  useEffect(() => { loadLetter('a'); }, [loadLetter]);

  useEffect(() => {
    if (debouncedQuery.trim().length >= 2) loadSearch(debouncedQuery.trim());
    else if (debouncedQuery.trim().length === 0) loadLetter(activeLetter);
  }, [debouncedQuery, activeLetter, loadSearch, loadLetter]);

  const handleLetterPress = useCallback((letter: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setActiveLetter(letter);
    setSearchQuery('');
    loadLetter(letter);
    // Jump to top when switching letter
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [loadLetter]);

  const handleScroll = useCallback((e: any) => {
    const y = e.nativeEvent.contentOffset.y;
    const shouldShow = y > 400;
    if (shouldShow !== showScrollTop) {
      setShowScrollTop(shouldShow);
      Animated.spring(scrollTopAnim, {
        toValue: shouldShow ? 1 : 0,
        friction: 6,
        tension: 120,
        useNativeDriver: true,
      }).start();
    }
  }, [showScrollTop, scrollTopAnim]);

  const handleScrollToTop = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  const renderWord = useCallback(({ item }: { item: SpikListItem }) => (
    isTablet
      ? <View style={{ flex: 1, maxWidth: '50%' }}><WordCard item={item} /></View>
      : <WordCard item={item} />
  ), [isTablet]);

  const isSearching = debouncedQuery.trim().length >= 2;

  const listHeader = !isSearching ? (
    <SpikStatsHeader stats={stats} loading={statsLoading} />
  ) : null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>

      {/* Header */}
      <TabScreenHeader
        section={SECTIONS.spik}
        right={
          <View style={styles.wordCountBox}>
            <Text style={[styles.wordCountNum, { color: SECTIONS.spik.color }]}>
              {statsLoading ? '…' : (stats?.total?.toLocaleString() ?? '2,845')}
            </Text>
            <Text style={styles.wordCountLabel}>words</Text>
          </View>
        }
      >
        <View style={styles.searchBox}>
          <FontAwesome5 name="search" size={13} color="rgba(255,255,255,0.45)" />
          <TextInput
            style={styles.searchInput}
            placeholder="Search words…"
            placeholderTextColor="rgba(255,255,255,0.35)"
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={() => { setSearchQuery(''); loadLetter(activeLetter); }} hitSlop={15}>
              <FontAwesome5 name="times-circle" size={14} color="rgba(255,255,255,0.45)" />
            </Pressable>
          )}
        </View>
      </TabScreenHeader>

      {/* A-Z strip */}
      {!isSearching && (
        <View style={styles.alphaWrap}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.alphaRow}>
            {ALPHABET.map(letter => (
              <TouchableOpacity
                key={letter}
                style={[styles.letterBtn, activeLetter === letter && styles.letterBtnActive]}
                onPress={() => handleLetterPress(letter)}
                activeOpacity={0.7}
                hitSlop={7}
              >
                <Text style={[styles.letterText, activeLetter === letter && styles.letterTextActive]}>
                  {letter.toUpperCase()}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* List */}
      <View style={styles.listWrap}>
        {loading && words.length === 0 ? (
          <View style={styles.center}><ActivityIndicator size="large" color={colors.accent} /></View>
        ) : error ? (
          <View style={styles.center}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity style={styles.retryBtn} onPress={() => isSearching ? loadSearch(debouncedQuery) : loadLetter(activeLetter)}>
              <Text style={styles.retryText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={words}
            keyExtractor={item => String(item.id)}
            key={numCols}
            numColumns={numCols}
            renderItem={renderWord}
            ListHeaderComponent={listHeader}
            contentContainerStyle={[styles.listContent, isTablet && styles.listContentTablet]}
            ListEmptyComponent={
              <View style={styles.center}>
                <Text style={styles.emptyText}>{isSearching ? 'No words found' : `No words for ${activeLetter.toUpperCase()}`}</Text>
              </View>
            }
            onScroll={handleScroll}
            scrollEventThrottle={16}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          />
        )}

        {/* Floating scroll-to-top button */}
        <Animated.View
          style={[
            styles.scrollTopBtn,
            {
              opacity: scrollTopAnim,
              transform: [
                { scale: scrollTopAnim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) },
                { translateY: scrollTopAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) },
              ],
              pointerEvents: showScrollTop ? 'auto' : 'none',
            },
          ]}
        >
          <TouchableOpacity
            style={styles.scrollTopInner}
            onPress={handleScrollToTop}
            activeOpacity={0.85}
          >
            <FontAwesome5 name="chevron-up" size={14} color="#fff" />
          </TouchableOpacity>
        </Animated.View>
      </View>
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },

  wordCountBox:   { alignItems: 'flex-end' },
  wordCountNum:   { fontSize: fontSize.xl, fontWeight: '800', lineHeight: 22 },
  wordCountLabel: { color: 'rgba(255,255,255,0.45)', fontSize: fontSize.xs },

  searchBox: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: radius.full,
    paddingHorizontal: 14, height: 40, gap: 8,
  },
  searchInput: { flex: 1, color: '#fff', fontSize: fontSize.md, paddingVertical: 0 },

  alphaWrap: { backgroundColor: colors.navyDark, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  alphaRow:  { paddingHorizontal: 8, paddingVertical: 8, gap: 2 },
  letterBtn: { width: 30, height: 30, borderRadius: radius.xs, justifyContent: 'center', alignItems: 'center' },
  letterBtnActive:  { backgroundColor: SECTIONS.spik.color },
  letterText:       { color: 'rgba(255,255,255,0.5)', fontSize: fontSize.sm, fontWeight: '700' },
  letterTextActive: { color: '#fff' },

  listContent: { paddingBottom: 32 },
  listContentTablet: { maxWidth: 900, alignSelf: 'center', width: '100%' },

  card: {
    backgroundColor: colors.cardBackground,
    borderRadius: radius.lg,
    borderLeftWidth: 4,
    borderLeftColor: colors.accent,
    paddingHorizontal: 14, paddingTop: 14, paddingBottom: 12,
    marginHorizontal: spacing.md,
    marginTop: 10,
    shadowColor: '#0F1C26',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 2,
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 6 },
  wordText:    { color: colors.textPrimary, fontSize: fontSize.xl, fontWeight: '800', flex: 1, lineHeight: 26 },
  posBadge:    { paddingHorizontal: 9, paddingVertical: 4, borderRadius: radius.full, flexShrink: 0, marginTop: 2 },
  posText:     { fontSize: 11, fontWeight: '700' },
  meaningText: { color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 20, marginBottom: 8 },
  pronChip:    { alignSelf: 'flex-start', backgroundColor: colors.offWhite, borderRadius: radius.full, paddingHorizontal: 9, paddingVertical: 3, marginBottom: 6 },
  pronChipText: { color: colors.textMuted, fontSize: fontSize.xs, fontStyle: 'italic' },
  exampleText: { color: colors.textMuted, fontSize: fontSize.xs, lineHeight: 18, fontStyle: 'italic', marginBottom: 4 },
  cardFooter:  { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  openEntry:   { fontSize: fontSize.xs, fontWeight: '700' },

  listWrap: { flex: 1 },

  scrollTopBtn: {
    position: 'absolute',
    bottom: 20,
    right: 20,
    zIndex: 10,
  },
  scrollTopInner: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.navy,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
  },

  center:    { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 60 },
  errorText: { color: colors.textMuted, fontSize: fontSize.md, marginBottom: 12 },
  retryBtn:  { backgroundColor: SECTIONS.spik.color, paddingHorizontal: 20, paddingVertical: 10, borderRadius: radius.full },
  retryText: { color: '#fff', fontWeight: '700', fontSize: fontSize.sm },
  emptyText: { color: colors.textMuted, fontSize: fontSize.md },
});
