/**
 * app/my-work.tsx — the "My work" management screen (Account → Work).
 * Mirrors the web /work hub: your profile, applications and postings in one
 * place. Browsing & applying live on the Work tab, not here.
 */

import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius, contentContainer } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { useAppLayout } from '@/hooks/useAppLayout';
import { ScreenScaffold } from '@/components/ui/ScreenScaffold';
import { ScreenHeader } from '@/components/ui/ScreenHeader';

const S = SECTIONS.jobs;

type Item = { icon: string; label: string; sublabel: string; route: string };

const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: 'Looking for work',
    items: [
      { icon: 'user-tie',        label: 'My work profile / CV', sublabel: 'What employers see when you apply', route: '/work-profile' },
      { icon: 'clipboard-list',  label: 'My job applications',   sublabel: "Jobs you've applied for",           route: '/my-job-applications' },
      { icon: 'clipboard-check', label: 'My shift applications', sublabel: "Shifts you've applied for",         route: '/my-shift-applications' },
      { icon: 'bookmark',        label: 'Saved jobs',            sublabel: "Jobs you've bookmarked",            route: '/saved-jobs' },
    ],
  },
  {
    title: 'Posting work',
    items: [
      { icon: 'store',     label: 'My posted jobs',   sublabel: "Your businesses' jobs and applicants", route: '/my-posted-jobs' },
      { icon: 'briefcase', label: 'My posted shifts', sublabel: 'Your shifts and who has applied',      route: '/my-posted-shifts' },
      { icon: 'building',  label: 'Business profile',  sublabel: 'What workers see when you post',        route: '/employer-profile' },
    ],
  },
];

export default function MyWorkScreen() {
  const router = useRouter();
  const { screenWidth } = useAppLayout();

  const go = (route: string) => { Haptics.selectionAsync(); router.push(route as never); };

  return (
    <ScreenScaffold header={<ScreenHeader title="My work" accent={S.color} onBack={() => router.back()} />}>
      <ScrollView contentContainerStyle={[styles.content, contentContainer(screenWidth)]}>
        <Text style={styles.intro}>Your work profile, what you've applied for, and what you've posted. To browse and apply, use the Work tab.</Text>

        {GROUPS.map((g) => (
          <View key={g.title} style={styles.group}>
            <Text style={styles.groupTitle}>{g.title}</Text>
            <View style={styles.card}>
              {g.items.map((it, i) => (
                <TouchableOpacity
                  key={it.route}
                  style={[styles.row, i === g.items.length - 1 && { borderBottomWidth: 0 }]}
                  onPress={() => go(it.route)}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityLabel={`${it.label}. ${it.sublabel}`}
                >
                  <View style={[styles.iconWrap, { backgroundColor: S.color + '18' }]}>
                    <FontAwesome5 name={it.icon as any} size={14} color={S.color} solid />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowLabel}>{it.label}</Text>
                    <Text style={styles.rowSub} numberOfLines={1}>{it.sublabel}</Text>
                  </View>
                  <FontAwesome5 name="chevron-right" size={11} color={colors.textLight} />
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ))}

        <TouchableOpacity style={styles.browseBtn} onPress={() => go('/(tabs)/jobs?tab=shifts')} activeOpacity={0.85}>
          <FontAwesome5 name="th-large" size={13} color={S.color} />
          <Text style={styles.browseText}>Browse jobs & shifts</Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content:    { padding: spacing.md },
  intro:      { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20, marginBottom: spacing.md },
  group:      { marginBottom: spacing.lg },
  groupTitle: { fontSize: fontSize.xs, fontWeight: '800', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginLeft: 4 },
  card:       { backgroundColor: '#fff', borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  row:        { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: spacing.md, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border },
  iconWrap:   { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  rowLabel:   { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  rowSub:     { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  browseBtn:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: S.color + '40', backgroundColor: S.color + '0d' },
  browseText: { fontSize: fontSize.sm, fontWeight: '800', color: S.color },
});
