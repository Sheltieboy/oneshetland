/**
 * my-loyalty-code.tsx — the member's ONE card, and the only code a customer
 * should ever be asked to show. Staff scan it to add a stamp or points, hand
 * over a reward that's ready, or ask for a payment (which the customer then
 * approves on their own phone).
 *
 * It reads as "loyalty" in the file name for history's sake, but the card is
 * deliberately not loyalty-only: a second, payment-specific code at the counter
 * is exactly what caused staff to scan the wrong thing.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import QRCode from 'react-native-qrcode-svg';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { LoadingState } from '@/components/ui/LoadingState';
import { useAuth } from '@/context/AuthContext';
import { useAlert } from '@/components/BrandedAlert';
import { getMyMemberCode } from '@/lib/member-card';
import { APPLE_WALLET_SUPPORTED, addToAppleWallet } from '@/lib/apple-wallet';
import { GOOGLE_WALLET_SUPPORTED, addToGoogleWallet } from '@/lib/google-wallet';

const S = SECTIONS.local;

export default function MyLoyaltyCodeScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();
  const { alert } = useAlert();
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [wallet, setWallet] = useState(false);

  const addWallet = async (which: 'apple' | 'google') => {
    setWallet(true);
    try {
      if (which === 'apple') await addToAppleWallet(); else await addToGoogleWallet();
    } catch (e) {
      alert({ title: 'Wallet', message: e instanceof Error ? e.message : 'Could not add the pass.' });
    } finally { setWallet(false); }
  };

  useEffect(() => {
    if (!profile) return;
    getMyMemberCode(profile.id).then(setCode).catch(() => setCode(null)).finally(() => setLoading(false));
  }, [profile?.id]);

  return (
    <ScreenScaffold header={<ScreenHeader title="My member card" accent={S.color} onBack={() => router.back()} />}>
      {loading ? (
        <LoadingState accent={S.color} />
      ) : (
        <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]}>
          <View style={[styles.card, { borderColor: S.color }]}>
            <View style={[styles.badge, { backgroundColor: S.light }]}>
              <FontAwesome5 name="star" size={12} color={S.color} solid />
              <Text style={[styles.badgeText, { color: S.color }]}>SHOP LOCAL SHETLAND</Text>
            </View>
            <Text style={styles.name}>{profile?.display_name || profile?.full_name || 'Member'}</Text>

            <View style={styles.qrWrap}>
              {code ? <QRCode value={code} size={220} color="#0F1C26" /> : <Text style={styles.err}>Couldn’t load your code</Text>}
            </View>

            <Text style={styles.orLabel}>OR GIVE THIS CODE</Text>
            <Text style={[styles.code, { color: S.color }]}>{code ?? '—'}</Text>
          </View>

          <Text style={styles.help}>
            Show this at any taking-part Shetland shop. One card does everything — staff scan it to add a
            stamp or points, hand over a reward that’s ready, or ask for a payment from your wallet.
          </Text>

          <View style={styles.payNote}>
            <FontAwesome5 name="shield-alt" size={12} color={colors.textMuted} solid />
            <Text style={styles.payNoteText}>
              Nothing is charged by showing this. If a shop asks for a payment, it appears on your phone
              for you to approve first.
            </Text>
          </View>

          {(APPLE_WALLET_SUPPORTED || GOOGLE_WALLET_SUPPORTED) && (
            <TouchableOpacity style={styles.walletBtn} disabled={wallet} onPress={() => addWallet(APPLE_WALLET_SUPPORTED ? 'apple' : 'google')} activeOpacity={0.85}>
              {wallet
                ? <ActivityIndicator size="small" color="#fff" />
                : <><FontAwesome5 name="wallet" size={13} color="#fff" solid /><Text style={styles.walletBtnText}>Add to {APPLE_WALLET_SUPPORTED ? 'Apple' : 'Google'} Wallet</Text></>}
            </TouchableOpacity>
          )}

          <TouchableOpacity style={styles.linkBtn} onPress={() => router.push('/local-my-cards')} activeOpacity={0.85}>
            <FontAwesome5 name="layer-group" size={13} color={S.color} solid />
            <Text style={[styles.linkText, { color: S.color }]}>See my stamps &amp; points</Text>
            <FontAwesome5 name="chevron-right" size={11} color={S.color} />
          </TouchableOpacity>
        </ScrollView>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.md, paddingBottom: 100 },
  card: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 2, padding: 24, alignItems: 'center', gap: 12 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.full },
  badgeText: { fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  name: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  qrWrap: { padding: 12, backgroundColor: '#fff', borderRadius: radius.md },
  err: { color: colors.textMuted, fontSize: fontSize.sm },
  orLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 1.5, color: colors.textLight },
  code: { fontSize: 30, fontWeight: '900', letterSpacing: 4 },
  help: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 20, textAlign: 'center', paddingHorizontal: 8 },
  payNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: colors.offWhite, borderRadius: radius.md, padding: spacing.md },
  payNoteText: { flex: 1, fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 17 },
  walletBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#000', borderRadius: radius.lg, paddingVertical: 14 },
  walletBtnText: { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  linkBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: S.light, borderRadius: radius.lg, paddingVertical: 14 },
  linkText: { fontSize: fontSize.sm, fontWeight: '800' },
});
