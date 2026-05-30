/**
 * fetch-about-driver.tsx
 *
 * Driver-side "How Fetch works" page. Linked from the driver dashboard header.
 * Mirrors the customer-side About page but frames every step from the driver's
 * perspective — what they post, what they pick up, how they get paid.
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

export default function FetchAboutDriver() {
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
        <Text style={styles.headerTitle}>Driving for Fetch</Text>
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
            <FontAwesome5 name="route" size={26} color="#fff" solid />
          </View>
          <Text style={styles.heroTitle}>Drive your way</Text>
          <Text style={styles.heroSub}>
            Already heading from Lerwick to Yell? Brae to Sumburgh? Post your run, pick up the requests that fit, and get paid for trips you were making anyway.
          </Text>
        </View>

        {/* How it works */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>How driving Fetch works</Text>
          {[
            {
              icon: 'route',
              title: 'Post a run',
              body: 'Set your departure window, origin and destination, what kinds of items you can carry, and whether you\'re going via a ferry. Takes about a minute.',
            },
            {
              icon: 'check-square',
              title: 'Accept the requests that fit',
              body: 'Customer requests along your route appear in your dashboard. Pick the ones that work for your time, vehicle and detour tolerance.',
            },
            {
              icon: 'university',
              title: 'Deliver and get paid',
              body: 'Mark each step done in the app — collected, en route, delivered. Payouts land in your bank via Stripe, usually within a couple of working days.',
            },
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

        {/* Getting paid */}
        <TouchableOpacity
          style={styles.payCard}
          onPress={() => { Haptics.selectionAsync(); router.push('/(driver)/connect-bank'); }}
          activeOpacity={0.85}
        >
          <View style={[styles.payIconWrap, { backgroundColor: S.color + '22' }]}>
            <FontAwesome5 name="university" size={18} color={S.color} solid />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.payTitle}>Getting paid</Text>
            <Text style={styles.paySub}>Payouts run through Stripe Connect. Connect your bank account once — payments land automatically after each delivery.</Text>
          </View>
          <FontAwesome5 name="chevron-right" size={12} color={colors.textLight} />
        </TouchableOpacity>

        {/* What you can carry */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>What you can carry</Text>
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

        {/* What you can't */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>What you can't carry</Text>
          <View style={styles.dontCard}>
            {[
              'Alcohol, tobacco or vapes',
              'Cash or cheques',
              'Passengers or taxi services',
              'Live animals',
              'Anything requiring a courier licence',
            ].map((item, i, arr) => (
              <View key={item} style={[styles.dontRow, i < arr.length - 1 && styles.dontRowBorder]}>
                <FontAwesome5 name="times-circle" size={12} color={colors.error} solid />
                <Text style={styles.dontText}>{item}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.fineprint}>
            If a customer asks you to collect something from this list, decline and report it in the app.
          </Text>
        </View>

        {/* Tips */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Tips for a smooth run</Text>
          {[
            { icon: 'clock',          text: 'Pad your window. Better to under-promise than chase a late ferry.' },
            { icon: 'comment-alt',    text: "Message the customer if you're delayed — they appreciate it." },
            { icon: 'camera',         text: 'Snap a quick photo at drop-off if there\'s no one in. Saves disputes.' },
            { icon: 'map-marker-alt', text: 'Use the destination notes — gates, sheds, side doors. Locals know what they mean.' },
          ].map(item => (
            <View key={item.text} style={styles.tipRow}>
              <View style={[styles.tipIconWrap, { backgroundColor: S.light }]}>
                <FontAwesome5 name={item.icon as any} size={11} color={S.color} solid />
              </View>
              <Text style={styles.tipText}>{item.text}</Text>
            </View>
          ))}
        </View>

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

  section:      { paddingHorizontal: spacing.md, marginTop: spacing.lg },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '900', color: colors.textPrimary, marginBottom: 12 },

  // How it works
  howStep:        { flexDirection: 'row', gap: 14, marginBottom: spacing.md, alignItems: 'flex-start' },
  howStepLeft:    { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  howStepNum:     { fontSize: fontSize.md, fontWeight: '900' },
  howStepHeader:  { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 3 },
  howStepTitle:   { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  howStepText:    { fontSize: fontSize.xs, color: colors.textMuted, lineHeight: 18 },

  // Pay card
  payCard: {
    marginHorizontal: spacing.md, marginTop: spacing.sm,
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#fff', borderRadius: radius.lg,
    padding: 14, borderWidth: 1, borderColor: colors.border,
  },
  payIconWrap: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  payTitle:    { fontSize: fontSize.sm, fontWeight: '800', color: colors.textPrimary },
  paySub:      { fontSize: fontSize.xs, color: colors.textMuted, marginTop: 2, lineHeight: 17 },

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
  fineprint:     { fontSize: fontSize.xs, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 17 },

  // Tips
  tipRow:      { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  tipIconWrap: { width: 26, height: 26, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  tipText:     { flex: 1, fontSize: fontSize.sm, color: colors.textPrimary, lineHeight: 20 },
});
