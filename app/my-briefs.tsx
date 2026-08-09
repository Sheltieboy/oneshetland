/**
 * my-briefs.tsx — the jobs you've posted, and what came back.
 *
 * App twin of the website's /get-it-done/mine.
 *
 * Declines are shown with their reason rather than quietly dropped. Eleven
 * "booked up" replies is a real answer: it tells somebody to stop waiting and
 * widen their search today, and it's the evidence behind the waiting list.
 * Closing a job asks HOW it ended, because "sorted through OneShetland" against
 * "sorted elsewhere" is the only honest measure of whether this works.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, radius, shadow, spacing } from '@/constants/theme';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { useAuth } from '@/context/AuthContext';
import { TRADE_LABEL } from '@/constants/trades';
import { closeBrief, fetchMyBriefs, type MyBrief } from '@/lib/trades-api';

const ACCENT = '#2a8b5c';

const OUTCOMES = [
  { key: 'via_oneshetland',  label: 'Sorted — through OneShetland' },
  { key: 'elsewhere',        label: 'Sorted — found someone else' },
  { key: 'no_longer_needed', label: "Don't need it now" },
  { key: 'gave_up',          label: 'Gave up looking' },
] as const;

const DECLINE_LABEL: Record<string, string> = {
  booked_up: 'booked up', too_small: 'job too small', too_far: 'too far',
  wrong_trade: 'not their trade', other: "can't take it on",
};

export default function MyBriefsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const [briefs, setBriefs] = useState<MyBrief[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.id) { setLoading(false); return; }
    setBriefs(await fetchMyBriefs(profile.id));
    setLoading(false);
  }, [profile?.id]);

  useEffect(() => { void load(); }, [load]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader title="Your jobs" subtitle="What you've posted, and who came back" accent={ACCENT} onClose={() => router.back()} />

      {loading ? (
        <ActivityIndicator style={{ marginTop: spacing.xl }} color={ACCENT} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor={ACCENT} />}
        >
          {briefs.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>You haven&apos;t posted anything yet.</Text>
              <TouchableOpacity style={[styles.cta, { backgroundColor: ACCENT }]} onPress={() => router.push('/get-it-done')}>
                <Text style={styles.ctaText}>Describe a job</Text>
              </TouchableOpacity>
            </View>
          ) : briefs.map(b => {
            const interested = b.responses.filter(r => r.status === 'interested');
            const declined = b.responses.filter(r => r.status === 'declined');
            const waiting = b.responses.filter(r => r.status === 'sent' || r.status === 'viewed');
            return (
              <View key={b.id} style={styles.card}>
                <View style={styles.cardHead}>
                  <Text style={styles.cardTitle}>{b.title}</Text>
                  {b.status !== 'open' && (
                    <Text style={styles.closedBadge}>{b.status === 'sorted' ? 'Sorted' : 'Closed'}</Text>
                  )}
                </View>
                <Text style={styles.cardMeta}>
                  {b.trades.map(t => TRADE_LABEL[t] ?? t).join(' · ')} · {b.location}
                </Text>

                {interested.map(r => (
                  <View key={r.id} style={styles.interested}>
                    <Text style={styles.interestedName}>{r.businessName} is interested</Text>
                    {!!r.businessPhone && (
                      <Text style={styles.phone} onPress={() => Linking.openURL(`tel:${r.businessPhone}`)}>
                        {r.businessPhone}
                      </Text>
                    )}
                  </View>
                ))}

                {declined.length > 0 && (
                  <Text style={styles.cardNote}>
                    {declined.length} said no — {[...new Set(declined.map(d => DECLINE_LABEL[d.declineReason ?? 'other']))].join(', ')}
                  </Text>
                )}
                {waiting.length > 0 && <Text style={styles.cardNote}>{waiting.length} haven&apos;t answered yet</Text>}
                {b.responses.length === 0 && (
                  <Text style={styles.cardNote}>
                    Nobody has this yet. It&apos;s counted in the waiting list, which is what we use to get
                    more trades signed up.
                  </Text>
                )}

                {b.status === 'open' && (
                  <View style={styles.closeRow}>
                    {closingId !== b.id ? (
                      <TouchableOpacity onPress={() => { Haptics.selectionAsync(); setClosingId(b.id); }}>
                        <Text style={styles.closeLink}>Mark this as done</Text>
                      </TouchableOpacity>
                    ) : (
                      <View>
                        <Text style={styles.closePrompt}>How did it end?</Text>
                        <View style={styles.chips}>
                          {OUTCOMES.map(o => (
                            <TouchableOpacity
                              key={o.key}
                              style={styles.chip}
                              onPress={async () => {
                                if (!profile?.id) return;
                                const ok = await closeBrief(b.id, profile.id, o.key);
                                if (ok) { setClosingId(null); void load(); }
                              }}
                            >
                              <Text style={styles.chipText}>{o.label}</Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      </View>
                    )}
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  body: { padding: spacing.md, paddingBottom: spacing.xxl },
  empty: { alignItems: 'flex-start', padding: spacing.md },
  emptyText: { fontSize: fontSize.md, color: colors.textSecondary },
  card: { marginBottom: spacing.md, padding: spacing.md, borderRadius: radius.lg, backgroundColor: colors.cardBackground, ...shadow.card },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  cardTitle: { flex: 1, fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  closedBadge: { overflow: 'hidden', borderRadius: radius.full, backgroundColor: colors.screenBackground, paddingHorizontal: 8, paddingVertical: 3, fontSize: 10, fontWeight: '900', color: colors.textMuted },
  cardMeta: { marginTop: 2, fontSize: fontSize.xs, color: colors.textMuted },
  interested: { marginTop: spacing.sm, padding: 10, borderRadius: radius.md, backgroundColor: '#D1FAE5' },
  interestedName: { fontSize: fontSize.sm, fontWeight: '800', color: '#065F46' },
  phone: { marginTop: 2, fontSize: fontSize.lg, fontWeight: '900', color: '#065F46', textDecorationLine: 'underline' },
  cardNote: { marginTop: spacing.sm, fontSize: fontSize.sm, lineHeight: 19, color: colors.textMuted },
  closeRow: { marginTop: spacing.md, paddingTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border },
  closeLink: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary, textDecorationLine: 'underline' },
  closePrompt: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border },
  chipText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.textSecondary },
  cta: { marginTop: spacing.md, paddingHorizontal: 20, paddingVertical: 13, borderRadius: radius.full },
  ctaText: { fontSize: fontSize.md, fontWeight: '800', color: '#fff' },
});
