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

export type Rail =
  | 'fetch'
  | 'wallet'
  | 'product'
  | 'gift'
  | 'unit'
  | 'donation'
  | 'membership';

/**
 * In-code fallbacks. Must match the migration 032 seed values.
 * Keep these in sync if either side changes.
 *
 * The gift/unit/donation/membership defaults were chosen to EXACTLY MATCH the
 * fee each function hardcoded before it moved onto the shared calculator, so
 * behaviour is unchanged until an admin tunes them. NOTE: the old gift/unit/
 * donation code used Math.round on the percentage; the shared calculator uses
 * Math.floor — so for amounts whose percentage lands on a ≥0.5p fraction the
 * fee is now 1p lower. See the refactor report for worked examples.
 */
export const DEFAULTS: Record<Rail, CommissionConfig> = {
  fetch:      { percent_bps:   0, fixed_pence: 150 },  // flat £1.50 per Fetch
  wallet:     { percent_bps: 200, fixed_pence:  25 },  // 2% + 25p
  product:    { percent_bps: 400, fixed_pence:   0 },  // 4% — future product rail
  gift:       { percent_bps: 500, fixed_pence:   0 },  // 5% — Book gift purchases
  unit:       { percent_bps: 500, fixed_pence:   0 },  // 5% — Book unit purchases
  donation:   { percent_bps: 150, fixed_pence:  20 },  // 1.5% + 20p — hub donations (~Stripe cost, hub-borne)
  membership: { percent_bps:   0, fixed_pence:  95 },  // flat 95p — hub paid memberships
};

function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

/* ── Wallet: tier-aware, server-resolved ──────────────────────────────────────
 *
 * Every other rail charges one rate regardless of who's selling. Wallet is
 * the first to charge DIFFERENTLY depending on who's being paid — Premium
 * gets a lower rate than Pro, as a subscription perk, not an accident of
 * when they joined.
 *
 * The tier comes from THIS QUERY, inside this function, never from the
 * caller. executeWalletPayment already resolves `business` server-side from
 * its own DB read before this is ever called — there is no client-supplied
 * tier anywhere in this path to begin with — but resolving it again here,
 * independently of whatever shape the caller's `business` object happens to
 * carry, means this function's answer can never silently drift from the
 * database's own current value of a column it was never actually passed.
 *
 * fees.wallet.percent_bps (the original, single, global key) is kept as the
 * fallback when a tier-specific key is missing or blank — so an admin who
 * never sets the new keys gets exactly today's behaviour, not a silent
 * change, and nothing that already reads the old key breaks.
 */
export async function getWalletCommissionConfig(
  supabase: SupabaseClient,
  businessId: string,
): Promise<CommissionConfig> {
  const { data: biz, error: bizErr } = await supabase
    .from('local_businesses')
    .select('subscription_tier')
    .eq('id', businessId)
    .maybeSingle();
  if (bizErr) {
    console.error(`[commission-config:wallet] could not resolve tier for business ${businessId}:`, bizErr);
  }
  // Anything that isn't literally 'premium' resolves as 'pro'. A business
  // below Pro should never reach this function — accepts_wallet and
  // business_meets_tier('pro') already refuse it earlier in
  // executeWalletPayment — so this is a fee lookup, not a second
  // entitlement check, and it fails safe (Pro's rate, never Premium's) if
  // the tier read itself is somehow unreadable.
  const tier: 'pro' | 'premium' = biz?.subscription_tier === 'premium' ? 'premium' : 'pro';
  const tierKey   = tier === 'premium' ? 'fees.wallet.premium_percent_bps' : 'fees.wallet.pro_percent_bps';
  const legacyKey = 'fees.wallet.percent_bps';
  const fixedKey  = 'fees.wallet.fixed_pence';

  const map = await getConfigBulk(supabase, [tierKey, legacyKey, fixedKey]);

  const tierPercent   = parsePositiveInt(map.get(tierKey));
  const legacyPercent = parsePositiveInt(map.get(legacyKey));
  const fixed         = parsePositiveInt(map.get(fixedKey));

  const fellBack: string[] = [];
  let percent_bps: number;
  if (tierPercent !== null) {
    percent_bps = tierPercent;
  } else if (legacyPercent !== null) {
    percent_bps = legacyPercent;
    fellBack.push(`${tierKey} → legacy ${legacyKey}`);
  } else {
    percent_bps = DEFAULTS.wallet.percent_bps;
    fellBack.push(`${tierKey} → in-code default`);
  }
  let fixed_pence: number;
  if (fixed !== null) {
    fixed_pence = fixed;
  } else {
    fixed_pence = DEFAULTS.wallet.fixed_pence;
    fellBack.push(`${fixedKey} → in-code default`);
  }

  if (fellBack.length > 0) {
    console.info(`[commission-config:wallet:${tier}] using fallback for: ${fellBack.join(', ')}`);
  }

  return { percent_bps, fixed_pence };
}

/**
 * The configurable comparison benchmark the merchant savings metric is
 * measured against. Deliberately NOT tied to any real card processor's
 * contract — it is an admin-set estimate, and the merchant-facing copy that
 * reads this value must say so.
 */
export interface WalletSavingsBenchmark {
  percent_bps: number;
  fixed_pence: number;
  enabled: boolean;
}

export async function getWalletSavingsBenchmark(
  supabase: SupabaseClient,
): Promise<WalletSavingsBenchmark> {
  const map = await getConfigBulk(supabase, [
    'wallet.savings.card_percent_bps',
    'wallet.savings.card_fixed_pence',
    'wallet.savings.enabled',
  ]);
  return {
    percent_bps: parsePositiveInt(map.get('wallet.savings.card_percent_bps')) ?? 175,
    fixed_pence: parsePositiveInt(map.get('wallet.savings.card_fixed_pence')) ?? 0,
    enabled: map.get('wallet.savings.enabled') === 'true',
  };
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
