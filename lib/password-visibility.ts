/**
 * What the show/hide-password control looks like for a given state. Pure, so
 * the labels and icon can be tested without rendering. The reveal state itself
 * lives in component state only — it is never stored, logged or defaulted to
 * visible.
 */
export function passwordVisibility(visible: boolean) {
  return {
    secureTextEntry: !visible,
    accessibilityLabel: visible ? 'Hide password' : 'Show password',
    icon: visible ? 'eye-slash' : 'eye',
  } as const;
}
