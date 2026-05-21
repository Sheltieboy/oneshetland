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

// Typed-routes workaround — payment-setup type is generated at Expo start
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PAYMENT_SETUP_HREF = '/(customer)/payment-setup' as any;

export default function RequestStep1() {
  const router = useRouter();
  const { profile } = useAuth();
  const { formData, update } = useRequest();

  // Gate: customer must have a payment method before requesting a delivery
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
      <FormScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Pressable onPress={() => { haptic.light(); router.back(); }} style={styles.backBtn} hitSlop={12}>
            <Text style={styles.backText}>‹ Back</Text>
          </Pressable>
          <StepIndicator current={1} />
        </View>

        <Text style={styles.heading}>What needs collecting?</Text>
        <Text style={styles.subheading}>
          Choose the type of item — this helps drivers know what to expect.
        </Text>

        <View style={styles.grid}>
          {DELIVERY_CATEGORIES.map((cat) => {
            const selected = formData.categorySlug === cat.slug;
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
                <Text style={styles.cardIcon}>{cat.icon}</Text>
                <Text style={[styles.cardName, selected && styles.cardNameSelected]}>
                  {cat.name}
                </Text>
                <Text style={styles.cardDesc}>{cat.description}</Text>
                {selected && (
                  <View style={styles.checkBadge}>
                    <Text style={styles.checkText}>✓</Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>

        <View style={styles.disclaimer}>
          <Text style={styles.disclaimerText}>
            Goods only. No alcohol, tobacco, or passengers. Items must fit safely in a car boot.
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
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xl,
  },
  backBtn: { padding: 4 },
  backText: { fontSize: fontSize.sm, color: colors.navy, fontWeight: '600' },

  steps: { flexDirection: 'row', gap: 6 },
  stepDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.border },
  stepDotActive: { backgroundColor: colors.accent, width: 24 },
  stepDotDone: { backgroundColor: colors.navy },

  heading: {
    fontSize: fontSize.xxl,
    fontWeight: '800',
    color: colors.navy,
    marginBottom: spacing.sm,
  },
  subheading: {
    fontSize: fontSize.md,
    color: colors.textMuted,
    lineHeight: 22,
    marginBottom: spacing.xl,
  },

  grid: { gap: spacing.sm },

  card: {
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 2,
    borderColor: colors.border,
    ...shadow.card,
  },
  cardSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentLight,
  },
  cardPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.99 }],
  },
  cardIcon: { fontSize: 28, marginBottom: spacing.sm },
  cardName: {
    fontSize: fontSize.md,
    fontWeight: '700',
    color: colors.navy,
    marginBottom: 4,
  },
  cardNameSelected: { color: colors.accent },
  cardDesc: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    lineHeight: 20,
  },
  checkBadge: {
    position: 'absolute',
    top: spacing.md,
    right: spacing.md,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkText: { color: colors.white, fontSize: 13, fontWeight: '700' },

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
