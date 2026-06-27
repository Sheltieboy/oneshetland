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
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { useAlert } from '@/components/BrandedAlert';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { useGoToSignIn } from '@/hooks/useGoToSignIn';
import { supabase } from '@/lib/supabase';

const S = SECTIONS.local;

interface GiftPreview {
  id:               string;
  code:             string;
  kind:             'unit' | 'booking';
  status:           string;
  business_id:      string;
  business_name:    string;
  item_name:        string;
  purchaser_name:   string | null;
  message:          string | null;
  unit_item_id:     string | null;
  service_id:       string | null;
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

  // Public preview — runs even when not signed in, so the user can see what
  // they're about to claim before being asked to log in.
  useEffect(() => {
    (async () => {
      if (!code) { setErrorMsg('No gift code in the link.'); setLoading(false); return; }
      try {
        const { data, error } = await supabase
          .from('book_gifts')
          .select(`
            id, code, kind, status, business_id, unit_item_id, service_id,
            purchaser_name, message,
            business:local_businesses ( name ),
            unit_item:book_unit_items ( name ),
            service:book_services ( name )
          `)
          .eq('code', code)
          .maybeSingle();

        if (error || !data) {
          setErrorMsg('We couldn\'t find that gift. Check the code or ask the sender to resend.');
          return;
        }

        const businessName = (data.business as any)?.name ?? 'OneShetland';
        const itemName =
          data.kind === 'unit'
            ? ((data.unit_item as any)?.name ?? 'a unit')
            : ((data.service  as any)?.name ?? 'a booking');

        setGift({
          id:             data.id,
          code:           data.code,
          kind:           data.kind,
          status:         data.status,
          business_id:    data.business_id,
          business_name:  businessName,
          item_name:      itemName,
          purchaser_name: data.purchaser_name,
          message:        data.message,
          unit_item_id:   data.unit_item_id,
          service_id:     data.service_id,
        });
      } finally {
        setLoading(false);
      }
    })();
  }, [code]);

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

      const result = data as { kind: string; service_id: string | null; business_id: string };

      if (result.kind === 'booking' && result.service_id) {
        // Route into the slot picker with the gift_id flowing through.
        router.replace({
          pathname: '/local-book-business',
          params: {
            businessId: result.business_id,
            serviceId:  result.service_id,
            giftId:     gift.id,
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
