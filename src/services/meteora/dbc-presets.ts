import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DammV2DynamicFeeMode,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithTwoSegments,
  getPriceFromSqrtPrice,
  validateConfigParameters,
  type ConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { SOLANA_USDC_MINT } from '../xstocks/assets.service.js';

// Equity-tuned DBC launch presets — the bounty-originality piece. Memecoin
// launches use steep exponential curves + high fees; equity-like assets want
// the opposite: a flat two-segment curve (orderly price discovery), low fixed
// fees, no dynamic-volatility fee (stocks don't need meme anti-snipe), and a
// USDC migration threshold at/above 750 USDC so Meteora's mainnet keepers
// auto-migrate finished pools to DAMM v2 (docs: keeper threshold table).
//
// All amounts below are human units; the builder converts to base units.

export interface EquityPresetDef {
  id: string;
  name: string;
  description: string;
  /** Base token decimals (TokenDecimal enum value). */
  baseDecimals: TokenDecimal;
  /** Total token supply in whole tokens. */
  totalSupply: number;
  initialMarketCapUsd: number;
  migrationMarketCapUsd: number;
  /** % of supply sold by migration (flat-curve => high, orderly). */
  percentageSupplyOnMigration: number;
  startingFeeBps: number;
  endingFeeBps: number;
  /** DAMM v2 fee after migration (bps). 100 matches a keeper fee key. */
  migratedPoolFeeBps: number;
}

export const EQUITY_PRESETS: EquityPresetDef[] = [
  {
    id: 'equity-discovery',
    name: 'Equity Discovery',
    description:
      'Price discovery for thinly-traded or newly tokenized stocks with no reliable Jupiter price (e.g. MDTx/MEITx/MIXUx today). Low start mcap, flat two-segment curve, 750 USDC graduation for keeper auto-migration.',
    baseDecimals: TokenDecimal.EIGHT,
    totalSupply: 1_000_000_000,
    initialMarketCapUsd: 50_000,
    migrationMarketCapUsd: 500_000,
    percentageSupplyOnMigration: 30,
    startingFeeBps: 100,
    endingFeeBps: 50,
    migratedPoolFeeBps: 100,
  },
  {
    id: 'equity-bluechip',
    name: 'Equity Blue-Chip',
    description:
      'Higher-valuation launches tracking liquid names. Tighter fees end-to-end; same keeper-compatible 750 USDC graduation into a 25bps DAMM v2 pool.',
    baseDecimals: TokenDecimal.EIGHT,
    totalSupply: 1_000_000_000,
    initialMarketCapUsd: 500_000,
    migrationMarketCapUsd: 5_000_000,
    percentageSupplyOnMigration: 20,
    startingFeeBps: 50,
    endingFeeBps: 25,
    migratedPoolFeeBps: 25,
  },
  {
    id: 'preipo-fractional',
    name: 'Pre-IPO Fractional',
    description:
      'Fractional exposure to pre-IPO style names (9-decimal base, matching the PreStocks shelf). Wide mcap band for long discovery, keeper-compatible graduation.',
    baseDecimals: TokenDecimal.NINE,
    totalSupply: 1_000_000_000,
    initialMarketCapUsd: 100_000,
    migrationMarketCapUsd: 2_000_000,
    percentageSupplyOnMigration: 25,
    startingFeeBps: 100,
    endingFeeBps: 50,
    migratedPoolFeeBps: 100,
  },
];

/** USDC quote, 6 decimals — keeper-supported with a 750 USDC threshold. */
export const DBC_QUOTE_MINT = SOLANA_USDC_MINT;
export const DBC_QUOTE_DECIMALS = 6;
/** Keeper auto-migration floor for USDC-quoted pools (750 USDC, base units). */
export const DBC_KEEPER_THRESHOLD_BASE_UNITS = 750_000_000;

export function getEquityPreset(id: string): EquityPresetDef | null {
  return EQUITY_PRESETS.find((p) => p.id === id) ?? null;
}

