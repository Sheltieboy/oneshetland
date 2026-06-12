/**
 * useAppLayout
 *
 * Central hook for responsive layout decisions. Returns stable values
 * derived from the current window dimensions so components re-render
 * correctly when the iPad is rotated or a split-view is resized.
 *
 * Usage:
 *   const { isTablet, screenWidth, contentWidth, hp } = useAppLayout();
 */

import { useWindowDimensions } from 'react-native';
import { TABLET_BREAKPOINT, MAX_CONTENT_WIDTH, SIDEBAR_WIDTH } from '@/constants/theme';

export interface AppLayout {
  /** True when the screen width is >= 768px (iPad) */
  isTablet:     boolean;
  /** Raw screen width in points */
  screenWidth:  number;
  /** Raw screen height in points */
  screenHeight: number;
  /**
   * The usable content width — capped at MAX_CONTENT_WIDTH on large screens.
   * Use this for cards, carousels, and anything that shouldn't stretch edge-to-edge.
   */
  contentWidth: number;
  /**
   * Horizontal padding to centre content on wide screens.
   * Pass as paddingHorizontal on ScrollView contentContainerStyle.
   */
  sidePadding:  number;
  /**
   * Proportional card width helper.
   * cardWidth(0.45) → 45% of contentWidth, safe for horizontal carousels.
   */
  cardWidth: (fraction: number) => number;
}

export function useAppLayout(): AppLayout {
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const isTablet = screenWidth >= TABLET_BREAKPOINT;

  // On tablets a persistent sidebar occupies the left edge, so the usable
  // canvas for screen content is the screen minus that rail. Centring and
  // card sizing are computed against this available width, not the raw screen.
  const availableWidth = isTablet ? screenWidth - SIDEBAR_WIDTH : screenWidth;
  const contentWidth   = Math.min(availableWidth, MAX_CONTENT_WIDTH);
  const sidePadding    = Math.max(0, (availableWidth - MAX_CONTENT_WIDTH) / 2);

  return {
    isTablet,
    screenWidth,
    screenHeight,
    contentWidth,
    sidePadding,
    cardWidth: (fraction: number) => Math.floor(contentWidth * fraction),
  };
}
