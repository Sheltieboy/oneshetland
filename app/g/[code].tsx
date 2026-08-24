/**
 * app/g/[code].tsx
 *
 * Universal-link target for gift claims. Recipient taps the link in their
 * email → iOS/Android opens the app on this screen with the short gift code.
 *
 * Flow:
 *   1. If not signed in, bounce to sign-in (preserving the code in params).
 *   2. Fetch a public preview of the gift (item name, business, message).
 *   3. Show "Claim" button.
 *   4. Tap → claim_gift RPC:
 *        • unit gift    → server spawns the unit purchase row, status='used'
 *        • booking gift → status='claimed', recipient routed to slot picker
 *
 * Universal link format: https://oneshetland.com/g/<code>
 * App deep link:          oneshetland-fetch://g/<code>
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { useAlert } from '@/components/BrandedAlert';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import {
  fetchGiftEligibility, sendGiftRecipientCode, confirmGiftRecipientCode,
} from '@/lib/local-api';
import { useGoToSignIn } from '@/hooks/useGoToSignIn';
import { supabase } from '@/lib/supabase';
import { track } from '@/lib/analytics';

const S = SECTIONS.local;

/**
 * What the signed-out preview shows. Narrower than the book_gifts row on
 * purpose: no id, no business_id, no service_id, no purchaser identity, no
 * payment field. claim_gift() returns the ids the claim flow needs, so the
 * anonymous preview never has to carry them.
 */
interface GiftPreview {
  code:             string;
  kind:             'unit' | 'booking';
  status:           string;
  business_name:    string;
  item_name:        string;
  purchaser_name:   string | null;
  message:          string | null;
  expires_at:       string | null;
}

