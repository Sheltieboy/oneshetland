import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { FontAwesome5 } from '@expo/vector-icons';
import { colors, fontSize, spacing, radius } from '@/constants/theme';
import { Button } from './Button';

interface EmptyStateProps {
  /** FontAwesome5 icon name (preferred). */
  icon: string;
  title: string;
  body?: string;
  /** Accent colour for the icon (e.g. the section colour). */
  accent?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Wrap in a bordered card surface. */
  variant?: 'plain' | 'card';
}

export function EmptyState({
  icon, title, body, accent = colors.textMuted, actionLabel, onAction, variant = 'plain',
}: EmptyStateProps) {
  return (
    <View style={[styles.container, variant === 'card' && styles.card]}>
      <FontAwesome5 name={icon as any} size={30} color={accent} solid />
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {actionLabel && onAction ? (
        <Button label={actionLabel} onPress={onAction} variant="outline" size="sm" style={styles.action} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  card: {
    backgroundColor: colors.cardBackground,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    margin: spacing.md,
  },
  title: { fontSize: fontSize.lg, fontWeight: '800', color: colors.textPrimary, textAlign: 'center' },
  body: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
  action: { marginTop: spacing.sm },
});
