/**
 * (admin)/business-claims.tsx
 * Admin review of directory claim requests. Approve (assigns ownership +
 * verifies via RPC), reject, and — for verified businesses — grant a
 * time-delayed Pro/Premium discount.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, RefreshControl, StyleSheet, TouchableOpacity,
} from 'react-native';
import { useAlert } from '@/components/BrandedAlert';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAppLayout } from '@/hooks/useAppLayout';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import {
  fetchClaims, approveClaim, rejectClaim, grantDiscount,
  type BusinessClaim, type ClaimStatus,
} from '@/lib/local-api';

const FILTERS: { key: ClaimStatus | 'all'; label: string }[] = [
  { key: 'pending',  label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'all',      label: 'All' },
];

const DISCOUNT_PRESETS: { tier: 'pro' | 'premium'; percent: number; label: string }[] = [
  { tier: 'pro',     percent: 25, label: 'Pro · 25% off, 1 year' },
  { tier: 'pro',     percent: 50, label: 'Pro · 50% off, 1 year' },
  { tier: 'premium', percent: 25, label: 'Premium · 25% off, 1 year' },
  { tier: 'premium', percent: 50, label: 'Premium · 50% off, 1 year' },
];

export default function BusinessClaimsScreen() {
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();
  const [filter, setFilter] = useState<ClaimStatus | 'all'>('pending');
  const [claims, setClaims] = useState<BusinessClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setClaims(await fetchClaims(filter === 'all' ? undefined : filter));
    } catch (e: any) {
      alert({ title: 'Could not load claims', message: e?.message ?? '' });
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true); await load(); setRefreshing(false);
  }, [load]);

  function confirmApprove(c: BusinessClaim) {
    alert({
      title: 'Approve claim?',
      message: `${c.contact_name ?? 'This person'} will become the owner of ${c.business?.name ?? 'this business'} and the listing will be marked verified.`,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        {
          label: 'Approve',
          style: 'primary',
          onPress: async () => {
            setActing(c.id);
            try {
              await approveClaim(c.id);
              alert({
                title: 'Approved ✅',
                message: `${c.business?.name ?? 'The business'} is now owned and verified.`,
                actions: [
                  { label: 'Grant discount', style: 'primary', onPress: () => offerDiscount(c) },
                  { label: 'Done', style: 'secondary' },
                ],
              });
              await load();
            } catch (e: any) {
              alert({ title: 'Could not approve', message: e?.message ?? '' });
            } finally { setActing(null); }
          },
        },
      ],
    });
  }

  function confirmReject(c: BusinessClaim) {
    alert({
      title: 'Reject claim?',
      message: `${c.business?.name ?? 'This claim'} will be marked rejected.`,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        {
          label: 'Reject', style: 'destructive',
          onPress: async () => {
            setActing(c.id);
            try { await rejectClaim(c.id); await load(); }
            catch (e: any) { alert({ title: 'Could not reject', message: e?.message ?? '' }); }
            finally { setActing(null); }
          },
        },
      ],
    });
  }

  function offerDiscount(c: BusinessClaim) {
    if (!c.business_id) return;
    alert({
      title: 'Grant discount',
      message: `Applies one week after today, valid for a year. Choose a tier and rate for ${c.business?.name ?? 'this business'}:`,
      actions: [
        ...DISCOUNT_PRESETS.map(p => ({
          label: p.label,
          style: 'primary' as const,
          onPress: async () => {
            try {
              await grantDiscount(c.business_id, { tier: p.tier, percent_off: p.percent });
              alert({ title: 'Discount granted 🎉', message: `${p.label} — applicable in 7 days.` });
            } catch (e: any) {
              alert({ title: 'Could not grant', message: e?.message ?? '' });
            }
          },
        })),
        { label: 'Cancel', style: 'cancel' as const },
      ],
    });
  }

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="Business claims"
          subtitle="Verify directory claims and grant discounts."
          accent={colors.accent}
        />
      }
    >
      <ScrollView
        contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        <View style={styles.tabs}>
          {FILTERS.map(f => (
            <TouchableOpacity
              key={f.key}
              style={[styles.tab, filter === f.key && styles.tabActive]}
              onPress={() => setFilter(f.key)}
              activeOpacity={0.8}
            >
              <Text style={[styles.tabText, filter === f.key && styles.tabTextActive]}>{f.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.body}>
          {loading ? (
            <LoadingState accent={colors.accent} />
          ) : claims.length === 0 ? (
            <EmptyState
              icon="check-circle"
              title="All caught up"
              body={`No ${filter === 'all' ? '' : filter} claims right now.`}
              accent={colors.accent}
              variant="card"
            />
          ) : (
            claims.map(c => (
              <Card key={c.id} style={styles.claimCard}>
                <View style={styles.rowBetween}>
                  <Text style={styles.bizName}>{c.business?.name ?? 'Unknown business'}</Text>
                  <View style={[styles.badge, badgeStyle(c.status)]}>
                    <Text style={styles.badgeText}>{c.status}</Text>
                  </View>
                </View>

                <View style={styles.divider} />

                <Row label="Claimant" value={c.contact_name ?? '—'} />
                <Row label="Email"    value={c.contact_email ?? '—'} />
                {c.contact_phone ? <Row label="Phone" value={c.contact_phone} /> : null}
                {c.role          ? <Row label="Role"  value={c.role} /> : null}
                {c.evidence ? (
                  <View style={styles.evidence}>
                    <Text style={styles.evidenceLabel}>How to verify</Text>
                    <Text style={styles.evidenceText}>{c.evidence}</Text>
                  </View>
                ) : null}
                <Text style={styles.date}>
                  Submitted {new Date(c.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                </Text>

                {c.status === 'pending' ? (
                  <View style={styles.actions}>
                    <Button label="Reject" variant="ghost" size="sm"
                      onPress={() => confirmReject(c)} disabled={acting === c.id} />
                    <Button label="Approve" size="sm"
                      onPress={() => confirmApprove(c)} loading={acting === c.id} />
                  </View>
                ) : c.status === 'approved' ? (
                  <View style={styles.actions}>
                    <Button label="Grant discount" variant="secondary" size="sm"
                      onPress={() => offerDiscount(c)} />
                  </View>
                ) : null}
              </Card>
            ))
          )}
        </View>
      </ScrollView>
    </ScreenScaffold>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

function badgeStyle(status: ClaimStatus) {
  switch (status) {
    case 'approved': return { backgroundColor: '#16A34A' };
    case 'rejected': return { backgroundColor: '#9CA3AF' };
    default:         return { backgroundColor: '#D97706' };
  }
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.xxl },

  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
  tab: {
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 999,
    backgroundColor: colors.offWhite, borderWidth: 1, borderColor: colors.border,
  },
  tabActive: { backgroundColor: colors.navy },
  tabText: { color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '700' },
  tabTextActive: { color: colors.white },

  body: { paddingHorizontal: spacing.lg, gap: spacing.md },

  claimCard: { padding: spacing.md, gap: 4 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  bizName: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, flex: 1 },
  badge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800', textTransform: 'capitalize' },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: 8 },

  detailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  detailLabel: { fontSize: fontSize.sm, color: colors.textMuted },
  detailValue: { fontSize: fontSize.sm, color: colors.textPrimary, fontWeight: '600', flexShrink: 1, textAlign: 'right', marginLeft: 12 },

  evidence: { marginTop: 8, backgroundColor: '#F3F4F6', borderRadius: radius.md, padding: 10 },
  evidenceLabel: { fontSize: 11, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 },
  evidenceText: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 3, lineHeight: 19 },

  date: { fontSize: fontSize.xs, color: colors.textLight, marginTop: 8 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: spacing.sm },
});
