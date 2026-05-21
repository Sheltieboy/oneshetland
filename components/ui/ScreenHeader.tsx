import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fontSize, spacing } from '@/constants/theme';
import { haptic } from '@/lib/haptics';

interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  showBack?: boolean;
  rightElement?: React.ReactNode;
  dark?: boolean;
}

export function ScreenHeader({ title, subtitle, showBack = false, rightElement, dark = false }: ScreenHeaderProps) {
  const router = useRouter();

  const handleBack = () => {
    haptic.light();
    router.back();
  };

  return (
    <View style={[styles.header, dark && styles.headerDark]}>
      <View style={styles.row}>
        {showBack && (
          <Pressable onPress={handleBack} style={styles.backButton} hitSlop={12}>
            <Text style={[styles.backArrow, dark && styles.textDark]}>‹</Text>
          </Pressable>
        )}
        <View style={styles.titleBlock}>
          <Text style={[styles.title, dark && styles.textDark]}>{title}</Text>
          {subtitle && <Text style={[styles.subtitle, dark && styles.subtitleDark]}>{subtitle}</Text>}
        </View>
        {rightElement && <View>{rightElement}</View>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerDark: {
    backgroundColor: colors.navy,
    borderBottomColor: colors.darkBorder,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  backButton: {
    paddingRight: spacing.xs,
    marginLeft: -4,
  },
  backArrow: {
    fontSize: 28,
    color: colors.navy,
    fontWeight: '300',
    lineHeight: 32,
  },
  titleBlock: { flex: 1 },
  title: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginTop: 2,
  },
  textDark: { color: colors.white },
  subtitleDark: { color: 'rgba(255,255,255,0.6)' },
});
