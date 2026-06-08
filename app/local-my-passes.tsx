/**
 * app/local-my-passes.tsx
 *
 * Full list of unit purchases the user owns — tickets, day passes, class
 * packs, vouchers. Surfaced from the "Passes & vouchers" section on the
 * My Wallet hub.
 *
 * Each card shows uses remaining + expiry. No "Show at till" code yet — that
 * verification flow is a separate feature (see Big-scope notes in the plan).
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { fetchMyPasses, formatPence, type MyPass } from '@/lib/local-api';

const S = SECTIONS.local;

export default function MyPassesScreen() {
  const router = useRouter();
  const { profile } = useAuth();

  const [passes, setPasses]       = useState<MyPass[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!profile?.id) { setLoading(false); return; }
    try {
      const rows = await fetchMyPasses(profile.id);
      setPasses(rows);
    } catch {
      setPasses([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile?.id]);

  useEffect(() => { load(); }, [load]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Passes & vouchers</Text>
        <View style={{ width: 70 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      ) : passes.length === 0 ? (
        <View style={styles.center}>
          <FontAwesome5 name="ticket-alt" size={40} color={colors.textLight} solid />
          <Text style={styles.emptyTitle}>Nothing yet</Text>
          <Text style={styles.emptySub}>
            Day passes, class packs and vouchers you buy from Shetland businesses appear here.
          </Text>
          <TouchableOpacity
            style={[styles.browseBtn, { backgroundColor: S.color }]}
            onPress={() => router.push('/(tabs)/local')}
            activeOpacity={0.85}
          >
            <Text style={styles.browseBtnText}>Browse the Marketplace</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={S.color}
            />
          }
        >
          {passes.map(p => <PassCard key={p.id} pass={p} />)}
          <View style={{ height: 24 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function PassCard({ pass }: { pass: MyPass }) {
  const expiresLabel = pass.expires_at
    ? `Expires ${formatDate(pass.expires_at)}`
    : 'No expiry';

  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <View style={[styles.cardIcon, { backgroundColor: S.color + '18' }]}>
          <FontAwesome5 name="ticket-alt" size={14} color={S.color} solid />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle} numberOfLines={1}>{pass.item_name ?? 'Pass'}</Text>
          {pass.business_name && (
            <Text style={styles.cardBiz} numberOfLines={1}>{pass.business_name}</Text>
          )}
        </View>
        {pass.from_gift && (
          <View style={styles.giftPill}>
            <FontAwesome5 name="gift" size={9} color={S.color} solid />
            <Text style={styles.giftPillText}>Gift</Text>
          </View>
        )}
      </View>

      <View style={styles.cardBottom}>
        <View style={styles.metric}>
          <Text style={styles.metricValue}>{pass.uses_remaining}</Text>
          <Text style={styles.metricLabel}>
            {pass.uses_remaining === 1 ? 'use left' : 'uses left'}
          </Text>
        </View>
        <View style={styles.metricSep} />
        <View style={styles.metric}>
          <Text style={styles.metricValueSmall}>{expiresLabel}</Text>
          <Text style={styles.metricLabel}>{formatPence(pass.paid_amount_pence)} paid</Text>
        </View>
      </View>
    </View>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.navy },
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content:{ padding: spacing.md, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: 12 },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 2,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 70 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, flex: 1, textAlign: 'center' },

  emptyTitle: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  emptySub:   { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 22 },
  browseBtn:  { paddingVertical: 12, paddingHorizontal: 22, borderRadius: radius.md, marginTop: 8 },
  browseBtnText: { color: '#fff', fontWeight: '800', fontSize: fontSize.sm },

  card: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, gap: 12,
  },
  cardTop:    { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardIcon:   { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  cardTitle:  { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  cardBiz:    { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  giftPill:   {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: radius.full,
    backgroundColor: S.color + '15', borderWidth: 1, borderColor: S.color + '35',
  },
  giftPillText: { fontSize: 10, color: S.color, fontWeight: '900', letterSpacing: 0.4 },

  cardBottom: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: colors.screenBackground, borderRadius: radius.md,
    paddingVertical: 10, paddingHorizontal: 12,
  },
  metric:      { flex: 1, gap: 2 },
  metricSep:   { width: 1, height: 28, backgroundColor: colors.border },
  metricValue: { fontSize: 20, fontWeight: '900', color: colors.textPrimary, lineHeight: 22 },
  metricValueSmall: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  metricLabel: { fontSize: 11, color: colors.textMuted, fontWeight: '600' },
});
