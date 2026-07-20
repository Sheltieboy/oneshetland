/**
 * lib/spik-variations-api.ts
 *
 * Reads approved Spik "local variation" contributions for a word, plus the
 * list of Shetland regions used to tag a new variation.
 *
 * A word can be spelled / said differently around Shetland. Contributors add a
 * regional variation (with their own audio of the word and an example
 * sentence) via app/spik-add-variation.tsx. Only rows with status 'approved'
 * are public — RLS enforces this, so the authed supabase client is fine here.
 */

import { supabase } from '@/lib/supabase';

export interface SpikVariation {
  id:                 string;
  word_id:            number;
  region_id:          string | null;
  region_name:        string | null;
  variant_spelling:   string | null;
  pronunciation:      string | null;
  word_audio_url:     string | null;
  sentence_text:      string | null;
  sentence_audio_url: string | null;
  contributor_name:   string | null;
  show_name:          boolean;
  created_at:         string;
}

export interface SpikRegion {
  id:   string;
  slug: string;
  name: string;
}

/**
 * Approved variations for a word, ordered by region then oldest-first.
 * Returns [] on any error so callers can render an empty state safely.
 */
export async function fetchWordVariations(wordId: number): Promise<SpikVariation[]> {
  try {
    const { data, error } = await supabase
      .from('spik_word_variations')
      .select(
        'id, word_id, region_id, region_name, variant_spelling, pronunciation, word_audio_url, sentence_text, sentence_audio_url, contributor_name, show_name, created_at',
      )
      .eq('word_id', wordId)
      .eq('status', 'approved')
      .order('region_name', { ascending: true })
      .order('created_at', { ascending: true });

    if (error) return [];
    return (data ?? []) as SpikVariation[];
  } catch {
    return [];
  }
}

/**
 * The Shetland regions used to tag a variation, ordered for display.
 * Returns [] on any error.
 */
export async function fetchRegions(): Promise<SpikRegion[]> {
  try {
    const { data, error } = await supabase
      .from('regions')
      .select('id, slug, name')
      .order('display_order', { ascending: true });

    if (error) return [];
    return (data ?? []) as SpikRegion[];
  } catch {
    return [];
  }
}
