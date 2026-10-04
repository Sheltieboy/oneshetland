import React from 'react';
import { View, Text, type StyleProp, type ViewStyle } from 'react-native';

/**
 * TestBadge — marks a test / acceptance fixture. Only an administrator is ever sent fixtures (see
 * lib/discovery-fixtures.ts), and for them this label must be unmistakable. Amber with black text, same everywhere.
 *   inline    sits in the flow of a row or card
 *   (default) a ribbon pinned to the top-left corner of the card it is placed in
 */
export const TEST_BADGE_TEXT = 'TEST · ADMIN ONLY';

export function TestBadge({ inline = false, style }: { inline?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      accessibilityLabel="Test item, visible to administrators only"
      style={[
        inline
          ? { alignSelf: 'flex-start', borderRadius: 6 }
          : { position: 'absolute', left: 0, top: 10, zIndex: 5, borderTopRightRadius: 6, borderBottomRightRadius: 6 },
        { backgroundColor: '#FACC15', paddingHorizontal: 8, paddingVertical: 3 },
        style,
      ]}
    >
      <Text style={{ color: '#000', fontSize: 9.5, fontWeight: '900', letterSpacing: 0.8 }}>{TEST_BADGE_TEXT}</Text>
    </View>
  );
}
