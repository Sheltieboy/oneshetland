import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TextInputProps,
  ViewStyle,
  InputAccessoryView,
  TouchableOpacity,
  Platform,
  Keyboard,
} from 'react-native';
import { colors, radius, fontSize, spacing } from '@/constants/theme';

const ACCESSORY_ID = 'oneshetland-input-done';

/**
 * Render <KeyboardDoneBar /> once near the root of any screen that uses <Input />.
 * This puts the "Done" bar above the keyboard so users can dismiss it easily.
 */
export function KeyboardDoneBar() {
  if (Platform.OS !== 'ios') return null;
  return (
    <InputAccessoryView nativeID={ACCESSORY_ID}>
      <View style={styles.accessory}>
        <TouchableOpacity
          onPress={() => Keyboard.dismiss()}
          style={styles.doneBtn}
          hitSlop={{ top: 8, bottom: 8, left: 16, right: 16 }}
        >
          <Text style={styles.doneText}>Done</Text>
        </TouchableOpacity>
      </View>
    </InputAccessoryView>
  );
}

interface InputProps extends TextInputProps {
  label?: string;
  error?: string;
  hint?: string;
  containerStyle?: ViewStyle;
}

export function Input({ label, error, hint, containerStyle, ...props }: InputProps) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={[styles.container, containerStyle]}>
      {label && <Text style={styles.label}>{label}</Text>}
      <TextInput
        {...props}
        inputAccessoryViewID={Platform.OS === 'ios' ? ACCESSORY_ID : undefined}
        style={[
          styles.input,
          focused && styles.inputFocused,
          error && styles.inputError,
          props.style,
        ]}
        placeholderTextColor={colors.textLight}
        onFocus={(e) => {
          setFocused(true);
          props.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          props.onBlur?.(e);
        }}
      />
      {error && <Text style={styles.errorText}>{error}</Text>}
      {hint && !error && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: spacing.md,
  },
  label: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.navy,
    marginBottom: 6,
  },
  input: {
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: fontSize.md,
    color: colors.textPrimary,
    backgroundColor: colors.white,
  },
  inputFocused: {
    borderColor: colors.borderFocus,
  },
  inputError: {
    borderColor: colors.error,
  },
  errorText: {
    fontSize: fontSize.xs,
    color: colors.error,
    marginTop: 4,
  },
  hint: {
    fontSize: fontSize.xs,
    color: colors.textMuted,
    marginTop: 4,
  },
  accessory: {
    backgroundColor: '#F2F2F7',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#C7C7CC',
    paddingVertical: 8,
    paddingHorizontal: spacing.lg,
    alignItems: 'flex-end',
  },
  doneBtn: {
    paddingVertical: 4,
  },
  doneText: {
    fontSize: fontSize.md,
    fontWeight: '600',
    color: colors.accent,
  },
});
