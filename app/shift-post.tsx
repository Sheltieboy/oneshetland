/**
 * app/shift-post.tsx — Post a shift, as a full-screen modal (the canonical
 * "create a thing" pattern, like Add a memory). Hosts the existing
 * PostShiftForm + the post-success boost sheet.
 */

import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { colors } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { PostShiftForm, BoostSheet } from '@/components/shifts/ShiftPostForm';
import { track } from '@/lib/analytics';

const S = SECTIONS.shifts;

export default function ShiftPostScreen() {
  const router = useRouter();
  const [boostId, setBoostId] = useState<string | null>(null);

  const close = () => { if (router.canGoBack()) router.back(); };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScreenHeader
        title="Post a shift"
        subtitle="Free to post — reach available local workers"
        accent={S.color}
        onClose={() => router.back()}
      />
      <View style={{ flex: 1 }}>
        <PostShiftForm onSuccess={(id) => { track('shift_posted', { objectType: 'shift', objectId: id }); setBoostId(id); }} />
      </View>

      {boostId ? (
        <BoostSheet
          shiftId={boostId}
          onDismiss={() => { setBoostId(null); close(); }}
          onBoosted={() => { setBoostId(null); close(); }}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
});
