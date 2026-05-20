import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { colors, fontSize, spacing } from '@/constants/theme';

interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  showBack?: boolean;
  rightElement?: React.ReactNode;
}

export function ScreenHeader({ title, subtitle, showBack = false, rightElement }: ScreenHeaderProps) {
  const router = useRouter();

  return (
    <View style={styles.header}>
      <View style={styles.row}>
        {showBack && (
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton} hitSlop={12}>
            <Text style={styles.backArrow}>←</Text>
          </TouchableOpacity>
        )}
        <View style={styles.titleBlock}>
          <Text style={styles.title}>{title}</Text>
          {subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
        </View>
        {rightElement && <View>{rightElement}</View>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.white,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  backButton: {
    padding: spacing.xs,
  },
  backArrow: {
    fontSize: fontSize.xl,
    color: colors.navy,
    fontWeight: '600',
  },
  titleBlock: {
    flex: 1,
  },
  title: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.navy,
  },
  subtitle: {
    fontSize: fontSize.sm,
    color: colors.textMuted,
    marginTop: 2,
  },
});
