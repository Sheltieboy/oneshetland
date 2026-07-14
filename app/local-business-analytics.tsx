/**
 * local-business-analytics.tsx — seller analytics (app side).
 *
 * Mirrors the web /business/[id]/manage/analytics page: a free teaser always,
 * the full dashboard behind the £10/mo analytics add-on (admins see full).
 * Data comes from the ownership-gated business_analytics RPC; revenue from the
 * ledgers.
 *
 * The in-app purchase path for the analytics add-on has been removed for store
 * compliance. When the add-on isn't active, the full section shows a neutral
 * locked "Premium feature" state. Already-subscribed (or admin) sellers see the
 * full dashboard as normal.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { supabase } from '@/lib/supabase';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const gbp = (p: number) => `£${((p ?? 0) / 100).toFixed(2)}`;
const n = (x: number) => (x ?? 0).toLocaleString('en-GB');

interface Analytics {
  has_addon: boolean;
  is_admin_view: boolean;
  basic: { profile_views: number; unique_viewers: number; followers: number; contacts: number };
  full: null | {
    views_by_day: { day: string; views: number }[];
    contacts_by_method: { method: string; count: number }[];
    saves: number; busiest_dow: { dow: number; views: number }[];
    bookings: number; booking_revenue_pence: number;
    unit_sales: number; unit_revenue_pence: number;
    tickets_sold: number; ticket_revenue_pence: number;
    loyalty_stamps: number; loyalty_rewards: number; offer_redemptions: number;
    job_applications: number; shift_applications: number;
  };
}

export default function BusinessAnalyticsScreen() {
  const { businessId } = useLocalSearchParams<{ businessId: string }>();
  const router = useRouter();
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!businessId) { setLoading(false); return; }
    try {
      const { data: d, error } = await supabase.rpc('business_analytics', { p_business_id: businessId, p_days: 30 });
      if (error) throw error;
      setData(d as Analytics);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => { load(); }, [load]);

  const b = data?.basic;
  const f = data?.full ?? null;
  const maxDay = Math.max(1, ...(f?.views_by_day ?? []).map(d => d.views));

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <FontAwesome5 name="chevron-left" size={16} color={colors.navy} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Analytics</Text>
        <View style={{ width: 32 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.navy} /></View>
      ) : !data ? (
        <View style={styles.center}><Text style={styles.muted}>Analytics aren&apos;t available right now.</Text></View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 48 }}>
          <Text style={styles.sub}>How people find and engage with your business — last 30 days.</Text>

          {data.is_admin_view && (
            <View style={styles.adminNote}><Text style={styles.adminNoteText}>Admin view — full analytics shown regardless of add-on.</Text></View>
          )}

          {/* Free teaser */}
          <View style={styles.statGrid}>
            <Stat label="Profile views" value={n(b!.profile_views)} />
            <Stat label="Unique viewers" value={n(b!.unique_viewers)} />
            <Stat label="Followers" value={n(b!.followers)} />
            <Stat label="Contact taps" value={n(b!.contacts)} />
          </View>

          {f ? (
            <>
              <Text style={styles.sectionTitle}>Profile views by day</Text>
              <View style={styles.card}>
                <View style={styles.barRow}>
                  {f.views_by_day.length === 0
                    ? <Text style={styles.muted}>No views yet.</Text>
                    : f.views_by_day.map(d => (
                        <View key={d.day} style={[styles.bar, { height: Math.max(2, (d.views / maxDay) * 110) }]} />
                      ))}
                </View>
              </View>

              <Text style={styles.sectionTitle}>Customer interest</Text>
              <View style={styles.card}>
                <Row label="Saved you" value={n(f.saves)} />
                <Row label="Tapped to contact" value={n(b!.contacts)} />
                {f.contacts_by_method.map(c => <Row key={c.method} label={`  ↳ ${c.method}`} value={n(c.count)} muted />)}
                <Row label="Offer redemptions" value={n(f.offer_redemptions)} />
                <Row label="Loyalty stamps given" value={n(f.loyalty_stamps)} />
                <Row label="Loyalty rewards claimed" value={n(f.loyalty_rewards)} />
              </View>

              <Text style={styles.sectionTitle}>Sales (from your orders)</Text>
              <View style={styles.statGrid}>
                <Stat label="Bookings" value={n(f.bookings)} />
                <Stat label="Booking deposits" value={gbp(f.booking_revenue_pence)} />
                <Stat label="Units sold" value={n(f.unit_sales)} />
                <Stat label="Unit revenue" value={gbp(f.unit_revenue_pence)} />
                <Stat label="Tickets sold" value={n(f.tickets_sold)} />
                <Stat label="Ticket revenue" value={gbp(f.ticket_revenue_pence)} />
                <Stat label="Job applications" value={n(f.job_applications)} />
                <Stat label="Shift applications" value={n(f.shift_applications)} />
              </View>
            </>
          ) : (
            <View style={styles.upsell}>
              <View style={styles.lockBadge}>
                <FontAwesome5 name="lock" size={22} color={colors.textMuted} />
              </View>
              <Text style={styles.upsellTitle}>Premium feature</Text>
              <Text style={styles.upsellBody}>
                Full analytics — views over time, your customer-interest funnel, busiest days,
                sales &amp; revenue, loyalty performance and applications — aren&apos;t included on
                your current plan.
              </Text>
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}
function Row({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, muted && { color: colors.textMuted }]}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: colors.border },
  backBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  muted: { color: colors.textMuted, fontSize: fontSize.sm },
  sub: { color: colors.textMuted, fontSize: fontSize.sm, marginBottom: spacing.md },
  adminNote: { backgroundColor: '#FEF3C7', borderRadius: radius.md, padding: spacing.sm, marginBottom: spacing.md },
  adminNoteText: { color: '#92400E', fontSize: fontSize.xs },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  stat: { width: '47.5%', backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  statValue: { fontSize: 22, fontWeight: '800', color: colors.textPrimary },
  statLabel: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.4 },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, marginTop: spacing.lg, marginBottom: spacing.sm },
  card: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  barRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 120 },
  bar: { flex: 1, backgroundColor: colors.navy, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  rowLabel: { fontSize: fontSize.sm, color: colors.textPrimary },
  rowValue: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  upsell: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.xl, alignItems: 'center', marginTop: spacing.md },
  lockBadge: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.screenBackground, alignItems: 'center', justifyContent: 'center' },
  upsellTitle: { fontSize: fontSize.xl, fontWeight: '800', color: colors.textPrimary, marginTop: spacing.sm },
  upsellBody: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', marginTop: spacing.sm },
});