/** Assemble the curve math without attaching a receiver or validating. */
export function assembleEquityCurve(presetId: string): { preset: EquityPresetDef; config: ConfigParameters } {
  const preset = getEquityPreset(presetId);
  if (!preset) throw new Error(`Unknown DBC preset: ${presetId}`);
  const config = buildCurveWithTwoSegments({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: preset.baseDecimals,
      tokenQuoteDecimal: TokenDecimal.SIX,
      tokenAuthorityOption: TokenAuthorityOption.CreatorUpdateAuthority,
      totalTokenSupply: preset.totalSupply,
      // Rounding buffer the curve math requires (must exceed the supply
      // delta from fixed-point rounding); dust to the leftover receiver.
      leftover: 100_000,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: preset.startingFeeBps,
          endingFeeBps: preset.endingFeeBps,
          numberOfPeriod: 10,
          totalDuration: 7 * 24 * 3600,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 50,
      // No creation fee (0 = free launches; min non-zero is 0.001 SOL).
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: true,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption:
        preset.migratedPoolFeeBps <= 25
          ? MigrationFeeOption.FixedBps25
          : preset.migratedPoolFeeBps <= 30
            ? MigrationFeeOption.FixedBps30
            : MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: DammV2DynamicFeeMode.Disabled,
        poolFeeBps: preset.migratedPoolFeeBps,
      },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 0,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 20,
      creatorLiquidityPercentage: 80,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    initialMarketCap: preset.initialMarketCapUsd,
    migrationMarketCap: preset.migrationMarketCapUsd,
    percentageSupplyOnMigration: preset.percentageSupplyOnMigration,
  });
  return { preset, config };
}

/**
 * Build validated on-chain ConfigParameters for a preset. Throws on invalid
 * input — validateConfigParameters is the SDK's own guard, so a preset that
 * builds here is safe to send to createConfig.
 *
 * leftoverReceiver is required: the SDK's supply check reads it off the
 * config object (leftover dust after migration goes there). Callers pass the
 * wallet that will sign createConfig (usually feeClaimer/payer).
 */
/** Preset def + real curve economics for API responses (pure math, no RPC). */
export function describePreset(presetId: string): (EquityPresetDef & {
  startPriceUsd: string | null;
  migrationThresholdUsdc: string | null;
  keeperAutoMigrate: boolean;
}) | null {
  const preset = getEquityPreset(presetId);
  if (!preset) return null;
  try {
    const { config } = assembleEquityCurve(presetId);
    const c = config as unknown as {
      sqrtStartPrice: BN;
      migrationQuoteThreshold: BN;
    };
    const startPrice = getPriceFromSqrtPrice(c.sqrtStartPrice, preset.baseDecimals, DBC_QUOTE_DECIMALS).toString();
    const thresholdBaseUnits = c.migrationQuoteThreshold.toString();
    const thresholdUsdc = (Number(thresholdBaseUnits) / 10 ** DBC_QUOTE_DECIMALS).toString();
    return {
      ...preset,
      startPriceUsd: startPrice,
      migrationThresholdUsdc: thresholdUsdc,
      keeperAutoMigrate: Number(thresholdBaseUnits) >= DBC_KEEPER_THRESHOLD_BASE_UNITS,
    };
  } catch {
    return { ...preset, startPriceUsd: null, migrationThresholdUsdc: null, keeperAutoMigrate: false };
  }
}

export function buildEquityConfig(
  presetId: string,
  leftoverReceiver: string,
): { preset: EquityPresetDef; config: ConfigParameters } {
  const { preset, config } = assembleEquityCurve(presetId);
  // Attach before validating — the SDK reads leftoverReceiver during its
  // own supply check (validation.ts), and createConfig needs it as an account.
  const withReceiver = { ...config, leftoverReceiver: new PublicKey(leftoverReceiver) };
  // Returns void — throws with the SDK's own message when invalid.
  validateConfigParameters(withReceiver);
  return { preset, config: withReceiver };
}
