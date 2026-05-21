import React, { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { FormScrollView } from '@/components/ui/FormScrollView';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/context/AuthContext';
import { useRequest } from '@/context/RequestContext';
import { DELIVERY_CATEGORIES } from '@/constants/categories';
import { colors, fontSize, spacing, radius, shadow } from '@/constants/theme';
import { haptic } from '@/lib/haptics';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PAYMENT_SETUP_HREF = '/(customer)/payment-setup' as any;

// Tint colour per category for the icon box
const CATEGORY_TINT: Record<string, { bg: string; emoji: string }> = {
  'takeaway':                  { bg: '#FFF3E0', emoji: '🍕' },
  'pharmacy':                  { bg: '#F3E5F5', emoji: '💊' },
  'small-parcel':              { bg: '#E8F5E9', emoji: '📦' },
  'shop-collection':           { bg: '#FFF8E1', emoji: '🛍️' },
  'supermarket-click-collect': { bg: '#E3F2FD', emoji: '🛒' },
  'other':                     { bg: '#F5F5F5', emoji: '📫' },
};

export default function RequestStep1() {
  const router = useRouter();
  const { profile } = useAuth();
  const { formData, update } = useRequest();

  useEffect(() => {
    if (profile && !profile.has_payment_method) {
      router.replace(PAYMENT_SETUP_HREF);
    }
  }, [profile]);

  function select(slug: string, name: string) {
    haptic.select();
    update({ categorySlug: slug, categoryName: name });
    router.push('/(customer)/request/step-2');
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      {/* Navy header strip — matches other screens */}
      <View style={styles.navHeader}>
        <Pressable onPress={() => { haptic.light(); router.back(); }} hitSlop={12}>
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <StepIndicator current={1} />
      </View>

      <FormScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.heading}>What needs{'\n'}collecting?</Text>
        <Text style={styles.subheading}>
          Choose the type of item — this helps drivers know what to expect.
        </Text>

        <View style={styles.list}>
          {DELIVERY_CATEGORIES.map((cat) => {
            const selected = formData.categorySlug === cat.slug;
            const tint = CATEGORY_TINT[cat.slug] ?? { bg: '#F5F5F5', emoji: cat.icon };
            return (
              <Pressable
                key={cat.slug}
                style={({ pressed }) => [
                  styles.card,
                  selected && styles.cardSelected,
                  pressed && styles.cardPressed,
                ]}
                onPress={() => select(cat.slug, cat.name)}
              >
                {/* Tinted icon box */}
                <View style={[styles.iconBox, { backgroundColor: selected ? colors.accentLight : tint.bg }]}>
                  <Text style={styles.iconEmoji}>{cat.icon}</Text>
                </View>

                {/* Text */}
                <View style={styles.cardBody}>
                  <Text style={[styles.cardName, selected && styles.cardNameSelected]}>
                    {cat.name}
                  </Text>
                  <Text style={styles.cardDesc} numberOfLines={1}>{cat.description}</Text>
                </View>

                {/* Right indicator */}
                {selected ? (
                  <View style={styles.checkCircle}>
                    <Text style={styles.checkText}>✓</Text>
                  </View>
                ) : (
                  <Text style={styles.arrow}>›</Text>
                )}
              </Pressable>
            );
          })}
        </View>

        <View style={styles.disclaimer}>
          <Text style={styles.disclaimerText}>
            Goods only — no alcohol, tobacco, or passengers. Items must fit in a car boot.
          </Text>
        </View>
      </FormScrollView>
    </SafeAreaView>
  );
}

function StepIndicator({ current }: { current: number }) {
  return (
    <View style={styles.steps}>
      {[1, 2, 3, 4].map((n) => (
        <View
          key={n}
          style={[
            styles.stepDot,
            n === current && styles.stepDotActive,
            n < current && styles.stepDotDone,
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.navy },
  scroll: { flex: 1, backgroundColor: colors.screenBackground },

  // Navy nav header — same pattern as dashboards
  navHeader: {
    backgroundColor: colors.navy,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: fontSize.sm,
    fontWeight: '500',
  },
  steps: { flexDirection: 'row', gap: 6 },
  stepDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.25)' },
  stepDotActive: { backgroundColor: colors.accent, width: 24, borderRadius: 4 },
  stepDotDone: { backgroundColor: 'rgba(255,255,255,0.6)' },

  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },

  heading: {
    fontSize: fontSize.xxxl,
    fontWeight: '800',
    color: colors.textPrimary,
    letterSpacing: -0.5,
    marginBottom: spacing.sm,
    marginTop: spacing.sm,
  },
  subheading: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    lineHeight: 20,
    marginBottom: spacing.xl,
  },

  list: { gap: spacing.sm },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    gap: spacing.md,
    ...shadow.card,
  },
  cardSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.white,
  },
  cardPressed: {
    opacity: 0.85,
    transform: [{ scale: 0.99 }],
  },

  iconBox: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  iconEmoji: { fontSize: 26 },

  cardBody: { flex: 1 },
  cardName: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: 3,
  },
  cardNameSelected: { color: colors.navy },
  cardDesc: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    lineHeight: 18,
  },

  checkCircle: {
    width: 26,
    height: 26,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  checkText: { color: colors.white, fontSize: 13, fontWeight: '800' },
  arrow: {
    fontSize: 22,
    color: colors.textLight,
    fontWeight: '300',
    flexShrink: 0,
  },

  disclaimer: {
    marginTop: spacing.xl,
    padding: spacing.md,
    backgroundColor: colors.offWhite,
    borderRadius: radius.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.warning,
  },
  disclaimerText: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    lineHeight: 18,
  },
});
