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
  View, Text, StyleSheet, ScrollView, RefreshControl, TouchableOpacity,
} from 'react-native';
import { router, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useAuth } from '@/context/AuthContext';
import { fetchMyPasses, formatPence, type MyPass, type PassStatus } from '@/lib/local-api';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';

const S = SECTIONS.local;

export default function MyPassesScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();

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

  // "Nothing yet" now means exactly that: never bought one. Somebody who has
  // used theirs up sees their history instead of being told it never happened.
  const active   = passes.filter(p => p.status === 'active');
  const previous = passes.filter(p => p.status !== 'active');

  return (
    <ScreenScaffold header={<ScreenHeader title="Passes & vouchers" accent={S.color} />}>
      {loading ? (
        <LoadingState accent={S.color} />
      ) : passes.length === 0 ? (
        <EmptyState
          icon="ticket-alt"
          title="Nothing yet"
          body="Day passes, class packs and vouchers you buy from Shetland businesses appear here."
          accent={S.color}
          variant="card"
          actionLabel="Browse the Marketplace"
          onAction={() => router.push('/(tabs)/local')}
        />
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={S.color}
            />
          }
        >
          <Text style={styles.groupLabel}>Active</Text>
          {active.length > 0
            ? active.map(p => <PassCard key={p.id} pass={p} />)
            : <Text style={styles.groupEmpty}>Nothing to use right now.</Text>}

          {previous.length > 0 && (
            <>
              <Text style={[styles.groupLabel, { marginTop: 18 }]}>Previous passes</Text>
              {previous.map(p => <PassCard key={p.id} pass={p} />)}
            </>
          )}
          <View style={{ height: 24 }} />
        </ScrollView>
      )}
    </ScreenScaffold>
  );
}

const STATUS_LABEL: Record<PassStatus, string> = {
  active:  'Active',
  used:    'Fully used',
  expired: 'Expired',
};

function PassCard({ pass }: { pass: MyPass }) {
  const expiresLabel = pass.expires_at
    ? `Expires ${formatDate(pass.expires_at)}`
    : 'No expiry';
  const daysToExpiry = pass.expires_at
    ? Math.ceil((new Date(pass.expires_at).getTime() - Date.now()) / 86_400_000)
    : null;
  const expiringSoon = pass.status === 'active' && daysToExpiry !== null && daysToExpiry >= 0 && daysToExpiry <= 7;

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
        {expiringSoon ? (
          <View style={styles.expirePill}>
            <Text style={styles.expirePillText}>
              {daysToExpiry === 0 ? 'Expires today' : `${daysToExpiry}d left`}
            </Text>
          </View>
        ) : pass.from_gift && (
          <View style={styles.giftPill}>
            <FontAwesome5 name="gift" size={9} color={S.color} solid />
            <Text style={styles.giftPillText}>Gift</Text>
          </View>
        )}
      </View>

      <View style={styles.cardBottom}>
        <View style={styles.metric}>
          {pass.status === 'active' ? (
            <>
              <Text style={styles.metricValue}>{pass.uses_remaining}</Text>
              <Text style={styles.metricLabel}>
                {pass.uses_remaining === 1 ? 'use left' : 'uses left'}
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.metricValueSmall}>{STATUS_LABEL[pass.status]}</Text>
              <Text style={styles.metricLabel}>
                Bought {formatDate(pass.created_at)}
                {pass.fully_used_at ? ` \u00B7 used up ${formatDate(pass.fully_used_at)}` : ''}
              </Text>
            </>
          )}
        </View>
        <View style={styles.metricSep} />
        <View style={styles.metric}>
          <Text style={styles.metricValueSmall}>{pass.status === 'active' ? expiresLabel : ' '}</Text>
          <Text style={styles.metricLabel}>{formatPence(pass.paid_amount_pence)} paid</Text>
        </View>
      </View>
      {/* Only an ACTIVE pass can be spent. A used or expired one is a receipt. */}
      {pass.status === 'active' && pass.uses_remaining > 0 && (
        <TouchableOpacity
          style={[styles.useBtn, { backgroundColor: S.color }]}
          onPress={() => router.push({ pathname: '/local-redeem', params: { kind: 'pass', ref_id: pass.id } })}
        >
          <FontAwesome5 name="qrcode" size={13} color="#fff" />
          <Text style={styles.useBtnText}>Use at till</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const styles = StyleSheet.create({
  scroll:  { flex: 1, backgroundColor: colors.screenBackground },
  content:{ padding: spacing.md, gap: 12 },

  groupLabel: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary, paddingHorizontal: spacing.xs },
  groupEmpty: { fontSize: fontSize.sm, color: colors.textMuted, paddingHorizontal: spacing.xs, marginTop: -4 },

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
  expirePill: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.full, backgroundColor: '#FEF3C7' },
  expirePillText: { fontSize: 10, color: '#B45309', fontWeight: '900', letterSpacing: 0.3 },

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
  useBtn: { marginTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radius.md, paddingVertical: 11 },
  useBtnText: { color: '#fff', fontWeight: '700', fontSize: fontSize.sm },
});
