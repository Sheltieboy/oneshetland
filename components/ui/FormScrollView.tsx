/**
 * FormScrollView
 *
 * Drop-in replacement for ScrollView on any screen that has text inputs.
 * Wraps in KeyboardAvoidingView so the view shrinks when the keyboard appears
 * rather than adding bottom insets — this prevents the "scroll past content"
 * bug caused by automaticallyAdjustKeyboardInsets leaving stale insets after
 * the keyboard is dismissed.
 */
import React from 'react';
import {
  ScrollView,
  ScrollViewProps,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';

interface Props extends ScrollViewProps {
  children: React.ReactNode;
}

export function FormScrollView({ children, contentContainerStyle, style, ...rest }: Props) {
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.flex}
    >
      <ScrollView
        style={[styles.flex, style]}
        contentContainerStyle={contentContainerStyle}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        {...rest}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
