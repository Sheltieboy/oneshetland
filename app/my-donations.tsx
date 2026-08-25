/**
 * app/my-donations.tsx
 *
 * Donations this person has made to Shetland hubs. Read-only — giving happens
 * on the campaign screen; this is the record of what was given, and it outlives
 * the campaign page.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, RefreshControl } from 'react-native';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAuth } from '@/context/AuthContext';
import { fetchMyDonations, type MyDonation } from '@/lib/hubs-api';
import { formatPence } from '@/lib/local-api';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';

const S = SECTIONS.community;

const METHOD_LABEL: Record<string, string> = { card: 'Paid by card', wallet: 'Paid from wallet' };

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function MyDonationsScreen() {
  const { session } = useAuth();
  const { screenWidth } = useAppLayout();
  const [rows, setRows] = useState<MyDonation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    if (!session?.user?.id) { setRows([]); setLoading(false); setRefreshing(false); return; }
    fetchMyDonations()
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, [session?.user?.id]);

  useEffect(() => { load(); }, [load]);

  const total = rows.reduce((sum, d) => sum + d.amount_pence, 0);

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="My donations"
          subtitle={rows.length > 0 ? `${formatPence(total)} given` : undefined}
          accent={S.color}
        />
      }
    >
      {loading ? (
        <LoadingState accent={S.color} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="hand-holding-heart"
          title="Nothing yet"
          body="Donations you make to Shetland hubs and their fundraisers appear here."
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
          {rows.map(d => (
            <View key={d.id} style={styles.card}>
              <View style={styles.topRow}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.title} numberOfLines={2}>{d.hub_name ?? 'A Shetland hub'}</Text>
                  {d.campaign_title ? <Text style={styles.org} numberOfLines={1}>{d.campaign_title}</Text> : null}
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  {/* What they gave — not the hub's net after the fee. */}
                  <Text style={styles.amount}>{formatPence(d.amount_pence)}</Text>
                  {d.payment_method ? <Text style={styles.method}>{METHOD_LABEL[d.payment_method]}</Text> : null}
                </View>
              </View>

              {d.message ? <Text style={styles.message}>“{d.message}”</Text> : null}

              <View style={styles.footRow}>
                <View style={styles.donePill}><Text style={styles.donePillText}>Completed</Text></View>
                {d.is_anonymous ? (
                  <View style={styles.anonPill}><Text style={styles.anonPillText}>Anonymous</Text></View>
                ) : null}
                {d.gift_aid ? (
                  <View style={[styles.gaPill, { backgroundColor: S.color }]}><Text style={styles.gaPillText}>Gift Aid</Text></View>
                ) : null}
                <Text style={styles.date}>{fmtDate(d.created_at)}</Text>
              </View>
            </View>
          ))}
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
    borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: 10,
  },
  topRow:  { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  title:   { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  org:     { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 1 },
  amount:  { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  method:  { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted, marginTop: 2 },
  message: { fontSize: fontSize.sm, fontStyle: 'italic', color: colors.textSecondary,
             backgroundColor: colors.screenBackground, borderRadius: radius.md, paddingHorizontal: 10, paddingVertical: 8 },

  footRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8,
             borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 },
  donePill:     { backgroundColor: '#ecfdf5', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  donePillText: { fontSize: fontSize.xs, fontWeight: '800', color: '#047857' },
  anonPill:     { backgroundColor: '#f1f5f9', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  anonPillText: { fontSize: fontSize.xs, fontWeight: '800', color: '#475569' },
  gaPill:       { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  gaPillText:   { fontSize: fontSize.xs, fontWeight: '800', color: '#fff' },
  date:         { fontSize: fontSize.xs, fontWeight: '700', color: colors.textMuted, marginLeft: 'auto' },
});
