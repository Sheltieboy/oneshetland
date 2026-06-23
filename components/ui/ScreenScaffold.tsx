import React, { PropsWithChildren } from 'react';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NavRail } from '@/components/NavRail';
import { useAppLayout } from '@/hooks/useAppLayout';
import { colors, SIDEBAR_WIDTH } from '@/constants/theme';

interface ScreenScaffoldProps extends PropsWithChildren {
  /** A ScreenHeader (or any header element) rendered above the content. */
  header?: React.ReactNode;
  edges?: ('top' | 'bottom' | 'left' | 'right')[];
  /**
   * Set when this screen is rendered INLINE inside the (tabs) navigator (e.g.
   * the Fetch tab renders the customer/driver dashboards directly). In that
   * case the Tabs navigator already provides the NavRail and the SIDEBAR_WIDTH
   * scene offset, so we must NOT render a second rail or double the offset.
   */
  embedded?: boolean;
}

/**
 * Standard screen wrapper. Renders the tablet NavRail and offsets content by
 * SIDEBAR_WIDTH on tablet (so nothing sits under the rail), applies the screen
 * background + safe-area, and slots in a header. Screens still apply
 * `contentContainer(screenWidth)` on their own ScrollView for the reading
 * column. (Design A5 — kills the "full-bleed on iPad" problem at the root.)
 */
export function ScreenScaffold({ header, children, edges = ['top'], embedded = false }: ScreenScaffoldProps) {
  const { isTablet } = useAppLayout();
  return (
    <SafeAreaView style={styles.safe} edges={edges}>
      {!embedded && <NavRail />}
      <View style={[styles.body, isTablet && !embedded && { paddingLeft: SIDEBAR_WIDTH }]}>
        {header}
        <View style={styles.content}>{children}</View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.screenBackground },
  body: { flex: 1 },
  content: { flex: 1 },
});
