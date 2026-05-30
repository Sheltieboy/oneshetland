export const colors = {
  // Brand
  navy: '#032F4C',
  navyDark: '#02243A',
  navyLight: '#0A4A70',
  accent: '#12B3D6',
  accentDark: '#0E9AB8',
  accentLight: '#E0F7FC',

  // Shifts
  shifts:      '#E8A020',   // warm gold — opportunity / earning
  shiftsLight: '#FEF3C7',

  // Section brand colours — each major feature has its own identity
  spik:          '#12B3D6',   // teal   — dialect / language
  spikLight:     '#E0F7FC',
  events:        '#D4921A',   // amber  — what's on / calendar
  eventsLight:   '#FEF3C7',
  notices:       '#C53B2F',   // red    — notices / alerts
  noticesLight:  '#FEE2E2',
  jobs:          '#2A8B5C',   // green  — jobs / opportunity
  jobsLight:     '#D1FAE5',
  services:      '#6B47BF',   // purple — services / directory
  servicesLight: '#EDE9FE',
  fetch:         '#E0722A',   // orange — delivery / fetch
  fetchLight:    '#FFEDD5',
  news:          '#0E6EA6',   // deep teal — news / media
  newsLight:     '#DBEAFE',

  // Surfaces
  white: '#FFFFFF',
  offWhite: '#F5F7FA',
  screenBackground: '#F0F2F5',
  cardBackground: '#FFFFFF',

  // Dark surfaces (hero areas, headers)
  darkSurface: '#06243A',
  darkCard: '#0A3550',
  darkBorder: 'rgba(255,255,255,0.08)',

  // Text
  textPrimary: '#0F1C26',
  textSecondary: '#374151',
  textMuted: '#6B7280',
  textLight: '#9CA3AF',
  textInverse: '#FFFFFF',

  // Borders
  border: '#E5E9EF',
  borderFocus: '#12B3D6',
  borderStrong: '#CBD5E1',

  // Semantic
  error: '#EF4444',
  errorLight: '#FEE2E2',
  errorDark: '#991B1B',
  success: '#10B981',
  successLight: '#D1FAE5',
  successDark: '#065F46',
  warning: '#F59E0B',
  warningLight: '#FEF3C7',
  warningDark: '#92400E',
  info: '#3B82F6',
  infoLight: '#EFF6FF',
  infoDark: '#1D4ED8',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
} as const;

export const radius = {
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  full: 999,
} as const;

export const fontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
  xxl: 26,
  xxxl: 32,
  hero: 40,
} as const;

export const fontWeight = {
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
  heavy: '800' as const,
};

export const shadow = {
  xs: {
    shadowColor: '#0F1C26',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },
  card: {
    shadowColor: '#0F1C26',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 2,
  },
  strong: {
    shadowColor: '#0F1C26',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 5,
  },
  accent: {
    shadowColor: '#12B3D6',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 4,
  },
} as const;
