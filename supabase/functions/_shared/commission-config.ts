/**
 * commission-config.ts — reads per-rail commission config from admin_config.
 *
 * Keys follow the existing convention (see migration 018 + 032):
 *   fees.<rail>.percent_bps
 *   fees.<rail>.fixed_pence
 *
 * Per-field fallback to DEFAULTS if a row is missing, blank, or non-integer —
 * so a missing/typoed row degrades to a sane default rather than breaking the
 * rail. A single console.info per call lists which fields fell back, so
 * misconfig is visible in logs without being noisy.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getConfigBulk } from './admin-config.ts';
import type { CommissionConfig } from './commission.ts';

export type Rail = 'fetch' | 'wallet' | 'product';

/**
 * In-code fallbacks. Must match the migration 032 seed values.
 * Keep these in sync if either side changes.
 */
export const DEFAULTS: Record<Rail, CommissionConfig> = {
  fetch:   { percent_bps:   0, fixed_pence: 150 },  // flat £1.50 per Fetch
  wallet:  { percent_bps: 200, fixed_pence:  25 },  // 2% + 25p
  product: { percent_bps: 400, fixed_pence:   0 },  // 4% — future product rail
};

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

export async function getCommissionConfig(
  supabase: SupabaseClient,
  rail: Rail,
): Promise<CommissionConfig> {
  const percentKey = `fees.${rail}.percent_bps`;
  const fixedKey   = `fees.${rail}.fixed_pence`;

  const map = await getConfigBulk(supabase, [percentKey, fixedKey]);

  const parsedPercent = parsePositiveInt(map.get(percentKey));
  const parsedFixed   = parsePositiveInt(map.get(fixedKey));

  const fellBack: string[] = [];
  if (parsedPercent === null) fellBack.push(percentKey);
  if (parsedFixed   === null) fellBack.push(fixedKey);

  if (fellBack.length > 0) {
    console.info(
      `[commission-config:${rail}] using default for: ${fellBack.join(', ')}`,
    );
  }

  return {
    percent_bps: parsedPercent ?? DEFAULTS[rail].percent_bps,
    fixed_pence: parsedFixed   ?? DEFAULTS[rail].fixed_pence,
  };
}
