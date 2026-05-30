/**
 * app/nfc/[token].tsx
 *
 * Universal-link target. When a customer taps a OneShetland NFC tile,
 * iOS/Android opens the app on this screen with the token in the URL.
 *
 * Flow:
 *   1. Request location permission
 *   2. Get current GPS
 *   3. Call local-nfc-stamp with token + coords
 *   4. Show success / error
 *
 * Universal link format: https://oneshetland.com/t/{token}
 * App deep link:          oneshetland-fetch://nfc/{token}
 */

import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  Animated, Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { collectStampViaNfc } from '@/lib/local-api';

const S = SECTIONS.local;

type Phase = 'requesting' | 'locating' | 'stamping' | 'success' | 'error';

interface Result {
  stamps: number;
  needed: number;
  reward_ready: boolean;
  business_name: string;
  business_id: string;
}

export default function NfcTapScreen() {
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token: string }>();
  const { profile, loading: authLoading } = useAuth();

  const [phase, setPhase]   = useState<Phase>('requesting');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [result, setResult] = useState<Result | null>(null);

  const successScale = useRef(new Animated.Value(0.7)).current;

  useEffect(() => {
    if (authLoading) return;
    if (!profile) {
      // Not signed in — bounce to root
      router.replace('/');
      return;
    }
    runNfcFlow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, profile?.id, token]);

  const runNfcFlow = async () => {
    if (!token) {
      setPhase('error');
      setErrorMsg('No tile token in the link.');
      return;
    }

    try {
      // Dynamic import so expo-location is only loaded on this screen
      const Location = await import('expo-location').catch(() => null);
      if (!Location) {
        setPhase('error');
        setErrorMsg('Location module not installed — run: npx expo install expo-location');
        return;
      }

      setPhase('requesting');
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setPhase('error');
        setErrorMsg('Location permission is needed to verify you\'re at the business.');
        return;
      }

      setPhase('locating');
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });

      setPhase('stamping');
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const data = await collectStampViaNfc(
        token,
        loc.coords.latitude,
        loc.coords.longitude,
      );

      setResult(data);
      setPhase('success');
      Animated.spring(successScale, { toValue: 1, friction: 5, useNativeDriver: true }).start();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      console.error(e);
      setPhase('error');
      setErrorMsg(e?.message ?? 'Something went wrong.');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={[styles.header, { borderBottomColor: S.color }]}>
        <TouchableOpacity style={styles.closeBtn} onPress={() => router.replace('/(tabs)/local')} hitSlop={12}>
          <FontAwesome5 name="times" size={16} color={S.color} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>OneShetland Local</Text>
        <View style={{ width: 32 }} />
      </View>

      <View style={styles.content}>

        {phase === 'requesting' && (
          <PhaseDisplay
            icon="map-marker-alt"
            iconColor={S.color}
            iconBg={S.light}
            title="Tap detected!"
            subtitle="Asking for your location to verify…"
            showSpinner
          />
        )}

        {phase === 'locating' && (
          <PhaseDisplay
            icon="location-arrow"
            iconColor={S.color}
            iconBg={S.light}
            title="Finding you…"
            subtitle="Hang on a sec"
            showSpinner
          />
        )}

        {phase === 'stamping' && (
          <PhaseDisplay
            icon="stamp"
            iconColor={S.color}
            iconBg={S.light}
            title="Stamping…"
            subtitle="Almost there"
            showSpinner
          />
        )}

        {phase === 'success' && result && (
          <Animated.View style={{ alignItems: 'center', gap: 14, transform: [{ scale: successScale }] }}>
            <View style={[styles.bigIcon, { backgroundColor: result.reward_ready ? colors.successLight : S.light }]}>
              <FontAwesome5
                name={result.reward_ready ? 'gift' : 'check'}
                size={40}
                color={result.reward_ready ? colors.success : S.color}
                solid
              />
            </View>
            <Text style={styles.successTitle}>
              {result.reward_ready ? '🎉 Reward unlocked!' : 'Stamp collected!'}
            </Text>
            <Text style={styles.successBusiness}>at {result.business_name}</Text>
            <View style={[styles.stampCount, { backgroundColor: S.light }]}>
              <Text style={[styles.stampCountNum, { color: S.color }]}>{result.stamps}</Text>
              <Text style={styles.stampCountTotal}> / {result.needed}</Text>
            </View>

            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: S.color }]}
                onPress={() => router.replace({ pathname: '/local-business-detail', params: { id: result.business_id } })}
                activeOpacity={0.85}
              >
                <Text style={styles.primaryBtnText}>View card</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => router.replace('/(tabs)/local')}
              >
                <Text style={styles.secondaryBtnText}>Done</Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        )}

        {phase === 'error' && (
          <View style={{ alignItems: 'center', gap: 14 }}>
            <View style={[styles.bigIcon, { backgroundColor: '#FEE2E2' }]}>
              <FontAwesome5 name="exclamation-triangle" size={36} color={colors.error} solid />
            </View>
            <Text style={styles.errorTitle}>Couldn't stamp</Text>
            <Text style={styles.errorBody}>{errorMsg}</Text>
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.primaryBtn, { backgroundColor: S.color }]}
                onPress={runNfcFlow}
                activeOpacity={0.85}
              >
                <Text style={styles.primaryBtnText}>Try again</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => router.replace('/(tabs)/local')}
              >
                <Text style={styles.secondaryBtnText}>Back to Local</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

      </View>
    </SafeAreaView>
  );
}

function PhaseDisplay({
  icon, iconColor, iconBg, title, subtitle, showSpinner,
}: {
  icon: string; iconColor: string; iconBg: string;
  title: string; subtitle: string; showSpinner?: boolean;
}) {
  return (
    <View style={{ alignItems: 'center', gap: 14 }}>
      <View style={[styles.bigIcon, { backgroundColor: iconBg }]}>
        <FontAwesome5 name={icon as any} size={36} color={iconColor} solid />
      </View>
      <Text style={styles.successTitle}>{title}</Text>
      <Text style={styles.successBusiness}>{subtitle}</Text>
      {showSpinner && <ActivityIndicator color={iconColor} style={{ marginTop: 4 }} />}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2,
  },
  closeBtn:    { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl },

  bigIcon: {
    width: 120, height: 120, borderRadius: 60,
    alignItems: 'center', justifyContent: 'center',
  },

  successTitle:    { fontSize: fontSize.xl, fontWeight: '900', color: colors.textPrimary, textAlign: 'center' },
  successBusiness: { fontSize: fontSize.md, color: colors.textMuted, fontWeight: '600', textAlign: 'center' },

  stampCount:      { flexDirection: 'row', alignItems: 'baseline', paddingHorizontal: 22, paddingVertical: 12, borderRadius: radius.full, marginTop: 4 },
  stampCountNum:   { fontSize: 32, fontWeight: '900' },
  stampCountTotal: { fontSize: fontSize.lg, color: colors.textMuted, fontWeight: '700' },

  errorTitle: { fontSize: fontSize.xl, fontWeight: '900', color: colors.error, textAlign: 'center' },
  errorBody:  { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 20, paddingHorizontal: 12 },

  actionRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  primaryBtn:   { paddingHorizontal: 22, paddingVertical: 12, borderRadius: radius.full },
  primaryBtnText:{ color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
  secondaryBtn: { paddingHorizontal: 18, paddingVertical: 12 },
  secondaryBtnText: { color: colors.textMuted, fontSize: fontSize.sm, fontWeight: '700' },
});
