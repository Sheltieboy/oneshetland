/**
 * ResponsiveContainer
 *
 * Wraps screen content in a centred, max-width container.
 * On iPhone: transparent pass-through (no visual change).
 * On iPad:   content is centred with equal side padding so it never
 *            stretches to fill a 1024px canvas.
 *
 * Use as the contentContainerStyle wrapper on ScrollViews, or as a
 * direct View wrapper for non-scrolling screens.
 *
 * <ScrollView contentContainerStyle={[styles.content, { paddingHorizontal: sidePadding }]}>
 * OR
 * <ResponsiveContainer>…children…</ResponsiveContainer>
 */

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useAppLayout } from '@/hooks/useAppLayout';
import { MAX_CONTENT_WIDTH } from '@/constants/theme';

interface Props {
  children: React.ReactNode;
  style?: object;
}

export function ResponsiveContainer({ children, style }: Props) {
  const { sidePadding } = useAppLayout();
  return (
    <View style={[styles.container, { paddingHorizontal: sidePadding }, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    maxWidth: MAX_CONTENT_WIDTH + 9999, // flex handles width; sidePadding centres content
    alignSelf: 'center',
    width: '100%',
  },
});
