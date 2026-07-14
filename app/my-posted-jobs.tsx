/**
 * app/my-posted-jobs.tsx — first-class entry to job management.
 *
 * Lists the Local businesses you own; each row opens that business's job
 * manager (business-jobs?businessId=…) to post / review roles. Mirrors the
 * web /jobs/manage index. If you own no businesses, we prompt you to register
 * one (jobs are always posted by a business).
 */

import React, { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Image,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAuth } from '@/context/AuthContext';
import { useAppLayout } from '@/hooks/useAppLayout';
import { supabase } from '@/lib/supabase';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingState } from '@/components/ui/LoadingState';

const S = SECTIONS.jobs;

type MyBusiness = { id: string; name: string; logo_url: string | null };

export default function MyPostedJobsScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const { screenWidth } = useAppLayout();

  const [businesses, setBusinesses] = useState<MyBusiness[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!profile?.id) { setLoading(false); setRefreshing(false); return; }
    try {
      const { data } = await supabase
        .from('local_businesses')
        .select('id,name,logo_url')
        .eq('owner_id', profile.id)
        .eq('is_active', true);
      setBusinesses((data ?? []) as MyBusiness[]);
    } catch {
      setBusinesses([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile?.id]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  return (
    <ScreenScaffold
      header={<ScreenHeader title="My posted jobs" accent={S.color} backStyle="chevron" onBack={() => router.back()} />}
    >
      {loading ? (
        <LoadingState accent={S.color} />
      ) : businesses.length === 0 ? (
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <EmptyState
            icon="store"
            title="No businesses yet"
            body="Jobs are posted by a business. Register one — it only takes a minute and works right across OneShetland."
            accent={S.color}
            variant="card"
            actionLabel="Register a business"
            onAction={() => { Haptics.selectionAsync(); router.push('/local-business-register'); }}
          />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={[styles.content, contentContainer(screenWidth)]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={S.color} />}
        >
          <Text style={styles.lede}>Choose a business to post and manage its jobs.</Text>

          {businesses.map(b => (
            <TouchableOpacity
              key={b.id}
              style={styles.row}
              onPress={() => { Haptics.selectionAsync(); router.push(`/business-jobs?businessId=${b.id}`); }}
              activeOpacity={0.85}
            >
              <View style={[styles.logo, { backgroundColor: S.light }]}>
                {b.logo_url
                  ? <Image source={{ uri: b.logo_url }} style={styles.logoImg} />
                  : <FontAwesome5 name="store" size={16} color={S.color} solid />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>{b.name}</Text>
                <Text style={styles.rowMeta}>Post &amp; manage jobs</Text>
              </View>
              <FontAwesome5 name="chevron-right" size={13} color={colors.textLight} />
            </TouchableOpacity>
          ))}

          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.sm },
  lede: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20, marginBottom: spacing.xs },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md,
  },
  logo: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  logoImg: { width: 44, height: 44 },
  rowTitle: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary },
  rowMeta: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
});
