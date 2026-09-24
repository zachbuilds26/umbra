import BN from 'bn.js';
import Decimal from 'decimal.js';
import { PublicKey } from '@solana/web3.js';
import {
  SwapMode,
  deriveDbcPoolAddress,
  getCurrentPoint,
  getPriceFromSqrtPrice,
  getTokenDecimals,
  type PoolConfig,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { getConnection } from '../solana/connection.js';
import { getDbcClient } from './dbc-client.js';
import { DBC_QUOTE_DECIMALS, DBC_QUOTE_MINT, buildEquityConfig, getEquityPreset } from './dbc-presets.js';
import { TtlCache } from '../../utils/cache.js';
import { badRequest, notFound, upstream, sanitizeProviderMessage } from '../../utils/errors.js';
import { isValidSolanaAddress, isValidSolanaPublicKey } from '../../utils/addresses.js';

Decimal.set({ precision: 40 });

// Umbra's DBC (Meteora Dynamic Bonding Curve) layer: equity-tuned launches,
// pool reads, quotes and unsigned transactions. Same rules as the rest of the
// backend — provider shapes never leave this module (domain objects only),
// no custody (unsigned base64 transactions the user's wallet signs).

export interface DbcPoolState {
  pool: string;
  config: string;
  baseMint: string;
  quoteMint: string;
  creator: string;
  baseReserve: string;
  quoteReserve: string;
  /** 0..1 progress toward the migration quote threshold. */
  curveProgress: number;
  migrationQuoteThreshold: string;
  quoteDecimals: number;
  baseDecimals: number;
}

export interface DbcQuote {
  pool: string;
  side: 'buy' | 'sell';
  amountIn: string;
  amountInDisplay: string;
  amountOut: string;
  amountOutDisplay: string;
  minimumOut: string;
  tradingFee: string;
  /** Human price (quote per base) after the swap. */
  priceAfter: string | null;
}

const POOL_CACHE_MS = 30 * 1000;
const poolCache = new TtlCache<DbcPoolState>(POOL_CACHE_MS);

function dbcError(e: unknown, fallback: string): never {
  const msg = e instanceof Error ? sanitizeProviderMessage(e.message) : fallback;
  throw upstream('PROVIDER_ERROR', `${fallback}: ${msg}`);
}

function toDisplay(amountBaseUnits: BN, decimals: number): string {
  return new Decimal(amountBaseUnits.toString()).div(new Decimal(10).pow(decimals)).toString();
}

function toBaseUnits(amountDisplay: string, decimals: number): BN {
  const scaled = new Decimal(amountDisplay).mul(new Decimal(10).pow(decimals)).floor();
  return new BN(scaled.toFixed(0));
}

function asB58(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof (v as { toBase58?: unknown }).toBase58 === 'function') return (v as { toBase58: () => string }).toBase58();
  return String(v ?? '');
}

interface PoolContext {
  poolAddress: string;
  pool: VirtualPool;
  config: PoolConfig;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
}

async function resolvePoolContext(poolAddress: string): Promise<PoolContext> {
  const dbc = getDbcClient();
  const pool = await dbc.state.getPool(poolAddress).catch(() => null);
  if (!pool) throw notFound('NOT_FOUND', `No DBC pool at ${poolAddress}.`);
  const poolFields = pool as unknown as Record<string, unknown>;
  const configAddress = asB58(poolFields.config);
  if (!configAddress) throw notFound('NOT_FOUND', `DBC pool ${poolAddress} has no config.`);
  const config = await dbc.state.getPoolConfig(configAddress).catch(() => null);
  if (!config) throw notFound('NOT_FOUND', `DBC config for pool ${poolAddress} is unreadable.`);
  const configFields = config as unknown as Record<string, unknown>;
  const baseMint = asB58(poolFields.baseMint);
  const quoteMint = asB58(configFields.quoteMint);
  // Token units are never guessed. A pool whose quote mint or decimals we
  // cannot read must fail closed: assuming 8 decimals/USDC would build a
  // signable transaction whose amounts are off by orders of magnitude.
  if (!baseMint || !quoteMint) {
    throw dbcError(new Error('DBC pool metadata is incomplete'), 'DBC pool unreadable');
  }
  const [baseDecimals, quoteDecimals] = await Promise.all([
    Promise.resolve().then(() => getTokenDecimals(getConnection(), new PublicKey(baseMint))),
    Promise.resolve().then(() => getTokenDecimals(getConnection(), new PublicKey(quoteMint))),
  ]).catch((err: unknown) => {
    throw dbcError(err instanceof Error ? err : new Error(String(err)), 'DBC token decimals unreadable');
  });
  return { poolAddress, pool, config, baseMint, quoteMint, baseDecimals, quoteDecimals };
}

