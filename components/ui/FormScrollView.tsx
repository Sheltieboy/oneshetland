/**
 * FormScrollView
 *
 * Drop-in replacement for ScrollView on any screen that has text inputs.
 * Combines KeyboardAvoidingView + ScrollView so the focused field always
 * stays visible above the keyboard on both iOS and Android.
 */
import React from 'react';
import {
  ScrollView,
  ScrollViewProps,
  StyleSheet,
} from 'react-native';

interface Props extends ScrollViewProps {
  children: React.ReactNode;
}

export function FormScrollView({ children, contentContainerStyle, style, ...rest }: Props) {
  return (
    <ScrollView
      style={[styles.flex, style]}
      contentContainerStyle={contentContainerStyle}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      showsVerticalScrollIndicator={false}
      {...rest}
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
