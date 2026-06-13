/**
 * components/JobCard.tsx
 * Compact listing card for a job — used in the Work hub, search and saved lists.
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';
import { Job, CONTRACT_LABELS, REMOTE_LABELS, formatJobPay, payIsShown } from '@/lib/jobs-api';

const S = SECTIONS.jobs;

function tint(hex?: string | null): string {
  if (!hex || !/^#?[0-9a-fA-F]{6}/.test(hex)) return S.color;
  return hex.startsWith('#') ? hex : `#${hex}`;
}

function postedAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function JobCard({
  job, onPress, saved, onToggleSave,
}: {
  job: Job;
  onPress: () => void;
  saved?: boolean;
  onToggleSave?: () => void;
}) {
  const accent = tint(job.business?.brand_color);
  const featured = job.is_featured || (job.boosted_until != null && new Date(job.boosted_until) > new Date());
  return (
    <TouchableOpacity style={[styles.card, featured && { borderColor: accent + '66' }]} onPress={onPress} activeOpacity={0.85}>
      <View style={[styles.logo, { backgroundColor: accent + '14' }]}>
        {job.business?.logo_url
          ? <Image source={{ uri: job.business.logo_url }} style={styles.logoImg} />
          : <FontAwesome5 name="briefcase" size={18} color={accent} solid />}
      </View>

      <View style={{ flex: 1 }}>
        {featured ? (
          <View style={[styles.featuredTag, { backgroundColor: accent }]}>
            <FontAwesome5 name="star" size={8} color="#fff" solid />
            <Text style={styles.featuredTagText}>Featured</Text>
          </View>
        ) : null}
        <Text style={styles.title} numberOfLines={2}>{job.title}</Text>
        <Text style={styles.org} numberOfLines={1}>
          {job.business?.name ?? 'A Shetland employer'}
          {job.business?.is_verified ? '  ·  ✓ Verified' : ''}
        </Text>

        <View style={styles.chips}>
          <Chip icon="file-signature" label={CONTRACT_LABELS[job.contract_type]} />
          {job.locality || job.location ? <Chip icon="map-marker-alt" label={(job.locality ?? job.location)!} /> : null}
          {job.remote_mode !== 'on_site' ? <Chip icon="laptop-house" label={REMOTE_LABELS[job.remote_mode]} /> : null}
        </View>

        <View style={styles.footer}>
          <Text style={[styles.pay, payIsShown(job) && { color: S.color }]}>{formatJobPay(job)}</Text>
          <Text style={styles.dot}>·</Text>
          <Text style={styles.posted}>{postedAgo(job.posted_at)}</Text>
          {job.relocation_support ? <View style={styles.perk}><FontAwesome5 name="suitcase-rolling" size={9} color={S.color} solid /><Text style={styles.perkText}>Relocation</Text></View> : null}
          {job.housing_available ? <View style={styles.perk}><FontAwesome5 name="home" size={9} color={S.color} solid /><Text style={styles.perkText}>Housing</Text></View> : null}
        </View>
      </View>

      {onToggleSave ? (
        <TouchableOpacity onPress={onToggleSave} hitSlop={12} style={styles.saveBtn}>
          <FontAwesome5 name="bookmark" size={16} color={saved ? S.color : colors.textLight} solid={saved} />
        </TouchableOpacity>
      ) : (
        <FontAwesome5 name="chevron-right" size={13} color={colors.textLight} />
      )}
    </TouchableOpacity>
  );
}

function Chip({ icon, label }: { icon: string; label: string }) {
  return (
    <View style={styles.chip}>
      <FontAwesome5 name={icon as any} size={9} color={colors.textMuted} solid />
      <Text style={styles.chipText} numberOfLines={1}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row', gap: 12, backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md, alignItems: 'flex-start',
  },
  logo: { width: 46, height: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  logoImg: { width: 46, height: 46 },
  featuredTag: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 999, marginBottom: 4 },
  featuredTagText: { color: '#fff', fontSize: 9, fontWeight: '800' },
  title: { fontSize: fontSize.md, fontWeight: '800', color: colors.textPrimary, lineHeight: 21 },
  org: { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.offWhite, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 999, maxWidth: 160 },
  chipText: { fontSize: 11, fontWeight: '700', color: colors.textSecondary },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' },
  pay: { fontSize: fontSize.sm, fontWeight: '800', color: colors.textSecondary },
  dot: { color: colors.textLight },
  posted: { fontSize: fontSize.xs, color: colors.textMuted },
  perk: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: S.light, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 999 },
  perkText: { fontSize: 10, fontWeight: '800', color: S.color },
  saveBtn: { padding: 4 },
});

export default JobCard;
