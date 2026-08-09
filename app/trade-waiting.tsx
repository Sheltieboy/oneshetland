/**
 * trade-waiting.tsx — what Shetland is waiting for.
 *
 * App twin of the website's /get-it-done/waiting.
 *
 * This is the most valuable thing the feature produces: the pitch to every
 * trade not listed yet, the argument for apprentice places, and a story worth
 * printing. Demand is the only leverage anybody has on supply, and until now
 * nobody in Shetland had the number.
 *
 * Aggregate only — it comes from trade_demand_summary(), which returns counts
 * and nothing else, so it can be shown to anyone without exposing a soul's job.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, radius, shadow, spacing } from '@/constants/theme';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { TRADE_LABEL } from '@/constants/trades';
import { fetchTradeDemand, type DemandRow } from '@/lib/trades-api';

const ACCENT = '#2a8b5c';

export default function TradeWaitingScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<DemandRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRows(await fetchTradeDemand());
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const total = rows.reduce((n, r) => n + r.waiting, 0);
  const unanswered = rows.reduce((n, r) => n + r.unanswered, 0);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader
        title="What Shetland is waiting for"
        subtitle="Open jobs nobody has taken on yet"
        accent={ACCENT}
        onClose={() => router.back()}
      />

      {loading ? (
        <ActivityIndicator style={{ marginTop: spacing.xl }} color={ACCENT} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
              tintColor={ACCENT}
            />
          }
        >
          {total === 0 ? (
            <Text style={styles.note}>
              Nothing waiting just now. When folk post jobs that nobody picks up, they show
              here — it&apos;s how we make the case for more trades.
            </Text>
          ) : (
            <>
              <Text style={styles.lede}>
                <Text style={styles.ledeStrong}>{total}</Text> open {total === 1 ? 'job' : 'jobs'} across
                the isles{unanswered > 0 ? `, ${unanswered} of them with nobody signed up yet.` : '.'}
              </Text>

              {rows.map(r => (
                <View key={r.trade} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTrade}>{TRADE_LABEL[r.trade] ?? r.trade}</Text>
                    <Text style={styles.rowMeta}>
                      {r.unanswered > 0 ? `${r.unanswered} with no answer · ` : ''}
                      average {r.avgDaysWaiting} days waiting
                    </Text>
                  </View>
                  <Text style={styles.rowCount}>{r.waiting}</Text>
                </View>
              ))}
            </>
          )}

          <View style={styles.pitch}>
            <Text style={styles.pitchTitle}>If you&apos;re a tradesperson</Text>
            <Text style={styles.pitchBody}>
              This is work nobody is doing. Say what you cover and whether you have room, and
              the jobs come to you — your first few each month are free. We never charge to be
              seen sooner: the order is who has room and who answers.
            </Text>
            <TouchableOpacity
              style={styles.pitchCta}
              onPress={() => { Haptics.selectionAsync(); router.push('/local-business-dashboard'); }}
            >
              <Text style={styles.pitchCtaText}>Set up your listing</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.postCta]}
            onPress={() => { Haptics.selectionAsync(); router.push('/get-it-done'); }}
          >
            <Text style={styles.postCtaText}>Post a job of your own</Text>
          </TouchableOpacity>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  body: { padding: spacing.md, paddingBottom: spacing.xxl },
  lede: { fontSize: fontSize.md, lineHeight: 22, color: colors.textSecondary, marginBottom: spacing.md },
  ledeStrong: { fontWeight: '900', color: colors.textPrimary },
  note: { fontSize: fontSize.md, lineHeight: 22, color: colors.textMuted },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    padding: spacing.md, marginBottom: spacing.sm,
    borderRadius: radius.lg, backgroundColor: colors.cardBackground, ...shadow.card,
  },
  rowTrade: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  rowMeta: { marginTop: 2, fontSize: fontSize.xs, color: colors.textMuted },
  rowCount: { fontSize: fontSize.xxl, fontWeight: '900', color: ACCENT },
  pitch: {
    marginTop: spacing.lg, padding: spacing.md,
    borderRadius: radius.lg, backgroundColor: colors.cardBackground,
    borderWidth: 1, borderColor: colors.border,
  },
  pitchTitle: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  pitchBody: { marginTop: 6, fontSize: fontSize.sm, lineHeight: 20, color: colors.textSecondary },
  pitchCta: {
    alignSelf: 'flex-start', marginTop: spacing.md,
    paddingHorizontal: 18, paddingVertical: 11,
    borderRadius: radius.full, backgroundColor: ACCENT,
  },
  pitchCtaText: { fontSize: fontSize.sm, fontWeight: '900', color: '#fff' },
  postCta: {
    marginTop: spacing.md, paddingVertical: 13, alignItems: 'center',
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.border,
  },
  postCtaText: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textSecondary },
});
