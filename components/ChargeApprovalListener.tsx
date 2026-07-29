/**
 * ChargeApprovalListener — mounted app-wide. When a business scans this signed-in
 * customer's member card and requests a wallet payment (wallet_charge_requests
 * INSERT), this pops the consent prompt so they can Approve or Decline. No money
 * moves without their tap. Renders nothing until a request arrives.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, radius, fontSize } from '@/constants/theme';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import { respondToCharge, businessName } from '@/lib/member-card';

const ACCENT = '#0E7490';
const money = (p: number) => `£${(p / 100).toFixed(2)}`;

interface ActiveRequest { id: string; businessName: string; amountPence: number; expiresAt: number; }
type Row = { id: string; business_id: string; amount_pence: number; expires_at: string; status: string };

export function ChargeApprovalListener() {
  const { session } = useAuth();
  const userId = session?.user?.id;
  const [req, setReq] = useState<ActiveRequest | null>(null);
  const [phase, setPhase] = useState<'ask' | 'working' | 'done'>('ask');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [secsLeft, setSecsLeft] = useState(0);

  const activate = useCallback(async (row: Row) => {
    if (row.status !== 'pending') return;
    const expiresAt = new Date(row.expires_at).getTime();
    if (expiresAt < Date.now()) return;
    const name = await businessName(row.business_id).catch(() => 'A business');
    setReq({ id: row.id, businessName: name, amountPence: row.amount_pence, expiresAt });
    setPhase('ask'); setResult(null);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
  }, []);

  // Subscribe to new requests aimed at me + catch any already pending on load.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    (async () => {
      const { data: pending } = await supabase
        .from('wallet_charge_requests')
        .select('id, business_id, amount_pence, expires_at, status')
        .eq('customer_id', userId).eq('status', 'pending')
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (pending && !cancelled) activate(pending as Row);
    })();

    const channel = supabase
      .channel(`charge-approvals-${userId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'wallet_charge_requests', filter: `customer_id=eq.${userId}` },
        (payload) => activate(payload.new as Row))
      .subscribe();

    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [userId, activate]);

  // Countdown; auto-dismiss when the request lapses.
  useEffect(() => {
    if (!req || phase !== 'ask') return;
    const tick = () => {
      const left = Math.max(0, Math.round((req.expiresAt - Date.now()) / 1000));
      setSecsLeft(left);
      if (left <= 0) setReq(null);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [req, phase]);

  async function respond(decision: 'approve' | 'decline') {
    if (!req) return;
    setPhase('working');
    try {
      const r = await respondToCharge(req.id, decision);
      if (decision === 'decline') setResult({ ok: true, text: 'Declined — nothing was charged.' });
      else {
        setResult({ ok: true, text: `Paid ${money(req.amountPence)} to ${req.businessName}.${r.cashback_pence ? ` You earned ${money(r.cashback_pence)} cashback.` : ''}` });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }
      setPhase('done');
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : 'Something went wrong.' });
      setPhase('done');
    }
  }

  if (!req) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => { if (phase !== 'working') setReq(null); }}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          {phase === 'done' ? (
            <>
              <View style={[styles.badge, { backgroundColor: result?.ok ? ACCENT : '#e11d48' }]}>
                <Text style={styles.badgeText}>{result?.ok ? '✓' : '!'}</Text>
              </View>
              <Text style={styles.body}>{result?.text}</Text>
              <TouchableOpacity style={[styles.btn, { backgroundColor: ACCENT }]} onPress={() => setReq(null)}>
                <Text style={styles.btnText}>Done</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.title}>Approve payment?</Text>
              <Text style={styles.body}><Text style={{ fontWeight: '900', color: colors.textPrimary }}>{req.businessName}</Text> would like to charge your wallet</Text>
              <Text style={styles.amount}>{money(req.amountPence)}</Text>
              <Text style={styles.expiry}>Expires in {secsLeft}s</Text>
              <View style={styles.row}>
                <TouchableOpacity style={[styles.btn, styles.declineBtn]} disabled={phase === 'working'} onPress={() => respond('decline')}>
                  <Text style={[styles.btnText, { color: colors.textPrimary }]}>Decline</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.btn, { backgroundColor: ACCENT, flex: 1 }]} disabled={phase === 'working'} onPress={() => respond('approve')}>
                  {phase === 'working' ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Pay {money(req.amountPence)}</Text>}
                </TouchableOpacity>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 380, backgroundColor: '#fff', borderRadius: radius.lg, padding: 24, alignItems: 'center', gap: 6 },
  title: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  body: { fontSize: fontSize.md, color: colors.textSecondary, textAlign: 'center' },
  amount: { fontSize: 44, fontWeight: '900', color: colors.textPrimary, marginVertical: 4 },
  expiry: { fontSize: fontSize.sm, color: colors.textLight },
  badge: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  badgeText: { color: '#fff', fontSize: 26, fontWeight: '900' },
  row: { flexDirection: 'row', gap: 10, marginTop: 16, alignSelf: 'stretch' },
  btn: { borderRadius: radius.full, paddingVertical: 14, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', marginTop: 12 },
  declineBtn: { flex: 1, borderWidth: 1, borderColor: colors.border, backgroundColor: '#fff' },
  btnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
});