/**
 * Pool state for the first DBC pool launched on a base mint (or null when no
 * pool exists yet — the honest answer for unlaunched names).
 */
export async function getDbcPoolByMint(baseMint: string): Promise<DbcPoolState | null> {
  if (!isValidSolanaAddress(baseMint)) {
    throw badRequest('INVALID_ADDRESS', 'baseMint is not a valid Solana address.');
  }
  const cacheKey = `pool:${baseMint}`;
  const cached = poolCache.get(cacheKey);
  if (cached) return cached;
  const dbc = getDbcClient();
  let found;
  try {
    found = await dbc.state.getPoolByBaseMint(baseMint);
  } catch (e) {
    dbcError(e, 'DBC pool lookup failed');
  }
  if (!found) return null;
  const poolAddress = found.publicKey.toBase58();
  const ctx = await resolvePoolContext(poolAddress).catch(() => null);
  if (!ctx) return null;
  const poolFields = ctx.pool as unknown as Record<string, unknown>;
  const [progress, threshold] = await Promise.all([
    dbc.state.getPoolQuoteTokenCurveProgress(poolAddress).catch(() => 0),
    dbc.state.getPoolMigrationQuoteThreshold(poolAddress).catch(() => new BN(0)),
  ]);
  const state: DbcPoolState = {
    pool: poolAddress,
    config: asB58(poolFields.config),
    baseMint,
    quoteMint: ctx.quoteMint,
    creator: asB58(poolFields.creator),
    baseReserve: String(poolFields.baseReserve ?? ''),
    quoteReserve: String(poolFields.quoteReserve ?? ''),
    curveProgress: Math.round(progress * 10000) / 10000,
    migrationQuoteThreshold: threshold.toString(),
    quoteDecimals: ctx.quoteDecimals,
    baseDecimals: ctx.baseDecimals,
  };
  poolCache.set(cacheKey, state);
  return state;
}

