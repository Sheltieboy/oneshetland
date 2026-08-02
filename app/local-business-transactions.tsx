/**
 * local-business-transactions.tsx — the business's full money statement (app).
 * Mirrors the web Money & transactions ledger: one read-time UNION of every
 * in-platform money event (get_business_transactions RPC), period filter,
 * running totals, and CSV export via the share sheet.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Share } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import { colors, spacing, radius, fontSize } from '@/constants/theme';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { supabase } from '@/lib/supabase';

const ACCENT = '#7C3AED';
const money = (p: number) => `£${(p / 100).toFixed(2)}`;

interface Txn {
  occurred_at: string; direction: 'in' | 'out'; kind: string; description: string;
  counterparty: string; gross_pence: number; fee_pence: number; cashback_pence: number;
  net_pence: number; status: string; reference: string | null;
}

const KIND_LABEL: Record<string, string> = {
  wallet_payment: 'Wallet payment', pass_sale: 'Pass / pack', gift_sale: 'Gift',
  booking_deposit: 'Booking deposit', ticket_sale: 'Event tickets', product_sale: 'Shop order', boost: 'Boost',
};

type PresetKey = 'this_month' | 'last_month' | 'last_90' | 'this_year' | 'all';
const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'this_month', label: 'This month' }, { key: 'last_month', label: 'Last month' },
  { key: 'last_90', label: '90 days' }, { key: 'this_year', label: 'This year' }, { key: 'all', label: 'All' },
];

function rangeFor(key: PresetKey): { from: string | null; to: string | null } {
  const now = new Date(); const y = now.getFullYear(); const m = now.getMonth();
  switch (key) {
    case 'this_month': return { from: new Date(y, m, 1).toISOString(), to: null };
    case 'last_month': return { from: new Date(y, m - 1, 1).toISOString(), to: new Date(y, m, 1).toISOString() };
    case 'last_90':    return { from: new Date(now.getTime() - 90 * 86_400_000).toISOString(), to: null };
    case 'this_year':  return { from: new Date(y, 0, 1).toISOString(), to: null };
    case 'all':        return { from: null, to: null };
  }
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });

export default function BusinessTransactionsScreen() {
  const { businessId } = useLocalSearchParams<{ businessId?: string }>();
  const [preset, setPreset] = useState<PresetKey>('this_month');
  const [rows, setRows] = useState<Txn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (key: PresetKey) => {
    if (!businessId) return;
    setLoading(true); setError(null);
    try {
      const { from, to } = rangeFor(key);
      const { data, error } = await supabase.rpc('get_business_transactions', {
        p_business_id: businessId, p_from: from, p_to: to, p_limit: 5000,
      });
      if (error) throw error;
      setRows((data ?? []) as Txn[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load transactions');
      setRows([]);
    } finally { setLoading(false); }
  }, [businessId]);

  useEffect(() => { load(preset); }, [preset, load]);

  const totals = useMemo(() => {
    let grossIn = 0, fees = 0, cashback = 0, netIn = 0, costsOut = 0;
    for (const r of rows) {
      if (r.direction === 'in') { grossIn += r.gross_pence; fees += r.fee_pence; cashback += r.cashback_pence; netIn += r.net_pence; }
      else costsOut += r.gross_pence;
    }
    return { grossIn, fees, cashback, net: netIn - costsOut };
  }, [rows]);

  async function exportCsv() {
    try {
      const head = ['Date', 'Type', 'Description', 'Customer', 'Direction', 'Gross', 'Fee', 'Cashback', 'Net', 'Status', 'Reference'];
      const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
      const p = (n: number) => (n / 100).toFixed(2);
      const lines = rows.map((r) => [
        new Date(r.occurred_at).toISOString().slice(0, 10), KIND_LABEL[r.kind] ?? r.kind, r.description,
        r.counterparty, r.direction, p(r.gross_pence), p(r.fee_pence), p(r.cashback_pence), p(r.net_pence), r.status, r.reference ?? '',
      ].map((c) => esc(String(c))).join(','));
      const csv = [head.join(','), ...lines].join('\n');
      const uri = `${FileSystem.cacheDirectory}transactions-${preset}.csv`;
      await FileSystem.writeAsStringAsync(uri, csv);
      await Share.share({ url: uri, title: 'OneShetland transactions' });
    } catch { /* user cancelled or share unavailable */ }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader title="Money & transactions" onClose={() => router.back()} accent={ACCENT} />
      <ScrollView contentContainerStyle={styles.body}>
        {/* Period chips */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
          {PRESETS.map((pr) => (
            <TouchableOpacity key={pr.key} onPress={() => setPreset(pr.key)}
              style={[styles.chip, preset === pr.key && { backgroundColor: ACCENT, borderColor: ACCENT }]}>
              <Text style={[styles.chipText, preset === pr.key && { color: '#fff' }]}>{pr.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Totals */}
        <View style={styles.totalsGrid}>
          <Stat label="Money in" value={money(totals.grossIn)} />
          <Stat label="Fees" value={`− ${money(totals.fees)}`} />
          <Stat label="Cashback" value={`− ${money(totals.cashback)}`} />
          <Stat label="Net to you" value={money(totals.net)} accent />
        </View>

        <TouchableOpacity style={[styles.exportBtn, rows.length === 0 && { opacity: 0.4 }]} disabled={rows.length === 0} onPress={exportCsv}>
          <Text style={styles.exportText}>⬇  Export CSV</Text>
        </TouchableOpacity>

        {/* List */}
        {loading ? (
          <ActivityIndicator color={ACCENT} style={{ marginTop: 30 }} />
        ) : error ? (
          <Text style={styles.empty}>{error}</Text>
        ) : rows.length === 0 ? (
          <Text style={styles.empty}>No transactions in this period.</Text>
        ) : (
          <View style={styles.list}>
            {rows.map((r, i) => (
              <View key={i} style={styles.rowItem}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowType}>{KIND_LABEL[r.kind] ?? r.kind}</Text>
                  <Text style={styles.rowMeta}>{fmtDate(r.occurred_at)} · {r.counterparty}</Text>
                </View>
                <Text style={[styles.rowNet, { color: r.direction === 'out' ? '#dc2626' : '#16a34a' }]}>
                  {r.direction === 'out' ? `− ${money(r.gross_pence)}` : money(r.net_pence)}
                </Text>
              </View>
            ))}
          </View>
        )}

        <Text style={styles.footnote}>
          Covers wallet payments, pass &amp; gift sales, booking deposits, event tickets and boosts. Your subscription
          and bank payouts are managed in Stripe.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, accent && { color: ACCENT }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  body: { padding: spacing.md, gap: 14, paddingBottom: 60 },
  chipsRow: { gap: 8, paddingVertical: 2 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.full, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#fff' },
  chipText: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textSecondary },
  totalsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { flexGrow: 1, flexBasis: '46%', backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12 },
  statLabel: { fontSize: 11, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5 },
  statValue: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary, marginTop: 2 },
  exportBtn: { alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.border, borderRadius: radius.full, paddingHorizontal: 16, paddingVertical: 9, backgroundColor: '#fff' },
  exportText: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  list: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  rowItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowType: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  rowMeta: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  rowNet: { fontSize: fontSize.md, fontWeight: '900' },
  empty: { textAlign: 'center', color: colors.textMuted, fontSize: fontSize.sm, marginTop: 30 },
  footnote: { fontSize: 11, color: colors.textLight, lineHeight: 16 },
});
