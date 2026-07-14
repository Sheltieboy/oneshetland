/**
 * app/blocked-users.tsx
 *
 * Lets a user see everyone they've blocked and undo any block — the
 * "you can undo this later in your account settings" promise made by the
 * block-confirmation copy, and an Apple expectation for any app with a block
 * feature.
 *
 * Ids come from fetchBlockedIds(); names/avatars are looked up from `profiles`.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Image, ActivityIndicator, Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAlert } from '@/components/BrandedAlert';
import { useAppLayout } from '@/hooks/useAppLayout';
import { supabase } from '@/lib/supabase';
import { fetchBlockedIds, unblockUser } from '@/lib/moderation';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';

interface BlockedProfile {
  id: string;
  full_name: string | null;
  display_name: string | null;
  avatar_url: string | null;
}

function displayName(p: BlockedProfile): string {
  return p.display_name?.trim() || p.full_name?.trim() || 'OneShetland member';
}

export default function BlockedUsersScreen() {
  const router = useRouter();
  const { alert } = useAlert();
  const { screenWidth } = useAppLayout();

  const [people, setPeople] = useState<BlockedProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const ids = await fetchBlockedIds();
      if (ids.length === 0) {
        setPeople([]);
        return;
      }
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, display_name, avatar_url')
        .in('id', ids);
      // Keep any blocked ids whose profile row couldn't be read so the user can
      // still unblock them (fall back to a placeholder name).
      const byId = new Map<string, BlockedProfile>((data ?? []).map((p: BlockedProfile) => [p.id, p]));
      setPeople(ids.map((id) => byId.get(id) ?? { id, full_name: null, display_name: null, avatar_url: null }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleUnblock = (person: BlockedProfile) => {
    const who = displayName(person);
    alert({
      title: `Unblock ${who}?`,
      message: `You'll be able to see ${who}'s content again across OneShetland.`,
      icon: 'user-check',
      accent: colors.navy,
      actions: [
        { label: 'Cancel', style: 'cancel' },
        {
          label: 'Unblock', style: 'primary',
          onPress: async () => {
            setBusyId(person.id);
            try {
              await unblockUser(person.id);
              setPeople((prev) => prev.filter((p) => p.id !== person.id));
            } catch (err: any) {
              alert({ title: 'Could not unblock', message: err?.message ?? '' });
            } finally {
              setBusyId(null);
            }
          },
        },
      ],
    });
  };

  return (
    <ScreenScaffold
      header={
        <ScreenHeader
          title="Blocked users"
          onBack={() => (router.canGoBack() ? router.back() : router.replace('/account'))}
        />
      }
    >
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.navy} />
        </View>
      ) : people.length === 0 ? (
        <EmptyState
          icon="user-check"
          title="You haven't blocked anyone."
          body="When you block someone, they'll appear here so you can unblock them at any time."
        />
      ) : (
        <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]}>
          <Text style={styles.intro}>
            You won't see content from these people anywhere in OneShetland. Unblock anyone to undo.
          </Text>
          {people.map((person) => {
            const who = displayName(person);
            const busy = busyId === person.id;
            return (
              <View key={person.id} style={styles.row}>
                {person.avatar_url ? (
                  <Image source={{ uri: person.avatar_url }} style={styles.avatar} />
                ) : (
                  <View style={[styles.avatar, styles.avatarFallback]}>
                    <Text style={styles.avatarInitial}>{who[0]?.toUpperCase() ?? 'U'}</Text>
                  </View>
                )}
                <Text style={styles.name} numberOfLines={1}>{who}</Text>
                <Pressable
                  onPress={() => handleUnblock(person)}
                  disabled={busy}
                  style={({ pressed }) => [styles.unblockBtn, pressed && { opacity: 0.7 }, busy && { opacity: 0.5 }]}
                  hitSlop={6}
                >
                  {busy ? (
                    <ActivityIndicator size="small" color={colors.navy} />
                  ) : (
                    <>
                      <FontAwesome5 name="user-check" size={11} color={colors.navy} solid />
                      <Text style={styles.unblockText}>Unblock</Text>
                    </>
                  )}
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: spacing.lg, gap: spacing.sm },
  intro: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 19, marginBottom: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.offWhite },
  avatarFallback: { alignItems: 'center', justifyContent: 'center' },
  avatarInitial: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textMuted },
  name: { flex: 1, fontSize: fontSize.md, fontWeight: '700', color: colors.textPrimary },
  unblockBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: colors.navy,
    backgroundColor: colors.white,
    minWidth: 96,
    justifyContent: 'center',
  },
  unblockText: { fontSize: fontSize.sm, fontWeight: '800', color: colors.navy },
});