/** Live exact-in quote against an existing pool (buy = quote→base, sell = base→quote). */
export async function getDbcQuote(
  poolAddress: string,
  side: 'buy' | 'sell',
  amountDisplay: string,
  slippageBps: number,
): Promise<DbcQuote> {
  if (!isValidSolanaPublicKey(poolAddress)) {
    throw badRequest('INVALID_ADDRESS', 'pool is not a valid Solana address.');
  }
  const dbc = getDbcClient();
  const ctx = await resolvePoolContext(poolAddress);
  const swapBaseForQuote = side === 'sell';
  const inDecimals = swapBaseForQuote ? ctx.baseDecimals : ctx.quoteDecimals;
  const outDecimals = swapBaseForQuote ? ctx.quoteDecimals : ctx.baseDecimals;
  // Garbage amounts must be a 400, never an unhandled Decimal throw (500).
  let amountIn: BN;
  try {
    amountIn = toBaseUnits(amountDisplay, inDecimals);
  } catch {
    throw badRequest('VALIDATION_ERROR', 'Amount must be greater than zero.');
  }
  if (amountIn.lte(new BN(0))) throw badRequest('VALIDATION_ERROR', 'Amount must be positive.');
  let quote;
  try {
    const activationType = (ctx.config as unknown as { activationType: number }).activationType;
    const currentPoint = await getCurrentPoint(getConnection(), activationType);
    quote = dbc.pool.swapQuote2({
      virtualPool: ctx.pool,
      config: ctx.config,
      swapBaseForQuote,
      hasReferral: false,
      // Conservative: assume NOT the fee-discounted first swap, so the
      // quoted minimum is never overstated.
      eligibleForFirstSwapWithMinFee: false,
      currentPoint,
      slippageBps,
      swapMode: SwapMode.ExactIn,
      amountIn,
    });
  } catch (e) {
    dbcError(e, 'DBC quote failed');
  }
  // SwapQuote2Result's generated type doesn't expose the IDL fields, so read
  // them structurally (runtime shape per the published IDL: outputAmount,
  // nextSqrtPrice, minimumAmountOut?, tradingFee?).
  const q = quote as unknown as {
    outputAmount: BN;
    nextSqrtPrice: BN;
    minimumAmountOut?: BN;
    tradingFee?: BN;
  };
  // A missing/zero output is "no route", never a quotable price: refuse it
  // instead of serving amountOut "0" or throwing a TypeError (500) below.
  if (!q || !q.outputAmount || q.outputAmount.toString() === '0') {
    dbcError(new Error('swapQuote2 returned no output amount'), 'DBC quote failed');
  }
  let priceAfter: string | null = null;
  try {
    const tokenDecimal = (ctx.config as unknown as { tokenDecimal: number }).tokenDecimal;
    priceAfter = getPriceFromSqrtPrice(q.nextSqrtPrice, tokenDecimal ?? ctx.baseDecimals, ctx.quoteDecimals).toString();
  } catch {
    priceAfter = null;
  }
  return {
    pool: poolAddress,
    side,
    amountIn: amountIn.toString(),
    amountInDisplay: amountDisplay,
    amountOut: q.outputAmount.toString(),
    amountOutDisplay: toDisplay(q.outputAmount, outDecimals),
    minimumOut: (q.minimumAmountOut ?? q.outputAmount).toString(),
    tradingFee: (q.tradingFee ?? new BN(0)).toString(),
    priceAfter,
  };
}

/** Unsigned exact-in swap transaction (legacy Transaction, base64). User wallet signs. */
export async function buildDbcSwapTransaction(
  poolAddress: string,
  side: 'buy' | 'sell',
  amountDisplay: string,
  userPublicKey: string,
  slippageBps: number,
): Promise<{ transaction: string; quote: DbcQuote }> {
  if (!isValidSolanaPublicKey(poolAddress)) {
    throw badRequest('INVALID_ADDRESS', 'pool is not a valid Solana address.');
  }
  if (!isValidSolanaAddress(userPublicKey)) {
    throw badRequest('INVALID_ADDRESS', 'userPublicKey is not a valid Solana address.');
  }
  const quote = await getDbcQuote(poolAddress, side, amountDisplay, slippageBps);
  const dbc = getDbcClient();
  const owner = new PublicKey(userPublicKey);
  let tx;
  try {
    tx = await dbc.pool.swap2({
      owner,
      pool: new PublicKey(poolAddress),
      swapBaseForQuote: side === 'sell',
      referralTokenAccount: null,
      payer: owner,
      swapMode: SwapMode.ExactIn,
      amountIn: new BN(quote.amountIn),
      minimumAmountOut: new BN(quote.minimumOut),
    });
  } catch (e) {
    dbcError(e, 'DBC swap transaction build failed');
  }
  return { transaction: await finalizeUnsigned(tx, owner), quote };
}

/**
 * Unsigned createConfig transaction for an equity preset. The config account
 * is a fresh Keypair that must ALSO sign — so the caller generates it and
 * passes its pubkey; the backend never sees the secret (no custody).
 */
