/**
 * lib/memory-eras.ts
 *
 * Gives each historical era its own colour + icon so the Memories feed reads
 * as a varied, living timeline rather than a wall of identical rose tiles.
 * Matching is keyword-based and forgiving (free-text eras like "Iron Age",
 * "Norse / Viking", "Multiple eras" all resolve sensibly); anything unknown
 * falls back to the Memories rose.
 */

import { SECTIONS } from '@/constants/sections';

export interface EraTone {
  color: string;
  light: string;
  icon:  string;   // FontAwesome5 (solid) name
}

const ROSE: EraTone = {
  color: SECTIONS.memories.color,
  light: SECTIONS.memories.light,
  icon:  'book-open',
};

const RULES: { test: RegExp; tone: EraTone }[] = [
  { test: /neolith|stone age|standing stone/i, tone: { color: '#B45309', light: '#FEF3C7', icon: 'gem' } },
  { test: /bronze/i,                           tone: { color: '#9A3412', light: '#FFEDD5', icon: 'ring' } },
  { test: /iron age|broch/i,                   tone: { color: '#0F766E', light: '#CCFBF1', icon: 'hammer' } },
  { test: /pict/i,                             tone: { color: '#7C3AED', light: '#EDE9FE', icon: 'monument' } },
  { test: /norse|viking|norn/i,                tone: { color: '#1D4ED8', light: '#DBEAFE', icon: 'anchor' } },
  { test: /medieval|middle ages|kirk|abbey/i,  tone: { color: '#15803D', light: '#DCFCE7', icon: 'landmark' } },
  { test: /croft|18th|19th|victorian|herring/i, tone: { color: '#92400E', light: '#FEF3C7', icon: 'tractor' } },
  { test: /war|ww1|ww2|wartime|194\d|home guard/i, tone: { color: '#475569', light: '#E2E8F0', icon: 'shield-alt' } },
  { test: /multiple|mixed|through the years|various/i, tone: { color: '#6D28D9', light: '#F3E8FF', icon: 'layer-group' } },
];

export function eraTone(era?: string | null): EraTone {
  if (!era) return ROSE;
  for (const r of RULES) if (r.test.test(era)) return r.tone;
  return ROSE;
}
