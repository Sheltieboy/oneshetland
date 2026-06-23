import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Image,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { useAuth } from '@/context/AuthContext';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { haptic } from '@/lib/haptics';
import {
  fetchHomeFeed,
  formatEventDate,
  decodeEntities,
  OSHomeFeed,
} from '@/lib/oneshetland-api';

// ── Greeting helper ────────────────────────────────────────────────────────────
function greeting(name: string | null): string {
  const hour = new Date().getHours();
  const time = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${time}, ${name.split(' ')[0]}` : time;
}

export default function HomeScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [feed, setFeed] = useState<OSHomeFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin  = profile?.role === 'admin';

  const loadFeed = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchHomeFeed();
      setFeed(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load feed — check your connection.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { loadFeed(); }, [loadFeed]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadFeed();
  }, [loadFeed]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.navy} />}
      >

        {/* ── Header ── */}
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <View>
              <Text style={styles.greetingText}>{greeting(profile?.full_name ?? null)}</Text>
              <Text style={styles.locationText}>📍 Shetland</Text>
            </View>
            <TouchableOpacity onPress={() => { haptic.light(); router.push('/account'); }}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {(profile?.full_name ?? 'U')[0].toUpperCase()}
                </Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Fetch CTA ── */}
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.fetchCard}
            activeOpacity={0.88}
            onPress={() => {
              haptic.medium();
              // Fetch is a section — everyone lands in the Fetch tab and toggles
              // Requester/Driver there. (Admins still have their own dashboard
              // reachable from Me → Admin.)
              router.push('/(tabs)/fetch');
            }}
          >
            <View style={styles.fetchCardLeft}>
              <View style={styles.fetchIconWrap}>
                <FontAwesome5 name="shipping-fast" size={22} color={colors.white} />
              </View>
              <View>
                <Text style={styles.fetchCardTitle}>OneShetland Fetch</Text>
                <Text style={styles.fetchCardSub}>
                  Request a community delivery
                </Text>
              </View>
            </View>
            <FontAwesome5 name="chevron-right" size={14} color={colors.white} />
          </TouchableOpacity>
        </View>

        {/* ── Loading / Error ── */}
        {loading && (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color={colors.navy} />
          </View>
        )}
        {error && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={loadFeed}>
              <Text style={styles.retryText}>Tap to retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {feed && (
          <>
            {/* ── Spik Word of the Day ── */}
            {feed.spik_word && (
              <View style={styles.section}>
                <SectionHeader title="Spik Word of the Day" icon="book" />
                <View style={styles.spikCard}>
                  <View style={styles.spikWordRow}>
                    <Text style={styles.spikWord}>{decodeEntities(feed.spik_word.word)}</Text>
                    {feed.spik_word.part_of_speech ? (
                      <Text style={styles.spikPos}>{feed.spik_word.part_of_speech}</Text>
                    ) : null}
                  </View>
                  {feed.spik_word.definition ? (
                    <Text style={styles.spikDefinition}>{feed.spik_word.definition}</Text>
                  ) : null}
                  {feed.spik_word.example ? (
                    <Text style={styles.spikExample}>"{decodeEntities(feed.spik_word.example)}"</Text>
                  ) : null}
                  {feed.spik_word.category ? (
                    <View style={styles.spikCategoryPill}>
                      <Text style={styles.spikCategoryText}>{feed.spik_word.category}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            )}

            {/* ── What's On ── */}
            {feed.events.length > 0 && (
              <View style={styles.section}>
                <SectionHeader title="What's On" icon="calendar-alt" />
                {feed.events.map((event) => (
                  <TouchableOpacity
                    key={event.id}
                    style={styles.eventCard}
                    activeOpacity={0.85}
                    onPress={() => haptic.light()}
                  >
                    {event.image ? (
                      <Image source={{ uri: event.image }} style={styles.eventImage} />
                    ) : (
                      <View style={[styles.eventImage, styles.eventImagePlaceholder]}>
                        <FontAwesome5 name="calendar" size={20} color={colors.textLight} />
                      </View>
                    )}
                    <View style={styles.eventBody}>
                      <View style={styles.eventDatePill}>
                        <Text style={styles.eventDateText}>{formatEventDate(event.start_date)}</Text>
                      </View>
                      <Text style={styles.eventTitle} numberOfLines={2}>
                        {decodeEntities(event.title)}
                      </Text>
                      {event.venue ? (
                        <Text style={styles.eventVenue} numberOfLines={1}>
                          📍 {decodeEntities(event.venue)}
                        </Text>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* ── Latest Notices ── */}
            {feed.notices.length > 0 && (
              <View style={styles.section}>
                <SectionHeader title="Latest Notices" icon="bullhorn" />
                <View style={styles.noticeList}>
                  {feed.notices.map((notice, i) => (
                    <TouchableOpacity
                      key={notice.id}
                      style={[styles.noticeRow, i < feed.notices.length - 1 && styles.noticeRowBorder]}
                      activeOpacity={0.8}
                      onPress={() => haptic.light()}
                    >
                      <View style={styles.noticeIcon}>
                        <FontAwesome5 name="clipboard" size={13} color={colors.navy} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.noticeTitle} numberOfLines={1}>
                          {decodeEntities(notice.title)}
                        </Text>
                        <Text style={styles.noticeExcerpt} numberOfLines={2}>
                          {notice.excerpt}
                        </Text>
                      </View>
                      <Text style={styles.noticeDate}>
                        {new Date(notice.posted).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {/* ── Latest Jobs ── */}
            {feed.jobs.length > 0 && (
              <View style={styles.section}>
                <SectionHeader title="Latest Jobs" icon="briefcase" />
                {feed.jobs.map((job) => (
                  <TouchableOpacity
                    key={job.id}
                    style={styles.jobCard}
                    activeOpacity={0.85}
                    onPress={() => haptic.light()}
                  >
                    {job.image ? (
                      <Image source={{ uri: job.image }} style={styles.jobLogo} />
                    ) : (
                      <View style={[styles.jobLogo, styles.jobLogoPlaceholder]}>
                        <FontAwesome5 name="building" size={16} color={colors.textLight} />
                      </View>
                    )}
                    <View style={styles.jobBody}>
                      <Text style={styles.jobTitle} numberOfLines={2}>
                        {decodeEntities(job.title)}
                      </Text>
                      {job.company ? (
                        <Text style={styles.jobCompany}>{decodeEntities(job.company)}</Text>
                      ) : null}
                      <View style={styles.jobMeta}>
                        {job.location ? (
                          <Text style={styles.jobMetaText}>📍 {job.location}</Text>
                        ) : null}
                        {job.type ? (
                          <View style={styles.jobTypePill}>
                            <Text style={styles.jobTypeText}>{job.type}</Text>
                          </View>
                        ) : null}
                      </View>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {/* ── Coming Soon tiles ── */}
            <View style={styles.section}>
              <SectionHeader title="Coming Soon" icon="rocket" />
              <View style={styles.comingSoonGrid}>
                {[
                  { icon: 'store',       label: 'Services Directory' },
                  { icon: 'map-marker-alt', label: 'Tourism Guide' },
                  { icon: 'users',       label: 'Community Hubs' },
                  { icon: 'ship',        label: 'Cruise Visitor Mode' },
                ].map((item) => (
                  <View key={item.label} style={styles.comingSoonTile}>
                    <FontAwesome5 name={item.icon as any} size={18} color={colors.textLight} />
                    <Text style={styles.comingSoonLabel}>{item.label}</Text>
                  </View>
                ))}
              </View>
            </View>
          </>
        )}

        <View style={styles.footer}>
          <Text style={styles.footerText}>OneShetland · Everything Shetland, All in One Place</Text>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

// ── Section header component ───────────────────────────────────────────────────
function SectionHeader({ title, icon }: { title: string; icon: string }) {
  return (
    <View style={styles.sectionHeader}>
      <FontAwesome5 name={icon as any} size={13} color={colors.navy} style={{ marginTop: 1 }} />
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: colors.navy },
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content: { paddingBottom: 40 },

  // ── Header ──
  header: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  headerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  greetingText: {
    color: colors.white,
    fontSize: fontSize.xl,
    fontWeight: '800',
    marginBottom: 2,
  },
  locationText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: fontSize.sm,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: colors.white,
    fontSize: fontSize.md,
    fontWeight: '700',
  },

  // ── Sections ──
  section: { paddingHorizontal: spacing.lg, marginTop: spacing.xl },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  sectionTitle: {
    fontSize: fontSize.md,
    fontWeight: '800',
    color: colors.navy,
  },

  // ── Fetch CTA ──
  fetchCard: {
    backgroundColor: colors.navy,
    borderRadius: radius.lg,
    padding: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  fetchCardLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1 },
  fetchIconWrap: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fetchCardTitle: { color: colors.white, fontSize: fontSize.md, fontWeight: '800', marginBottom: 2 },
  fetchCardSub:   { color: 'rgba(255,255,255,0.65)', fontSize: fontSize.sm },

  // ── Loading / Error ──
  loadingWrap: { padding: spacing.xl, alignItems: 'center' },
  errorBox: {
    margin: spacing.lg,
    backgroundColor: '#FEF2F2',
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'center',
    gap: spacing.sm,
  },
  errorText:  { color: '#DC2626', fontSize: fontSize.sm, textAlign: 'center' },
  retryText:  { color: colors.navy, fontSize: fontSize.sm, fontWeight: '700', textDecorationLine: 'underline' },

  // ── Spik ──
  spikCard: {
    backgroundColor: colors.navy,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  spikWordRow:    { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, flexWrap: 'wrap' },
  spikWord:       { color: colors.white, fontSize: 26, fontWeight: '800' },
  spikPos:        { color: 'rgba(255,255,255,0.45)', fontSize: fontSize.xs, fontStyle: 'italic' },
  spikDefinition: { color: 'rgba(255,255,255,0.8)', fontSize: fontSize.md, lineHeight: 22 },
  spikExample:    { color: 'rgba(255,255,255,0.55)', fontSize: fontSize.sm, fontStyle: 'italic', lineHeight: 20 },
  spikCategoryPill: {
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 12,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    marginTop: spacing.xs,
  },
  spikCategoryText: { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.xs, textTransform: 'capitalize' },

  // ── Events ──
  eventCard: {
    flexDirection: 'row',
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
  },
  eventImage: { width: 90, height: 90 },
  eventImagePlaceholder: {
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  eventBody:  { flex: 1, padding: spacing.md, justifyContent: 'center', gap: 4 },
  eventDatePill: {
    alignSelf: 'flex-start',
    backgroundColor: '#EEF4FF',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginBottom: 4,
  },
  eventDateText:  { color: colors.navy, fontSize: fontSize.xs, fontWeight: '700' },
  eventTitle:     { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, lineHeight: 18 },
  eventVenue:     { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },

  // ── Notices ──
  noticeList: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  noticeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: spacing.md,
    gap: spacing.sm,
  },
  noticeRowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  noticeIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#EEF4FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  noticeTitle:    { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, marginBottom: 2 },
  noticeExcerpt:  { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16 },
  noticeDate:     { fontSize: fontSize.xs, color: colors.textLight, marginTop: 2 },

  // ── Jobs ──
  jobCard: {
    flexDirection: 'row',
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.md,
    alignItems: 'flex-start',
  },
  jobLogo: { width: 44, height: 44, borderRadius: radius.sm },
  jobLogoPlaceholder: {
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  jobBody:    { flex: 1, gap: 3 },
  jobTitle:   { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary, lineHeight: 18 },
  jobCompany: { fontSize: fontSize.xs, color: colors.textMuted },
  jobMeta:    { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 4, flexWrap: 'wrap' },
  jobMetaText:  { fontSize: fontSize.xs, color: colors.textMuted },
  jobTypePill: {
    backgroundColor: '#EEF4FF',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  jobTypeText: { fontSize: fontSize.xs, color: colors.navy, fontWeight: '600' },

  // ── Coming soon ──
  comingSoonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  comingSoonTile: {
    width: '47%',
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    padding: spacing.md,
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
  },
  comingSoonLabel: {
    fontSize: fontSize.xs,
    color: colors.textLight,
    textAlign: 'center',
    fontWeight: '600',
  },

  // ── Footer ──
  footer: { padding: spacing.xl, alignItems: 'center' },
  footerText: { fontSize: fontSize.xs, color: colors.textLight, textAlign: 'center' },
});
