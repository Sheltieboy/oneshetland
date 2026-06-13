import React, { PropsWithChildren } from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, ScrollView,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fontSize, spacing, radius } from '@/constants/theme';

interface SheetProps extends PropsWithChildren {
  visible: boolean;
  onClose: () => void;
  /** Optional title shown at the top of the sheet. */
  title?: string;
  /** Wrap children in a scroll view (for taller content). */
  scroll?: boolean;
  /** Max height as a fraction of the screen (0–1). Default 0.9. */
  maxHeightPct?: number;
}

/**
 * The app's canonical bottom sheet — a "drawer" for short, in-place tasks
 * (confirm, pick one thing, a quick form, review). Slides up over the current
 * screen; tap the backdrop or swipe down (grabber) to dismiss. (Design A4.)
 */
export function Sheet({ visible, onClose, title, scroll = false, maxHeightPct = 0.9, children }: SheetProps) {
  const insets = useSafeAreaInsets();
  const Body: any = scroll ? ScrollView : View;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.root}
      >
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={[styles.sheet, { maxHeight: `${Math.round(maxHeightPct * 100)}%`, paddingBottom: insets.bottom + spacing.md }]}>
          <View style={styles.grabber} />
          {title ? <Text style={styles.title}>{title}</Text> : null}
          <Body
            {...(scroll ? { keyboardShouldPersistTaps: 'handled' as const, showsVerticalScrollIndicator: false } : {})}
            style={scroll ? { flexShrink: 1 } : undefined}
          >
            {children}
          </Body>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: colors.screenBackground,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    paddingHorizontal: spacing.lg,
    paddingTop: 10,
  },
  grabber: {
    alignSelf: 'center', width: 40, height: 4, borderRadius: 2,
    backgroundColor: colors.border, marginBottom: spacing.sm,
  },
  title: { fontSize: fontSize.lg, fontWeight: '900', color: colors.textPrimary, marginBottom: spacing.sm },
});
