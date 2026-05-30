/**
 * fetch-about.tsx
 *
 * Dedicated "How Fetch works" page. Linked from the customer dashboard header
 * — out of the main flow but reachable for anyone wanting a reminder of what
 * Fetch is, what gets delivered, and the rules.
 */

import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { FontAwesome5 } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { SECTIONS } from '@/constants/sections';

const S = SECTIONS.fetch;

export default function FetchAbout() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => { Haptics.selectionAsync(); router.back(); }}
          hitSlop={12}
        >
          <FontAwesome5 name="chevron-left" size={14} color="#fff" />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>About Fetch</Text>
        <View style={{ width: 70 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={[styles.heroCard, { backgroundColor: S.color }]}>
          <View style={styles.heroIconWrap}>
            <FontAwesome5 name="shipping-fast" size={28} color="#fff" solid />
          </View>
          <Text style={styles.heroTitle}>Community delivery</Text>
          <Text style={styles.heroSub}>
            Need something collected from Lerwick? Have something to drop off across the isles? Fetch matches you with local drivers already heading that way.
          </Text>
        </View>

        {/* How it works */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>How it works</Text>
          {[
            { icon: 'edit',     title: 'Create a request',     body: "Tell us what needs collecting, where from, and where it's going. Takes about two minutes." },
            { icon: 'car',      title: 'A driver picks it up', body: "A local driver already heading that way claims your request and collects your item." },
            { icon: 'box-open', title: 'Delivered to your door', body: "You'll be notified when it's on its way, and again when it arrives. Pay only when it's delivered." },
          ].map((item, i) => (
            <View key={i} style={styles.howStep}>
              <View style={[styles.howStepLeft, { backgroundColor: S.light }]}>
                <Text style={[styles.howStepNum, { color: S.color }]}>{i + 1}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <View style={styles.howStepHeader}>
                  <FontAwesome5 name={item.icon as any} size={13} color={S.color} solid />
                  <Text style={styles.howStepTitle}>{item.title}</Text>
                </View>
                <Text style={styles.howStepText}>{item.body}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* What we deliver */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>What we deliver</Text>
          <View style={styles.categoryGrid}>
            {[
              { icon: '🍕', label: 'Takeaway' },
              { icon: '💊', label: 'Pharmacy' },
              { icon: '📦', label: 'Parcels' },
              { icon: '🛍️', label: 'Shopping' },
              { icon: '🛒', label: 'Click & collect' },
              { icon: '📫', label: 'Other' },
            ].map(item => (
              <View key={item.label} style={styles.categoryChip}>
                <Text style={styles.categoryIcon}>{item.icon}</Text>
                <Text style={styles.categoryLabel}>{item.label}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* What we don't */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>What we don't carry</Text>
          <View style={styles.dontCard}>
            {[
              'Alcohol, tobacco or vapes',
              'Cash or cheques',
              'Passengers or taxi services',
              'Live animals',
              "Anything requiring a courier licence",
            ].map((item, i, arr) => (
              <View key={item} style={[styles.dontRow, i < arr.length - 1 && styles.dontRowBorder]}>
                <FontAwesome5 name="times-circle" size={12} color={colors.error} solid />
                <Text style={styles.dontText}>{item}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Become a driver */}
        <TouchableOpacity
          style={styles.driverCard}
          onPress={() => { Haptics.selectionAsync(); router.push('/(customer)/apply-driver'); }}
          activeOpacity={0.85}
        >
          <View style={[styles.driverIconWrap, { backgroundColor: S.color + '22' }]}>
            <FontAwesome5 name="car" size={18} color={S.color} solid />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.driverTitle}>Want to drive and earn?</Text>
            <Text style={styles.driverSub}>Already heading that way? Get paid for the trip.</Text>
          </View>
          <FontAwesome5 name="chevron-right" size={12} color={colors.textLight} />
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:    { flex: 1, backgroundColor: colors.screenBackground },
  scroll:  { flex: 1 },
  content: { paddingBottom: 40 },

  header: {
    backgroundColor: colors.navy,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.md, paddingVertical: 12,
    borderBottomWidth: 2, borderBottomColor: S.color,
  },
  backBtn:     { flexDirection: 'row', alignItems: 'center', gap: 8, width: 70 },
  backText:    { fontSize: fontSize.sm, fontWeight: '700', color: '#fff' },
  headerTitle: { color: '#fff', fontSize: fontSize.md, fontWeight: '800' },

  // Hero
  heroCard: {
    margin: spacing.md, padding: spacing.lg,
    borderRadius: radius.xl, gap: 10,
    shadowColor: S.color, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25, shadowRadius: 12, elevation: 4,
  },
  heroIconWrap: {
    width: 56, height: 56, borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 4,
  },
  heroTitle: { color: '#fff', fontSize: fontSize.xl, fontWeight: '900', letterSpacing: -0.4 },
  heroSub:   { color: 'rgba(255,255,255,0.9)', fontSize: fontSize.sm, lineHeight: 22 },

  // Section
  section:      { paddingHorizontal: spacing.md, marginTop: spacing.lg },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginBottom: 12 },

  // How it works
  howStep:        { flexDirection: 'row', gap: 14, marginBottom: spacing.md, alignItems: 'flex-start' },
  howStepLeft:    { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  howStepNum:     { fontSize: fontSize.md, fontWeight: '900' },
  howStepHeader:  { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 3 },
  howStepTitle:   { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  howStepText:    { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 18 },

  // Categories
  categoryGrid:  { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  categoryChip:  {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#fff', paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: radius.full, borderWidth: 1, borderColor: colors.border,
  },
  categoryIcon:  { fontSize: 14 },
  categoryLabel: { fontSize: fontSize.xs, color: colors.textPrimary, fontWeight: '700' },

  // Don'ts
  dontCard: {
    backgroundColor: '#fff', borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
  },
  dontRow:       { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 11 },
  dontRowBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  dontText:      { fontSize: fontSize.sm, color: colors.textPrimary },

  // Become a driver
  driverCard: {
    marginHorizontal: spacing.md, marginTop: spacing.lg,
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 14, borderWidth: 1, borderColor: colors.border,
  },
  driverIconWrap: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  driverTitle:    { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  driverSub:      { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2 },
});