export default function ClaimGiftScreen() {
  const router = useRouter();
  const { code } = useLocalSearchParams<{ code: string }>();
  const { profile, loading: authLoading, session } = useAuth();
  const { alert } = useAlert();
  const goToSignIn = useGoToSignIn();

  const [gift, setGift]       = useState<GiftPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);

  // Recipient identity: decides whether this account may claim, or must first
  // prove control of the address the gift was sent to.
  const [eligibility, setEligibility] = useState<{ state: string; masked_email: string | null } | null>(null);
  const [verifyStep, setVerifyStep] = useState<'idle' | 'sending' | 'code'>('idle');
  const [verifyCode, setVerifyCode] = useState('');
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  // Public preview — runs even when not signed in, so the user can see what
  // they're about to claim before being asked to log in.
  useEffect(() => {
    (async () => {
      if (!code) { setErrorMsg('No gift code in the link.'); setLoading(false); return; }
      try {
        // get_public_gift_preview, not a table read: book_gifts has no public
        // SELECT policy and must not get one. Possession of the 14-character
        // code is the access rule, and only this RPC may act on it.
        const { data, error } = await supabase
          .rpc('get_public_gift_preview', { p_code: code });

        const row = (data as GiftPreview[] | null)?.[0];
        if (error || !row) {
          if (error) console.error('[gift-preview] lookup failed:', error.message);
          setErrorMsg('We couldn\'t find that gift. Check the code or ask the sender to resend.');
          return;
        }

        setGift({ ...row, code });
        setEligibility(await fetchGiftEligibility(code));
      } finally {
        setLoading(false);
      }
    })();
  }, [code]);

  const refreshEligibility = useCallback(async () => {
    setEligibility(await fetchGiftEligibility(code));
  }, [code]);

  const startVerify = useCallback(async () => {
    setVerifyError(null);
    setVerifyStep('sending');
    try {
      await sendGiftRecipientCode(code);
      setVerifyStep('code');
    } catch (e: any) {
      setVerifyStep('idle');
      setVerifyError(e?.message ?? "Couldn't send the code.");
    }
  }, [code]);

  const submitVerify = useCallback(async () => {
    setVerifyBusy(true);
    setVerifyError(null);
    try {
      const r = await confirmGiftRecipientCode(code, verifyCode);
      if (r.ok) {
        await refreshEligibility();
        setVerifyStep('idle');
        setVerifyCode('');
      } else if (r.error === 'verification_locked') {
        setVerifyError('Too many wrong codes. Send a new one to try again.');
      } else if (r.error === 'verification_expired') {
        setVerifyError('That code has expired. Send a new one.');
      } else if (r.error === 'verification_not_found') {
        setVerifyError('Send a code first, then enter it here.');
      } else {
        const left = r.attempts_left;
        setVerifyError(`That code isn't right.${typeof left === 'number' ? ` ${left} ${left === 1 ? 'try' : 'tries'} left.` : ''}`);
      }
    } catch (e: any) {
      setVerifyError(e?.message ?? "Couldn't check that code.");
    } finally {
      setVerifyBusy(false);
    }
  }, [code, verifyCode, refreshEligibility]);

  const claim = useCallback(async () => {
    if (!gift) return;
    if (!session) {
      goToSignIn();
      return;
    }
    setClaiming(true);
    try {
      const { data, error } = await supabase.rpc('claim_gift', { p_code: gift.code });
      if (error) throw error;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      const result = data as { kind: string; service_id: string | null; business_id: string; gift_id: string };
      track('gift_claimed', { businessId: result.business_id, props: { kind: result.kind } });

      if (result.kind === 'booking' && result.service_id) {
        // Route into the slot picker with the gift_id flowing through.
        router.replace({
          pathname: '/local-book-business',
          params: {
            businessId: result.business_id,
            serviceId:  result.service_id,
            giftId:     result.gift_id,
          },
        });
      } else {
        // Unit gifts are done — purchase already spawned by the RPC.
        setGift({ ...gift, status: 'used' });
      }
    } catch (e: any) {
      const code = e?.message ?? '';
      const friendly =
        code.includes('gift_already_claimed') ? 'This gift has already been claimed by someone else.'
        : code.includes('gift_expired')       ? 'This gift has expired.'
        : code.includes('gift_not_paid')      ? 'The sender hasn\'t completed payment yet.'
        : code.includes('gift_cancelled')     ? 'This gift was cancelled.'
        : code.includes('gift_not_found')     ? 'We couldn\'t find that gift code.'
        : code.includes('auth_required')      ? 'Please sign in to claim this gift.'
        : 'Couldn\'t claim the gift. Please try again.';
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      alert({ title: 'Claim failed', message: friendly });
    } finally {
      setClaiming(false);
    }
  }, [gift, session, router, goToSignIn]);

  if (loading || authLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}><ActivityIndicator size="large" color={S.color} /></View>
      </SafeAreaView>
    );
  }

  if (errorMsg || !gift) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}>
          <View style={[styles.iconCircle, { backgroundColor: colors.border }]}>
            <FontAwesome5 name="exclamation" size={28} color={colors.textMuted} />
          </View>
          <Text style={styles.errorTitle}>Gift not found</Text>
          <Text style={styles.errorSub}>{errorMsg ?? 'Try the link again from your email.'}</Text>
          <TouchableOpacity
            style={[styles.primaryBtn, { backgroundColor: S.color }]}
            onPress={() => router.replace('/(tabs)')}
            activeOpacity={0.85}
          >
            <Text style={styles.primaryBtnText}>Back to OneShetland</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const alreadyUsed = gift.status === 'used';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.content}>

        <View style={[styles.iconCircle, { backgroundColor: S.light }]}>
          <FontAwesome5 name="gift" size={32} color={S.color} solid />
        </View>

        <Text style={styles.preLabel}>You've got a gift</Text>
        <Text style={styles.itemName}>{gift.item_name}</Text>
        <Text style={styles.bizName}>at {gift.business_name}</Text>

        {gift.purchaser_name && (
          <Text style={styles.fromLine}>From <Text style={{ fontWeight: '900' }}>{gift.purchaser_name}</Text></Text>
        )}

        {gift.message && (
          <View style={styles.messageBox}>
            <Text style={styles.messageText}>&ldquo;{gift.message}&rdquo;</Text>
          </View>
        )}

        <View style={{ flex: 1 }} />

        {alreadyUsed ? (
          <View style={styles.usedBanner}>
            <FontAwesome5 name="check-circle" size={14} color={S.color} solid />
            <Text style={styles.usedText}>This gift has been claimed.</Text>
          </View>
        ) : !session ? (
          <>
            <Text style={styles.hint}>Sign in to claim it to your account.</Text>
            <TouchableOpacity
              style={[styles.primaryBtn, { backgroundColor: S.color }]}
              onPress={() => goToSignIn()}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryBtnText}>Sign in to claim</Text>
            </TouchableOpacity>
          </>
        ) : eligibility?.state === 'gift_already_claimed' ? (
          <View style={styles.usedBanner}>
            <FontAwesome5 name="check-circle" size={14} color={S.color} solid />
            <Text style={styles.usedText}>This gift has already been claimed.</Text>
          </View>
        ) : eligibility?.state === 'verification_required' ? (
          /* Signed in under a different address. We never say whether that
             address has an account — only that it isn't this one. */
          <View style={styles.verifyBox}>
            <Text style={styles.verifyLead}>
              This gift was sent to <Text style={styles.verifyEmail}>{eligibility.masked_email ?? 'another email address'}</Text>.
              You&rsquo;re signed in with a different email.
            </Text>
            <Text style={styles.verifyBody}>
              If it&rsquo;s for you, verify that address and we&rsquo;ll add the gift to the account
              you&rsquo;re using now. You won&rsquo;t need a second account.
            </Text>

            {verifyStep !== 'code' ? (
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: S.color }, verifyStep === 'sending' && { opacity: 0.7 }]}
                onPress={startVerify}
                disabled={verifyStep === 'sending'}
                activeOpacity={0.85}
              >
                <Text style={styles.primaryBtnText}>
                  {verifyStep === 'sending' ? 'Sending…' : 'Verify recipient email'}
                </Text>
              </TouchableOpacity>
            ) : (
              <>
                <TextInput
                  value={verifyCode}
                  onChangeText={(t) => setVerifyCode(t.toUpperCase())}
                  maxLength={8}
                  autoCapitalize="characters"
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  placeholder="ABCD2345"
                  placeholderTextColor={colors.textMuted}
                  style={styles.codeInput}
                  accessibilityLabel="Code from the gift email"
                />
                <TouchableOpacity
                  style={[styles.primaryBtn, { backgroundColor: S.color },
                          (verifyBusy || verifyCode.trim().length < 8) && { opacity: 0.7 }]}
                  onPress={submitVerify}
                  disabled={verifyBusy || verifyCode.trim().length < 8}
                  activeOpacity={0.85}
                >
                  <Text style={styles.primaryBtnText}>{verifyBusy ? 'Checking…' : 'Confirm code'}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={startVerify} activeOpacity={0.7}>
                  <Text style={styles.verifyLink}>Send a new code</Text>
                </TouchableOpacity>
              </>
            )}

            {!!verifyError && <Text style={styles.verifyError}>{verifyError}</Text>}

            <TouchableOpacity onPress={() => goToSignIn()} activeOpacity={0.7}>
              <Text style={styles.verifyLink}>Or switch account</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.primaryBtn, { backgroundColor: S.color }, claiming && { opacity: 0.7 }]}
            onPress={claim}
            disabled={claiming}
            activeOpacity={0.85}
          >
            {claiming
              ? <ActivityIndicator color="#fff" />
              : <Text style={styles.primaryBtnText}>
                  {gift.kind === 'booking' ? 'Claim & pick a time' : 'Claim my gift'}
                </Text>}
          </TouchableOpacity>
        )}

        <TouchableOpacity
          style={styles.secondaryBtn}
          onPress={() => router.replace('/(tabs)')}
          activeOpacity={0.85}
        >
          <Text style={[styles.secondaryBtnText, { color: colors.textMuted }]}>Not now</Text>
        </TouchableOpacity>

      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  verifyBox:   { backgroundColor: colors.screenBackground, borderRadius: radius.lg, padding: spacing.md, gap: 10, width: '100%' },
  verifyLead:  { fontSize: fontSize.sm, color: colors.textPrimary, lineHeight: 20 },
  verifyEmail: { fontWeight: '800' },
  verifyBody:  { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 18 },
  verifyLink:  { fontSize: fontSize.xs, color: colors.textSecondary, textDecorationLine: 'underline', textAlign: 'center', paddingVertical: 6 },
  verifyError: { fontSize: fontSize.xs, color: '#E11D48', textAlign: 'center' },
  codeInput:   {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    backgroundColor: '#fff', paddingVertical: 12, textAlign: 'center',
    fontSize: fontSize.lg, letterSpacing: 6, fontWeight: '800', color: colors.textPrimary,
  },

  safe:    { flex: 1, backgroundColor: colors.navy },
  content: { flex: 1, alignItems: 'center', padding: spacing.lg, paddingTop: spacing.xl, gap: 12 },
  center:  { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: 14 },

  iconCircle: {
    width: 96, height: 96, borderRadius: 48,
    alignItems: 'center', justifyContent: 'center', marginTop: 12,
  },

  preLabel: { fontSize: 12, color: colors.textMuted, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1.5, marginTop: 8 },
  itemName: { fontSize: 26, fontWeight: '900', color: colors.textPrimary, textAlign: 'center', paddingHorizontal: 12 },
  bizName:  { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '600' },
  fromLine: { fontSize: fontSize.sm, color: colors.textPrimary, marginTop: 6 },

  messageBox: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: spacing.md, marginTop: 12,
    borderLeftWidth: 4, borderLeftColor: '#12B3D6',
    width: '100%',
  },
  messageText: { fontSize: fontSize.sm, color: colors.textPrimary, fontStyle: 'italic', lineHeight: 22 },

  hint: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },

  primaryBtn: {
    paddingVertical: 14, paddingHorizontal: 24, borderRadius: radius.md,
    alignItems: 'center', alignSelf: 'stretch',
  },
  primaryBtnText: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  secondaryBtn:    { alignItems: 'center', paddingVertical: 10 },
  secondaryBtnText:{ fontSize: fontSize.sm, fontWeight: '700' },

  usedBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 14, paddingHorizontal: 18, borderRadius: radius.md,
    backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border,
    alignSelf: 'stretch', justifyContent: 'center',
  },
  usedText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textPrimary },

  errorTitle: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary },
  errorSub:   { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', paddingHorizontal: 12, lineHeight: 22 },
});
