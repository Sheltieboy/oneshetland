/**
 * app/b/[slug].tsx
 *
 * Universal deep-link: https://oneshetland.com/b/<slug>
 * Resolves the business slug and forwards to the full business profile.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { fetchBusinessBySlug } from '@/lib/local-api';

const S = SECTIONS.local;

export default function BusinessSlugScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) { setError('No business link found.'); return; }
    fetchBusinessBySlug(slug)
      .then(biz => {
        if (!biz) { setError('This business profile isn\'t available.'); return; }
        router.replace({ pathname: '/local-business-detail', params: { id: biz.id } });
      })
      .catch(() => setError('Couldn\'t load this business. Please try again.'));
  }, [slug]);

  if (error) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Business not found</Text>
          <Text style={styles.errorSub}>{error}</Text>
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: S.color }]}
            onPress={() => router.replace('/(tabs)')}
            activeOpacity={0.85}
          >
            <Text style={styles.btnText}>Back to OneShetland</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.center}>
        <ActivityIndicator size="large" color={S.color} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:       { flex: 1, backgroundColor: colors.screenBackground },
  center:     { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: 12 },
  errorTitle: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary, textAlign: 'center' },
  errorSub:   { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 22 },
  btn:        { paddingVertical: 12, paddingHorizontal: 24, borderRadius: radius.md, marginTop: 8 },
  btnText:    { color: '#fff', fontSize: fontSize.sm, fontWeight: '800' },
});
