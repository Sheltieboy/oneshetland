import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { colors, fontSize, spacing, radius, shadow } from '@/constants/theme';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';

interface LiveRun {
  id: string;
  departure_start: string;
  departure_end: string;
  ferry_crossing: boolean;
  notes: string | null;
  categories_accepted: string[];
}

export default function LandingScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const [runs, setRuns] = useState<LiveRun[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(true);

  useEffect(() => {
    const now = new Date().toISOString();
    supabase
      .from('runs')
      .select('id, departure_start, departure_end, ferry_crossing, notes, categories_accepted')
      .eq('status', 'open')
      .gte('departure_end', now)
      .order('departure_start', { ascending: true })
      .limit(5)
      .then(({ data }) => {
        setRuns((data as LiveRun[]) ?? []);
        setLoadingRuns(false);
      });
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={styles.hero}>
          <View style={styles.brandRow}>
            <View style={styles.logoCircle}>
              <Image
                source={require('../assets/icon.png')}
                style={styles.logoImage}
                resizeMode="contain"
              />
            </View>
            <Text style={styles.brand}>OneShetland Fetch</Text>
          </View>
          <Text style={styles.tagline}>
            Community-powered collections and deliveries across Shetland.
          </Text>
          <Text style={styles.intro}>
            Need something picked up from Lerwick? A local driver heading your way can bring it.
          </Text>
        </View>

        {/* CTAs */}
        <View style={styles.ctaSection}>
          {session ? (
            <Button
              label="Go to my dashboard"
              onPress={() => router.replace('/(customer)/dashboard')}
              variant="primary"
              size="lg"
              fullWidth
            />
          ) : (
            <>
              <Button
                label="Request a collection"
                onPress={() => router.push('/(auth)/sign-in')}
                variant="primary"
                size="lg"
                fullWidth
              />
              <View style={styles.ctaGap} />
              <Button
                label="Become a driver"
                onPress={() => router.push('/(auth)/sign-up')}
                variant="outline"
                size="lg"
                fullWidth
              />
              <TouchableOpacity
                onPress={() => router.push('/(auth)/sign-in')}
                style={styles.signInLink}
              >
                <Text style={styles.signInText}>
                  Already a member?{' '}
                  <Text style={styles.signInTextBold}>Sign in</Text>
                </Text>
              </TouchableOpacity>
            </>
          )}
        </View>

        {/* What we deliver */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>What we deliver</Text>
          <View style={styles.categoryGrid}>
            {[
              { icon: '🍕', label: 'Takeaway' },
              { icon: '💊', label: 'Pharmacy' },
              { icon: '📦', label: 'Small parcels' },
              { icon: '🛍️', label: 'Shop collections' },
              { icon: '🛒', label: 'Click-and-collect' },
              { icon: '📫', label: 'Other collections' },
            ].map((item) => (
              <View key={item.label} style={styles.categoryChip}>
                <Text style={styles.categoryIcon}>{item.icon}</Text>
                <Text style={styles.categoryLabel}>{item.label}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Available runs */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Runs available now</Text>
            <View style={styles.liveBadge}>
              <Text style={styles.liveBadgeText}>Live</Text>
            </View>
          </View>
          <Text style={styles.sectionSubtitle}>
            Sign in to book a collection on one of these runs.
          </Text>

          {loadingRuns ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyText}>Loading runs…</Text>
            </Card>
          ) : runs.length === 0 ? (
            <Card style={styles.emptyCard}>
              <Text style={styles.emptyText}>
                ⛵ No runs available right now — check back soon.
              </Text>
            </Card>
          ) : (
            runs.map((run) => {
              const start = new Date(run.departure_start);
              const end = new Date(run.departure_end);
              const today = new Date();
              const tomorrow = new Date(today);
              tomorrow.setDate(today.getDate() + 1);
              const isToday = start.toDateString() === today.toDateString();
              const isTomorrow = start.toDateString() === tomorrow.toDateString();
              const dayLabel = isToday
                ? 'Today'
                : isTomorrow
                ? 'Tomorrow'
                : start.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
              const timeRange = `${start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} – ${end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
              const noteLines = (run.notes ?? '').split('\n');
              const origin = noteLines.find((l) => l.startsWith('Origin:'))?.replace('Origin: ', '') ?? 'Lerwick';
              const destination = noteLines.find((l) => l.startsWith('Destination:'))?.replace('Destination: ', '') ?? '—';

              return (
                <Card key={run.id} style={styles.runCard}>
                  <View style={styles.runHeader}>
                    <Text style={styles.runRoute}>{origin} → {destination}</Text>
                    {run.ferry_crossing && (
                      <View style={styles.ferryBadge}>
                        <Text style={styles.ferryText}>⛴ Ferry</Text>
                      </View>
                    )}
                  </View>
                  <Text style={styles.runWindow}>{dayLabel}, {timeRange}</Text>
                  {run.categories_accepted?.length > 0 && (
                    <View style={styles.runCategoryRow}>
                      {run.categories_accepted.slice(0, 3).map((cat) => (
                        <View key={cat} style={styles.runCategoryChip}>
                          <Text style={styles.runCategoryText}>{cat}</Text>
                        </View>
                      ))}
                      {run.categories_accepted.length > 3 && (
                        <Text style={styles.runCategoryMore}>
                          +{run.categories_accepted.length - 3} more
                        </Text>
                      )}
                    </View>
                  )}
                  <Button
                    label="Sign in to book"
                    onPress={() => router.push('/(auth)/sign-in')}
                    variant="secondary"
                    size="sm"
                    style={styles.bookButton}
                  />
                </Card>
              );
            })
          )}
        </View>

        {/* How it works */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>How it works</Text>
          {[
            {
              step: '1',
              title: 'Create a request',
              body: "Tell us what needs collecting, where from, and where it's going.",
            },
            {
              step: '2',
              title: 'A driver picks it up',
              body: 'A local driver already heading that way collects your item.',
            },
            {
              step: '3',
              title: 'Delivered to your door',
              body: "You're notified when it's on its way and when it arrives.",
            },
          ].map((item) => (
            <View key={item.step} style={styles.howStep}>
              <View style={styles.stepNumber}>
                <Text style={styles.stepNumberText}>{item.step}</Text>
              </View>
              <View style={styles.stepBody}>
                <Text style={styles.stepTitle}>{item.title}</Text>
                <Text style={styles.stepText}>{item.body}</Text>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            OneShetland Fetch • Goods only • No alcohol, tobacco, or passengers
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  scroll: { flex: 1, backgroundColor: colors.screenBackground },
  content: { paddingBottom: spacing.xxl },

  hero: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxl,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  logoCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
  },
  logoImage: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  brand: {
    color: colors.white,
    fontSize: fontSize.lg,
    fontWeight: '700',
  },
  tagline: {
    color: colors.white,
    fontSize: fontSize.xxl,
    fontWeight: '800',
    lineHeight: 34,
    marginBottom: spacing.md,
  },
  intro: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: fontSize.md,
    lineHeight: 24,
  },

  ctaSection: {
    padding: spacing.lg,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  ctaGap: { height: spacing.sm },
  signInLink: {
    alignItems: 'center',
    marginTop: spacing.md,
  },
  signInText: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
  },
  signInTextBold: {
    color: colors.navy,
    fontWeight: '600',
  },

  section: {
    padding: spacing.lg,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  sectionTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: spacing.sm,
  },
  sectionSubtitle: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginBottom: spacing.md,
  },
  liveBadge: {
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
    marginBottom: spacing.sm,
  },
  liveBadgeText: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    color: '#166534',
  },

  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  categoryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.white,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
  },
  categoryIcon: { fontSize: 16 },
  categoryLabel: {
    fontSize: fontSize.sm,
    color: colors.textPrimary,
    fontWeight: '500',
  },

  emptyCard: { padding: spacing.md },
  emptyText: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    textAlign: 'center',
  },

  runCard: {
    marginBottom: spacing.sm,
  },
  runHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  runRoute: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
    flex: 1,
  },
  ferryBadge: {
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  ferryText: {
    fontSize: fontSize.xs,
    color: '#1D4ED8',
    fontWeight: '600',
  },
  runWindow: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginBottom: spacing.sm,
  },
  runCategoryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: spacing.sm,
  },
  runCategoryChip: {
    backgroundColor: colors.offWhite,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  runCategoryText: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
  },
  runCategoryMore: {
    fontSize: fontSize.xs,
    color: colors.textLight,
    alignSelf: 'center',
  },
  bookButton: {
    alignSelf: 'flex-start',
  },

  howStep: {
    flexDirection: 'row',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  stepNumber: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  stepNumberText: {
    color: colors.white,
    fontWeight: '800',
    fontSize: fontSize.sm,
  },
  stepBody: { flex: 1 },
  stepTitle: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: 4,
  },
  stepText: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    lineHeight: 20,
  },

  footer: {
    padding: spacing.lg,
    alignItems: 'center',
  },
  footerText: {
    fontSize: fontSize.xs,
    color: colors.textLight,
    textAlign: 'center',
  },
});
