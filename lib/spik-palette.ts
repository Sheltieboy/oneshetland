import { colors } from '@/constants/theme';

export interface PosPalette {
  bar:  string;   // left border / strong accent
  bg:   string;   // badge background
  text: string;   // badge text
  tint: string;   // very light tint (hero badge bg on dark)
}

const PALETTE: Record<string, PosPalette> = {
  noun:             { bar: '#0891B2', bg: '#E0F7FC', text: '#0E7490', tint: 'rgba(8,145,178,0.2)' },
  verb:             { bar: '#2563EB', bg: '#DBEAFE', text: '#1D4ED8', tint: 'rgba(37,99,235,0.2)' },
  adjective:        { bar: '#16A34A', bg: '#DCFCE7', text: '#15803D', tint: 'rgba(22,163,74,0.2)'  },
  adverb:           { bar: '#9333EA', bg: '#F3E8FF', text: '#7E22CE', tint: 'rgba(147,51,234,0.2)' },
  pronoun:          { bar: '#EA580C', bg: '#FFEDD5', text: '#C2410C', tint: 'rgba(234,88,12,0.2)'  },
  preposition:      { bar: '#64748B', bg: '#F1F5F9', text: '#475569', tint: 'rgba(100,116,139,0.2)'},
  interjection:     { bar: '#E11D48', bg: '#FFE4E6', text: '#BE123C', tint: 'rgba(225,29,72,0.2)'  },
  determiner:       { bar: '#D97706', bg: '#FEF3C7', text: '#B45309', tint: 'rgba(217,119,6,0.2)'  },
  conjunction:      { bar: '#059669', bg: '#D1FAE5', text: '#065F46', tint: 'rgba(5,150,105,0.2)'  },
  'auxiliary verb': { bar: '#3B82F6', bg: '#DBEAFE', text: '#1E40AF', tint: 'rgba(59,130,246,0.2)' },
  phrase:           { bar: '#6366F1', bg: '#EEF2FF', text: '#4338CA', tint: 'rgba(99,102,241,0.2)' },
};

const DEFAULT: PosPalette = {
  bar:  colors.accent,
  bg:   colors.accentLight,
  text: colors.accentDark,
  tint: 'rgba(18,179,214,0.2)',
};

export function paletteFor(pos: string | null | undefined): PosPalette {
  if (!pos) return DEFAULT;
  return PALETTE[pos.toLowerCase()] ?? DEFAULT;
}