export async function buildDbcCreateConfigTransaction(
  presetId: string,
  config: string,
  feeClaimer: string,
  leftoverReceiver: string,
  payer: string,
): Promise<{ transaction: string; config: string; quoteMint: string }> {
  if (!getEquityPreset(presetId)) {
    throw badRequest('VALIDATION_ERROR', `Unknown DBC preset: ${presetId}.`);
  }
  for (const [label, value] of [
    ['config', config],
    ['feeClaimer', feeClaimer],
    ['leftoverReceiver', leftoverReceiver],
    ['payer', payer],
  ] as const) {
    if (!isValidSolanaAddress(value)) {
      throw badRequest('INVALID_ADDRESS', `${label} is not a valid Solana address.`);
    }
  }
  const { config: params } = buildEquityConfig(presetId, leftoverReceiver);
  const dbc = getDbcClient();
  let tx;
  try {
    tx = await dbc.partner.createConfig({
      // Spread first: the built params carry leftoverReceiver as a string,
      // and the explicit PublicKey accounts below must win.
      ...params,
      config: new PublicKey(config),
      feeClaimer: new PublicKey(feeClaimer),
      leftoverReceiver: new PublicKey(leftoverReceiver),
      quoteMint: new PublicKey(DBC_QUOTE_MINT),
      payer: new PublicKey(payer),
    });
  } catch (e) {
    dbcError(e, 'DBC config transaction build failed');
  }
  return { transaction: await finalizeUnsigned(tx, new PublicKey(payer)), config, quoteMint: DBC_QUOTE_MINT };
}

/**
 * Unsigned createPool transaction from an existing config. The pool is a
 * deterministic PDA (no extra signer) — only the payer/creator signs.
 */
export async function buildDbcCreatePoolTransaction(
  configAddress: string,
  baseMint: string,
  name: string,
  symbol: string,
  uri: string,
  payer: string,
  poolCreator?: string,
): Promise<{ transaction: string; pool: string; config: string }> {
  for (const [label, value] of [
    ['config', configAddress],
    ['baseMint', baseMint],
    ['payer', payer],
    ...(poolCreator ? [['poolCreator', poolCreator] as const] : []),
  ] as const) {
    if (!isValidSolanaAddress(value)) {
      throw badRequest('INVALID_ADDRESS', `${label} is not a valid Solana address.`);
    }
  }
  const dbc = getDbcClient();
  const pool = deriveDbcPoolAddress(new PublicKey(DBC_QUOTE_MINT), new PublicKey(baseMint), new PublicKey(configAddress));
  let tx;
  try {
    tx = await dbc.creator.createPool({
      name,
      symbol,
      uri,
      payer: new PublicKey(payer),
      poolCreator: new PublicKey(poolCreator ?? payer),
      config: new PublicKey(configAddress),
      baseMint: new PublicKey(baseMint),
    });
  } catch (e) {
    dbcError(e, 'DBC pool transaction build failed');
  }
  return { transaction: await finalizeUnsigned(tx, new PublicKey(payer)), pool: pool.toBase58(), config: configAddress };
}

interface UnsignedTx {
  feePayer: unknown;
  recentBlockhash: unknown;
  serialize: (opts: { requireAllSignatures: boolean }) => Buffer;
}

async function finalizeUnsigned(tx: unknown, feePayer: PublicKey): Promise<string> {
  try {
    const t = tx as unknown as UnsignedTx;
    (t as { feePayer: PublicKey }).feePayer = feePayer;
    const { blockhash } = await getConnection().getLatestBlockhash('confirmed');
    (t as { recentBlockhash: string }).recentBlockhash = blockhash;
    return t.serialize({ requireAllSignatures: false }).toString('base64');
  } catch (e) {
    dbcError(e, 'DBC transaction build failed');
  }
}
