/**
 * hub-donate.tsx
 * Donate to a hub campaign. Amount → optional message/anonymous → Gift Aid
 * declaration (charity hubs) → pay (destination charge to the hub).
 * Pass ?campaign=<id>.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, KeyboardAvoidingView, Platform, Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { track } from '@/lib/analytics';
import { useStripe } from '@stripe/stripe-react-native';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { useGoToSignIn } from '@/hooks/useGoToSignIn';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { Button } from '@/components/ui/Button';
import { useAuth } from '@/context/AuthContext';
import { ConfirmPaymentSheet } from '@/components/ConfirmPaymentSheet';
import { useAlert } from '@/components/BrandedAlert';
import { formatPence, fetchWalletBalance, walletCheckout } from '@/lib/local-api';
import { useAttemptId } from '@/hooks/useAttemptId';
import {
  fetchCampaign, fetchHub, startHubDonation, confirmHubDonation,
  type HubCampaign, type Hub, type GiftAidDeclaration,
} from '@/lib/hubs-api';

const S = SECTIONS.community;
const PRESETS = [500, 1000, 2000, 5000];

function tint(hex?: string | null): string {
  if (!hex || !/^#?[0-9a-fA-F]{6}/.test(hex)) return S.color;
  return hex.startsWith('#') ? hex : `#${hex}`;
}

export default function HubDonateScreen() {
  const { campaign: campaignId } = useLocalSearchParams<{ campaign: string }>();
  const router = useRouter();
  const goToSignIn = useGoToSignIn();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const { alert } = useAlert();

  const [campaign, setCampaign] = useState<HubCampaign | null>(null);
  const [hub, setHub] = useState<Hub | null>(null);
  const [loading, setLoading] = useState(true);

  const [amount, setAmount] = useState<number>(1000);
  const [customText, setCustomText] = useState('');
  const [message, setMessage] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [coverFees, setCoverFees] = useState(false);

  const [giftAidOn, setGiftAidOn] = useState(false);
  const [gaFirst, setGaFirst] = useState(profile?.full_name?.split(' ')[0] ?? '');
  const [gaLast, setGaLast] = useState(profile?.full_name?.split(' ').slice(1).join(' ') ?? '');
  const [gaAddress, setGaAddress] = useState('');
  const [gaPostcode, setGaPostcode] = useState('');

  const [confirming, setConfirming] = useState(false);
  const [paying, setPaying] = useState(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [donated, setDonated] = useState<number | null>(null);   // inline success: amount given

  const load = useCallback(async () => {
    if (!campaignId) return;
    try {
      const c = await fetchCampaign(campaignId);
      setCampaign(c);
      if (c) setHub(await fetchHub(c.hub_id));
    } finally { setLoading(false); }
  }, [campaignId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (profile?.id) fetchWalletBalance(profile.id).then(setWalletBalance).catch(() => {}); }, [profile?.id]);

  const accent = tint(hub?.brand_color);
  const effectiveAmount = customText ? Math.round(parseFloat(customText) * 100) || 0 : amount;
  const attemptId = useAttemptId(`${campaignId}|${effectiveAmount}|${coverFees}|${anonymous}|${message}|${giftAidOn}`);   // any change of mind is a different donation
  const coverPence = Math.round(effectiveAmount * 0.015) + 20; // ~Stripe fee
  const chargePence = effectiveAmount + (coverFees ? coverPence : 0);
  // Gift Aid is only offered when the hub is a charity AND has a charity number on file.
  const isCharity = !!hub?.is_charity && !!hub?.charity_number;

  // Canonicalise a UK postcode ("ze10aa" → "ZE1 0AA"); null if not valid.
  const normaliseUkPostcode = (raw: string): string | null => {
    const m = raw.toUpperCase().replace(/\s+/g, '').match(/^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/);
    return m ? `${m[1]} ${m[2]}` : null;
  };

  const buildGiftAid = (): GiftAidDeclaration | null => {
    if (!giftAidOn || !isCharity) return null;
    return { first_name: gaFirst.trim(), last_name: gaLast.trim(), address: gaAddress.trim(), postcode: normaliseUkPostcode(gaPostcode) ?? gaPostcode.trim() };
  };

  const validate = (): boolean => {
    if (effectiveAmount < 100) { alert({ title: 'Amount too small', message: 'Minimum donation is £1.' }); return false; }
    if (effectiveAmount > 1_000_000) { alert({ title: 'Amount too large', message: 'Maximum donation is £10,000.' }); return false; }
    if (giftAidOn && isCharity) {
      if (!gaFirst.trim() || !gaLast.trim() || !gaAddress.trim() || !gaPostcode.trim()) {
        alert({ title: 'Gift Aid details needed', message: 'Please complete your name, address and postcode for the Gift Aid declaration.' });
        return false;
      }
      if (!normaliseUkPostcode(gaPostcode)) {
        alert({ title: 'Check your postcode', message: 'Please enter a valid UK postcode so your Gift Aid can be claimed.' });
        return false;
      }
    }
    return true;
  };

  const onDonate = () => {
    if (!profile) { goToSignIn(`/hub-donate?campaign=${campaignId}`); return; }
    if (!validate()) return;
    if (campaign) {
      track('hub_donation_started', {
        hubId:      campaign.hub_id,
        objectType: 'campaign',
        objectId:   campaign.id,
      });
    }
    // Always open the confirm sheet — it offers wallet AND card. The card path
    // uses Stripe's Payment Sheet, which collects a card even when none is
    // saved, so a card-less but wallet-funded donor is no longer shut out.
    setConfirming(true);
  };

  // Pay the donation from the wallet (no card, no fee — hub gets the full amount).
  const runDonationWallet = async () => {
    if (!campaign || !profile) return;
    setPaying(true);
    try {
      const res = await walletCheckout({
        type: 'hub_donation',
        campaign_id: campaign.id,
        amount_pence: effectiveAmount,
        message: message.trim() || undefined,
        anonymous,
        gift_aid: buildGiftAid(),
      }, attemptId());
      if (typeof res?.balance_pence === 'number') setWalletBalance(res.balance_pence);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Show success INLINE — this modal screen can't present the root alert over
      // itself on iOS (it gets swallowed).
      setConfirming(false);
      // The ConfirmPaymentSheet stays mounted (just hidden) in the same tree, so
      // it animates closed cleanly — no unmount-while-visible, no frozen screen.
      setDonated(effectiveAmount);
    } catch (e: any) {
      alert({ title: 'Donation failed', message: e?.message ?? 'Please try again.' });
    } finally {
      setPaying(false);
      setConfirming(false);
    }
  };

  const runDonation = async () => {
    if (!campaign || !profile) return;
    setPaying(true);
    try {
      const useSaved = !!profile.has_payment_method;
      // Choices go with the intent, so a webhook that beats this screen still
      // records the donor's anonymity, message and Gift Aid.
      const start = await startHubDonation(campaign.id, effectiveAmount, attemptId(), {
        useSavedCard: useSaved, coverFees,
        message: message.trim() || undefined, anonymous, giftAid: buildGiftAid(),
      });
      if (!start.charged) {
        if (!start.clientSecret) throw new Error('Could not start payment.');
        const initRes = await initPaymentSheet({ merchantDisplayName: 'OneShetland', paymentIntentClientSecret: start.clientSecret, applePay: { merchantCountryCode: 'GB' } });
        if (initRes.error) throw new Error(initRes.error.message);
        const sheetRes = await presentPaymentSheet();
        if (sheetRes.error) { if (sheetRes.error.code !== 'Canceled') throw new Error(sheetRes.error.message); return; }
      }
      await confirmHubDonation(start.payment_intent_id);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Show success INLINE — this modal screen can't present the root alert over
      // itself on iOS (it gets swallowed).
      setConfirming(false);
      // The ConfirmPaymentSheet stays mounted (just hidden) in the same tree, so
      // it animates closed cleanly — no unmount-while-visible, no frozen screen.
      setDonated(effectiveAmount);
    } catch (e: any) {
      alert({ title: 'Donation failed', message: e?.message ?? 'Please try again.' });
    } finally { setPaying(false); setConfirming(false); }
  };

  if (loading) {
    return <SafeAreaView style={styles.safe} edges={['top']}><View style={styles.center}><ActivityIndicator color={S.color} /></View></SafeAreaView>;
  }
  if (!campaign || !hub) {
    return <SafeAreaView style={styles.safe} edges={['top']}><View style={styles.center}><Text style={styles.muted}>Campaign not found.</Text></View></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader title={donated != null ? 'Thank you' : 'Donate'} onClose={() => router.back()} accent={donated != null ? accent : S.color} />

      {donated != null ? (
        <View style={styles.successWrap}>
          <View style={[styles.successIcon, { backgroundColor: accent + '1A' }]}>
            <FontAwesome5 name="heart" size={28} color={accent} solid />
          </View>
          <Text style={styles.successTitle}>Thank you! 💜</Text>
          <Text style={styles.successSub}>
            Your {formatPence(donated)} donation to {hub.name} means a lot — it's been received.
          </Text>
          <TouchableOpacity
            style={[styles.successBtn, { backgroundColor: accent }]}
            onPress={() => router.back()}
            activeOpacity={0.85}
          >
            <Text style={styles.successBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      ) : (
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]} keyboardShouldPersistTaps="handled">
          <Text style={styles.campaign}>{campaign.title}</Text>
          <Text style={styles.sub}>{hub.name}</Text>

          <Text style={styles.label}>Amount</Text>
          <View style={styles.presetRow}>
            {PRESETS.map(p => {
              const active = !customText && amount === p;
              return (
                <TouchableOpacity key={p} style={[styles.preset, active && { backgroundColor: accent, borderColor: accent }]}
                  onPress={() => { setCustomText(''); setAmount(p); }} activeOpacity={0.85}>
                  <Text style={[styles.presetText, active && { color: '#fff' }]}>{formatPence(p)}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <TextInput style={styles.input} value={customText} onChangeText={t => setCustomText(t.replace(/[^0-9.]/g, ''))}
            placeholder="Or enter an amount (£)" placeholderTextColor={colors.textLight} keyboardType="decimal-pad" />

          <Text style={styles.label}>Message (optional)</Text>
          <TextInput style={[styles.input, styles.textarea]} value={message} onChangeText={setMessage}
            placeholder="Leave a few words of support…" placeholderTextColor={colors.textLight} multiline />

          <View style={styles.toggleRow}>
            <Text style={styles.toggleText}>Donate anonymously</Text>
            <Switch value={anonymous} onValueChange={setAnonymous} trackColor={{ true: accent }} />
          </View>

          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleText}>Cover the card fee (+{formatPence(coverPence)})</Text>
              <Text style={styles.gaSub}>So {hub.name} receives your full {formatPence(effectiveAmount)}.</Text>
            </View>
            <Switch value={coverFees} onValueChange={setCoverFees} trackColor={{ true: accent }} />
          </View>

          {isCharity ? (
            <View style={[styles.gaCard, giftAidOn && { borderColor: accent }]}>
              <View style={styles.toggleRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.gaTitle}>Add Gift Aid (+25%)</Text>
                  <Text style={styles.gaSub}>Boost your donation by 25% at no extra cost — if you're a UK taxpayer.</Text>
                </View>
                <Switch value={giftAidOn} onValueChange={setGiftAidOn} trackColor={{ true: accent }} />
              </View>
              {giftAidOn ? (
                <View style={{ gap: 8, marginTop: spacing.sm }}>
                  <View style={styles.gaNameRow}>
                    <TextInput style={[styles.input, { flex: 1 }]} value={gaFirst} onChangeText={setGaFirst} placeholder="First name" placeholderTextColor={colors.textLight} />
                    <TextInput style={[styles.input, { flex: 1 }]} value={gaLast} onChangeText={setGaLast} placeholder="Last name" placeholderTextColor={colors.textLight} />
                  </View>
                  <TextInput style={styles.input} value={gaAddress} onChangeText={setGaAddress} placeholder="Home address (house no. + street)" placeholderTextColor={colors.textLight} />
                  <TextInput style={styles.input} value={gaPostcode} onChangeText={setGaPostcode} placeholder="Postcode" placeholderTextColor={colors.textLight} autoCapitalize="characters" />
                  <Text style={styles.gaDeclaration}>
                    I am a UK taxpayer and want {hub.name} to reclaim Gift Aid on this donation. I understand if I pay less Income/Capital Gains Tax than the Gift Aid claimed on all my donations in the tax year, it's my responsibility to pay the difference.
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}

          <Button label={`Donate ${formatPence(chargePence)}`} icon="heart" color={accent} fullWidth loading={paying} disabled={paying} onPress={onDonate} style={styles.donateBtn} />
          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
      )}

      <ConfirmPaymentSheet
        visible={confirming}
        title="Confirm donation"
        itemName={`${campaign.title} · ${hub.name}`}
        lineItems={coverFees
          ? [{ label: 'Donation', amountPence: effectiveAmount }, { label: 'Card fee cover', amountPence: coverPence }]
          : [{ label: 'Donation', amountPence: effectiveAmount }]}
        totalPence={chargePence}
        payingWith="your saved card"
        policy={{ text: giftAidOn && isCharity ? 'Gift Aid adds 25% at no cost to you. Donations are non-refundable.' : 'Donations are non-refundable.' }}
        loading={paying}
        onConfirm={() => { setConfirming(false); runDonation(); }}
        onCancel={() => setConfirming(false)}
        walletBalancePence={coverFees ? null : walletBalance}
        onConfirmWallet={runDonationWallet}
        onTopUp={() => { setConfirming(false); router.push('/local-wallet'); }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { color: colors.textMuted, fontSize: fontSize.sm },

  content: { padding: spacing.md },
  campaign: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  sub: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2 },

  label: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary, marginBottom: 6, marginTop: spacing.lg },
  presetRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  preset: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: radius.md, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border },
  presetText: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: fontSize.md, color: colors.textPrimary },
  textarea: { minHeight: 70, textAlignVertical: 'top' },

  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.md, gap: 12 },
  toggleText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textSecondary },

  gaCard: { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1.5, borderColor: colors.border, padding: spacing.md, marginTop: spacing.md },
  gaTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  gaSub: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, lineHeight: 17 },
  gaNameRow: { flexDirection: 'row', gap: 8 },
  gaDeclaration: { fontSize: 11, color: colors.textMuted, lineHeight: 16, marginTop: 4 },

  donateBtn: { marginTop: spacing.xl },

  successWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.screenBackground },
  successIcon: {
    width: 76, height: 76, borderRadius: 38,
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.lg,
  },
  successTitle: { fontSize: fontSize.xl, fontWeight: '900', color: colors.textPrimary, textAlign: 'center' },
  successSub: {
    fontSize: fontSize.sm, color: colors.textSecondary, textAlign: 'center',
    paddingHorizontal: spacing.xl, lineHeight: 22, marginTop: spacing.sm,
  },
  successBtn: {
    marginTop: spacing.xl, borderRadius: radius.lg,
    paddingVertical: 15, paddingHorizontal: spacing.xxl, alignItems: 'center',
  },
  successBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },
});
