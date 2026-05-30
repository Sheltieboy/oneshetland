/**
 * app/t/[token].tsx
 *
 * Universal link target for NFC tiles encoded with https://oneshetland.com/t/{token}.
 * Just bounces straight to /nfc/[token] which does the real work — this keeps
 * the public URL short and on-brand.
 */

import { useEffect } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { View, ActivityIndicator } from 'react-native';
import { colors } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';

export default function TileRedirect() {
  const router = useRouter();
  const { token } = useLocalSearchParams<{ token: string }>();

  useEffect(() => {
    if (token) router.replace({ pathname: '/nfc/[token]', params: { token } });
  }, [token]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.navy, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator color={SECTIONS.local.color} size="large" />
    </View>
  );
}
