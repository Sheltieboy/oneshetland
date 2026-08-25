/**
 * app/shift-boost-history.tsx
 *
 * Shift boosts this employer has paid for. Read-only, and deliberately so:
 * buying a boost lives on the website for App Store compliance, but showing
 * somebody what they already bought is history, not a purchase mechanism.
 *
 * Reached from My posted shifts.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl } from 'react-native';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAuth } from '@/context/AuthContext';
import { fetchMyBoostPurchases, type BoostPurchase } from '@/lib/shifts-api';
import { formatPence } from '@/lib/local-api';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';

const S = SECTIONS.shifts;

const METHOD_LABEL: Record<string, string> = {
  card:   'Paid by card',
  wallet: 'Paid from wallet',
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function ShiftBoostHistoryScreen() {
  const { session } = useAuth();
  const { screenWidth } = useAppLayout();
  const [rows, setRows] = useState<BoostPurchase[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    if (!session?.user?.id) { setRows([]); setLoading(false); setRefreshing(false); return; }
    fetchMyBoostPurchases()
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, [session?.user?.id]);

  useEffect(() => { load(); }, [load]);

  const now = new Date().toISOString();

  return (
    <ScreenScaffold header={<ScreenHeader title="Boost history" accent={S.color} />}>
      {loading ? (
        <LoadingState accent={S.color} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="bolt"
          title="No boosts yet"
          body="Boosting a shift pins it above the others and alerts matching workers for 24 hours. Anything you buy on the website shows up here."
          accent={S.color}
          variant="card"
        />
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />
          }
        >
          {rows.map(p => {
            const active = p.boosted_until > now;
            return (
              <View key={p.id} style={styles.card}>
                <View style={styles.topRow}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.title} numberOfLines={2}>{p.shift_title}</Text>
                    {p.business_name ? <Text style={styles.org} numberOfLines={1}>{p.business_name}</Text> : null}
                    <Text style={styles.sub}>Shift boost · {p.duration_hours} hours</Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.amount}>{formatPence(p.amount_pence)}</Text>
                    <Text style={styles.method}>{METHOD_LABEL[p.method] ?? 'Paid'}</Text>
                  </View>
                </View>

                <View style={styles.footRow}>
                  <View style={styles.donePill}><Text style={styles.donePillText}>Completed</Text></View>
                  {active ? (
                    <View style={[styles.activePill, { backgroundColor: S.color }]}>
                      <Text style={styles.activePillText}>⚡ Boost currently active</Text>
                    </View>
                  ) : null}
                  <Text style={styles.date}>{fmtDate(p.purchased_at)}</Text>
                </View>
              </View>
            );
          })}
          <View style={{ height: 24 }} />
        </ScrollView>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content: { padding: spacing.md, gap: 12 },

  card: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: 12,
  },
  topRow:  { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  title:   { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  org:     { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 1 },
  sub:     { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 4 },
  amount:  { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  method:  { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted, marginTop: 2 },

  footRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8,
             borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 },
  donePill:      { backgroundColor: '#ecfdf5', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  donePillText:  { fontSize: fontSize.xs, fontWeight: '800', color: '#047857' },
  activePill:    { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  activePillText:{ fontSize: fontSize.xs, fontWeight: '800', color: '#fff' },
  date:          { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted, marginLeft: 'auto' },
});
