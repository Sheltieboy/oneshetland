/**
 * local-wallet.tsx — Local Wallet: balance, top-up, history, pay
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Alert, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useStripe } from '@stripe/stripe-react-native';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import {
  fetchWalletBalance, fetchWalletTransactions,
  startWalletTopUp, confirmWalletTopUp,
  formatPence,
  type WalletTransaction,
} from '@/lib/local-api';

const S = SECTIONS.local;

const TOP_UP_AMOUNTS = [
  { pence: 1000,  label: '£10' },
  { pence: 2000,  label: '£20' },
  { pence: 5000,  label: '£50' },
  { pence: 10000, label: '£100' },
];

export default function WalletScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();

  const [balance, setBalance]   = useState<number>(0);
  const [txs, setTxs]           = useState<WalletTransaction[]>([]);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [toppingUp, setToppingUp] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!profile) return;
    try {
      const [b, t] = await Promise.all([
        fetchWalletBalance(profile.id),
        fetchWalletTransactions(profile.id),
      ]);
      setBalance(b);
      setTxs(t);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile?.id]);

  useEffect(() => { load(); }, [load]);

  const handleTopUp = async (amountPence: number) => {
    // Pre-flight: card must be set up centrally in Me before topping up
    if (!profile?.has_payment_method) {
      Alert.alert(
        'Payment card needed',
        'Add a payment card in your account before topping up your wallet.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Add card', onPress: () => router.push('/(customer)/payment-setup') },
        ],
      );
      return;
    }

    setToppingUp(amountPence);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    try {
      const { clientSecret } = await startWalletTopUp(amountPence);
      const piId = clientSecret.split('_secret_')[0];

      const initRes = await initPaymentSheet({
        merchantDisplayName: 'OneShetland Local',
        paymentIntentClientSecret: clientSecret,
        applePay: { merchantCountryCode: 'GB' },
      });
      if (initRes.error) throw new Error(initRes.error.message);

      const sheetRes = await presentPaymentSheet();
      if (sheetRes.error) {
        if (sheetRes.error.code !== 'Canceled') {
          throw new Error(sheetRes.error.message);
        }
        return;
      }

      const { balance_pence } = await confirmWalletTopUp(piId);
      setBalance(balance_pence);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Topped up!', `New balance: ${formatPence(balance_pence)}`);
      load();
    } catch (e: any) {
      Alert.alert('Top-up failed', e.message ?? 'Try again');
    } finally {
      setToppingUp(null);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} hitSlop={12}>
          <FontAwesome5 name="chevron-left" size={14} color={S.color} />
          <Text style={[styles.backText, { color: S.color }]}>Local</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Wallet</Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={S.color} />}
      >
        {/* Balance card */}
        <View style={[styles.balanceCard, { backgroundColor: S.color }]}>
          <Text style={styles.balanceLabel}>Available balance</Text>
          <Text style={styles.balanceAmount}>{formatPence(balance)}</Text>
          <TouchableOpacity
            style={styles.payAtTillBtn}
            onPress={() => router.push('/local-pay')}
            activeOpacity={0.85}
          >
            <FontAwesome5 name="qrcode" size={13} color="#fff" />
            <Text style={styles.payAtTillText}>Pay at till</Text>
          </TouchableOpacity>
        </View>

        {/* Top-up section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Top up</Text>
          <Text style={styles.sectionHint}>Add credit to spend at participating businesses</Text>
          <View style={styles.topUpRow}>
            {TOP_UP_AMOUNTS.map(amt => (
              <TouchableOpacity
                key={amt.pence}
                style={[styles.topUpBtn, toppingUp === amt.pence && { opacity: 0.7 }]}
                onPress={() => handleTopUp(amt.pence)}
                disabled={!!toppingUp}
                activeOpacity={0.8}
              >
                {toppingUp === amt.pence
                  ? <ActivityIndicator color={S.color} size="small" />
                  : <Text style={[styles.topUpBtnText, { color: S.color }]}>{amt.label}</Text>
                }
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Transactions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Recent activity</Text>
          {loading ? (
            <ActivityIndicator color={S.color} style={{ marginTop: 20 }} />
          ) : txs.length === 0 ? (
            <View style={styles.emptyTx}>
              <Text style={styles.emptyTxText}>No transactions yet</Text>
            </View>
          ) : (
            <View style={styles.txList}>
              {txs.map(tx => <TransactionRow key={tx.id} tx={tx} />)}
            </View>
          )}
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function TransactionRow({ tx }: { tx: WalletTransaction }) {
  const isCredit = tx.amount_pence > 0;
  const config = {
    topup:    { icon: 'arrow-down', color: colors.success, label: 'Top-up' },
    spend:    { icon: 'arrow-up',   color: colors.error,   label: tx.business?.name ?? 'Payment' },
    cashback: { icon: 'gift',       color: S.color,        label: 'Cashback' },
    refund:   { icon: 'undo',       color: colors.warning, label: 'Refund' },
  }[tx.type] ?? { icon: 'circle', color: colors.textMuted, label: tx.type };

  return (
    <View style={styles.txRow}>
      <View style={[styles.txIcon, { backgroundColor: config.color + '18' }]}>
        <FontAwesome5 name={config.icon as any} size={11} color={config.color} solid />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.txLabel} numberOfLines={1}>{config.label}</Text>
        <Text style={styles.txDate}>
          {new Date(tx.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
          {tx.description && ` · ${tx.description}`}
        </Text>
      </View>
      <Text style={[styles.txAmount, { color: isCredit ? colors.success : colors.textPrimary }]}>
        {isCredit ? '+' : ''}{formatPence(tx.amount_pence)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: colors.screenBackground },
  scroll: { flex: 1 },
  content:{ paddingBottom: 40 },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 70 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  balanceCard: {
    margin: spacing.md, padding: spacing.lg, gap: 12,
    borderRadius: radius.xl,
    shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 12, elevation: 4,
  },
  balanceLabel:  { color: 'rgba(255,255,255,0.7)', fontSize: fontSize.xs, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1 },
  balanceAmount: { color: '#fff', fontSize: 40, fontWeight: '900' },
  payAtTillBtn:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: 'rgba(255,255,255,0.18)', paddingVertical: 12, borderRadius: radius.md, marginTop: 8 },
  payAtTillText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },

  section:      { paddingHorizontal: spacing.md, marginTop: spacing.lg },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary },
  sectionHint:  { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, marginBottom: 12 },

  topUpRow: { flexDirection: 'row', gap: 8 },
  topUpBtn: {
    flex: 1, paddingVertical: 14, borderRadius: radius.md,
    backgroundColor: S.light, borderWidth: 1.5, borderColor: S.color + '44',
    alignItems: 'center', justifyContent: 'center',
  },
  topUpBtnText: { fontSize: fontSize.sm, fontWeight: '900' },

  txList: { gap: 8 },
  txRow:  {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.md, padding: 12,
    borderWidth: 1, borderColor: colors.border,
  },
  txIcon:   { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  txLabel:  { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },
  txDate:   { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  txAmount: { fontSize: fontSize.sm, fontWeight: '900' },

  emptyTx: { padding: spacing.lg, alignItems: 'center' },
  emptyTxText: { fontSize: fontSize.sm, color: colors.textMuted },
});
