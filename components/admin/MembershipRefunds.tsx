import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, TextInput,
  Modal, ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { supabase } from '@/lib/supabase';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

/**
 * Membership payments, for a OneShetland platform admin.
 *
 * Refunds used to be reachable only by pasting a PaymentIntent id, and the
 * payments screen listed deliveries alone — so a membership could not be found
 * at all. This lists them by the things a person actually knows: who bought it,
 * which hub, which tier, when, and how much.
 *
 * Every figure shown comes from our own ledger. Nothing here sends an amount
 * the server then trusts: the function re-reads the purchase and decides what
 * is still refundable.
 */

interface PurchaseRow {
  id: string;
  user_id: string | null;
  hub_name: string;
  tier_name: string;
  face_pence: number;
  fee_pence: number | null;
  total_pence: number | null;
  payment_method: 'card' | 'wallet' | 'unknown';
  payment_intent_id: string | null;
  refunded_pence: number;
  refund_state: 'none' | 'partial' | 'full';
  refunded_at: string | null;
  occurred_at: string;
  customer_name: string;
}

const STATE_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  none:    { bg: '#F0FDF4', text: '#166534', label: 'Paid' },
  partial: { bg: '#FFF7ED', text: '#92400E', label: 'Partly refunded' },
  full:    { bg: '#F5F3FF', text: '#5B21B6', label: 'Refunded' },
};

const gbp = (p: number) => `£${(p / 100).toFixed(2)}`;
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const totalOf = (r: PurchaseRow) => r.total_pence ?? r.face_pence + (r.fee_pence ?? 0);
const remainingOf = (r: PurchaseRow) => Math.max(0, totalOf(r) - (r.refunded_pence ?? 0));

export function MembershipRefunds() {
  const [rows, setRows] = useState<PurchaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [target, setTarget] = useState<PurchaseRow | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('hub_membership_purchases')
      .select('id, user_id, hub_name, tier_name, face_pence, fee_pence, total_pence, payment_method, payment_intent_id, refunded_pence, refund_state, refunded_at, occurred_at')
      .order('occurred_at', { ascending: false })
      .limit(200);
    if (error) { setRows([]); setLoading(false); return; }

    const list = (data ?? []) as Omit<PurchaseRow, 'customer_name'>[];
    const ids = [...new Set(list.map((r) => r.user_id).filter(Boolean) as string[])];
    const names = new Map<string, string>();
    if (ids.length) {
      const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', ids);
      for (const p of (profs ?? []) as { id: string; full_name: string | null }[]) {
        names.set(p.id, p.full_name || 'A member');
      }
    }
    setRows(list.map((r) => ({ ...r, customer_name: (r.user_id && names.get(r.user_id)) || 'A member' })));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const refundable = useMemo(() => rows.filter((r) => remainingOf(r) > 0).length, [rows]);

  if (loading) {
    return <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>;
  }

  return (
    <>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        <Text style={styles.summary}>
          {rows.length} membership {rows.length === 1 ? 'payment' : 'payments'} · {refundable} still refundable
        </Text>

        {rows.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No membership payments</Text>
            <Text style={styles.emptyBody}>Paid hub memberships appear here once someone buys one.</Text>
          </View>
        ) : rows.map((r) => {
          const st = STATE_STYLE[r.refund_state] ?? STATE_STYLE.none;
          const remaining = remainingOf(r);
          return (
            <View key={r.id} style={styles.card}>
              <View style={styles.cardTop}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.who} numberOfLines={1}>{r.customer_name}</Text>
                  <Text style={styles.what} numberOfLines={1}>{r.tier_name} · {r.hub_name}</Text>
                  <Text style={styles.when}>
                    {fmtDate(r.occurred_at)} · {r.payment_method === 'wallet' ? 'Wallet' : 'Card'}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.amount}>{gbp(totalOf(r))}</Text>
                  <View style={[styles.chip, { backgroundColor: st.bg }]}>
                    <Text style={[styles.chipText, { color: st.text }]}>{st.label}</Text>
                  </View>
                </View>
              </View>

              {r.refunded_pence > 0 ? (
                <Text style={styles.refunded}>
                  {gbp(r.refunded_pence)} refunded{r.refunded_at ? ` on ${fmtDate(r.refunded_at)}` : ''}
                  {remaining > 0 ? ` · ${gbp(remaining)} still refundable` : ''}
                </Text>
              ) : null}

              {remaining > 0 && r.payment_intent_id ? (
                <TouchableOpacity style={styles.refundBtn} onPress={() => setTarget(r)} activeOpacity={0.85}>
                  <Text style={styles.refundBtnText}>Refund…</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          );
        })}
        <View style={{ height: 48 }} />
      </ScrollView>

      <RefundModal row={target} onClose={() => setTarget(null)} onDone={() => { setTarget(null); load(); }} />
    </>
  );
}

/** Original total, already refunded, remaining — then an explicit confirmation. */
function RefundModal({ row, onClose, onDone }: {
  row: PurchaseRow | null; onClose: () => void; onDone: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setAmount(''); }, [row?.id]);
  if (!row) return null;

  const total = totalOf(row);
  const already = row.refunded_pence ?? 0;
  const remaining = remainingOf(row);
  // A wallet membership is returned by reversing the original ledger entry,
  // which has no amount — so it is all or nothing.
  const walletOnlyFull = row.payment_method === 'wallet';

  const submit = async (pence: number | null) => {
    const label = pence == null ? gbp(remaining) : gbp(pence);
    Alert.alert(
      pence == null ? 'Refund in full?' : 'Refund part of this payment?',
      `Refund ${label} to ${row.customer_name} for their ${row.tier_name} membership at ${row.hub_name}?`
      + (pence == null ? '\n\nThis ends their membership unless another payment still covers it.' : '\n\nTheir membership is not affected.'),
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Refund', style: 'destructive',
          onPress: async () => {
            setBusy(true);
            const { data, error } = await supabase.functions.invoke('refund-payment', {
              body: pence == null
                ? { payment_intent_id: row.payment_intent_id }
                : { payment_intent_id: row.payment_intent_id, amount_pence: pence },
            });
            setBusy(false);
            const err = (data as { error?: string } | null)?.error ?? error?.message;
            if (err) {
              let msg = err;
              try {
                const ctx = (error as { context?: { json?: () => Promise<{ error?: string }> } } | null)?.context;
                const body = await ctx?.json?.();
                if (body?.error) msg = body.error;
              } catch { /* keep the generic message */ }
              Alert.alert('Refund failed', msg);
              return;
            }
            Alert.alert('Refunded', `${label} has been refunded.`);
            onDone();
          },
        },
      ],
    );
  };

  const partial = Math.round(Number(amount) * 100);
  const partialValid = Number.isInteger(partial) && partial > 0 && partial <= remaining;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>Refund membership</Text>
          <Text style={styles.sheetWho}>{row.customer_name} · {row.tier_name} · {row.hub_name}</Text>

          <View style={styles.figures}>
            <Figure label="Original total" value={gbp(total)} />
            <Figure label="Already refunded" value={gbp(already)} />
            <Figure label="Remaining refundable" value={gbp(remaining)} strong />
          </View>

          <TouchableOpacity
            style={[styles.primary, busy && styles.disabled]} disabled={busy}
            onPress={() => submit(null)} activeOpacity={0.85}
          >
            {busy ? <ActivityIndicator color="#fff" /> : (
              <Text style={styles.primaryText}>Refund {gbp(remaining)} in full</Text>
            )}
          </TouchableOpacity>

          {walletOnlyFull ? (
            <Text style={styles.note}>
              Wallet memberships can only be refunded in full — the money is returned by reversing the
              original wallet payment, not by issuing a separate credit.
            </Text>
          ) : (
            <>
              <Text style={styles.orLabel}>or refund part of it</Text>
              <View style={styles.amountRow}>
                <Text style={styles.currency}>£</Text>
                <TextInput
                  style={styles.input}
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0.00"
                  placeholderTextColor={colors.textLight}
                  keyboardType="decimal-pad"
                  editable={!busy}
                />
                <TouchableOpacity
                  style={[styles.secondary, (!partialValid || busy) && styles.disabled]}
                  disabled={!partialValid || busy}
                  onPress={() => submit(partial)}
                  activeOpacity={0.85}
                >
                  <Text style={styles.secondaryText}>Refund</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.note}>
                A partial refund is recorded and shown to the member. It does not end their membership
                or shorten it.
              </Text>
            </>
          )}

          <TouchableOpacity onPress={onClose} disabled={busy} style={styles.cancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.figureRow}>
      <Text style={styles.figureLabel}>{label}</Text>
      <Text style={[styles.figureValue, strong && styles.figureStrong]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { paddingVertical: 48, alignItems: 'center' },
  content: { padding: spacing.md, gap: spacing.sm },
  summary: { fontSize: fontSize.sm, color: colors.textMuted, marginBottom: 4 },

  empty: { padding: spacing.xl, alignItems: 'center', gap: 6 },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary },
  emptyBody: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },

  card: { backgroundColor: colors.cardBackground, borderRadius: radius.lg, padding: spacing.md, gap: 8 },
  cardTop: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  who: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  what: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: 1 },
  when: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  amount: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  chip: { marginTop: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  chipText: { fontSize: 11, fontWeight: '800' },
  refunded: { fontSize: fontSize.xs, color: '#92400E', fontWeight: '700' },
  refundBtn: { alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8 },
  refundBtnText: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', padding: spacing.lg },
  sheet: { backgroundColor: colors.cardBackground, borderRadius: radius.xl, padding: spacing.lg, gap: 10 },
  sheetTitle: { fontSize: fontSize.xl, fontWeight: '800', color: colors.textPrimary },
  sheetWho: { fontSize: fontSize.sm, color: colors.textSecondary },
  figures: { gap: 6, marginTop: 6, marginBottom: 4 },
  figureRow: { flexDirection: 'row', justifyContent: 'space-between' },
  figureLabel: { fontSize: fontSize.sm, color: colors.textMuted },
  figureValue: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  figureStrong: { fontSize: fontSize.md, fontWeight: '800' },

  primary: { backgroundColor: colors.accent, borderRadius: 999, paddingVertical: 13, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '800', fontSize: fontSize.md },
  orLabel: { fontSize: fontSize.xs, color: colors.textMuted, textAlign: 'center', marginTop: 4 },
  amountRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  currency: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  input: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10, fontSize: fontSize.md, color: colors.textPrimary },
  secondary: { borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 10 },
  secondaryText: { fontWeight: '800', color: colors.textPrimary, fontSize: fontSize.sm },
  disabled: { opacity: 0.45 },
  note: { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 16 },
  cancel: { alignItems: 'center', paddingVertical: 10, marginTop: 2 },
  cancelText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textMuted },
});
