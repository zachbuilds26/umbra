import BN from 'bn.js';
import Decimal from 'decimal.js';
import { PublicKey, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
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
import { DBC_QUOTE_MINT, buildEquityConfig, getEquityPreset } from './dbc-presets.js';
import { TtlCache } from '../../utils/cache.js';
import { badRequest, notFound, upstream, sanitizeProviderMessage, HttpError } from '../../utils/errors.js';
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

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function bs58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i] as number];
  return out;
}

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
  return { transaction: await finalizeUnsignedVersioned(tx, owner), quote };
}

/**
 * Wallet-ready form: wallets in this app sign VersionedTransaction, while the
 * SDK hands back a legacy one. Converting here means a curve swap goes through
 * exactly the same sign-and-relay path as a Jupiter swap.
 */
async function finalizeUnsignedVersioned(tx: unknown, feePayer: PublicKey): Promise<string> {
  try {
    const t = tx as Transaction;
    const { blockhash } = await getConnection().getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: feePayer,
      recentBlockhash: blockhash,
      instructions: t.instructions,
    }).compileToLegacyMessage();
    return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
  } catch (e) {
    dbcError(e, 'DBC transaction build failed');
  }
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
  quoteMint: string = DBC_QUOTE_MINT,
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
  if (!isValidSolanaPublicKey(quoteMint)) {
    throw badRequest('INVALID_ADDRESS', 'quoteMint is not a valid Solana address.');
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
      quoteMint: new PublicKey(quoteMint),
      payer: new PublicKey(payer),
    });
  } catch (e) {
    dbcError(e, 'DBC config transaction build failed');
  }
  return { transaction: await finalizeUnsigned(tx, new PublicKey(payer)), config, quoteMint };
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

/**
 * Submit a DBC swap the connected wallet signed. The wallet signs; we relay it
 * over our RPC. Verified first: a signed transaction can never confirm if it is
 * never sent, and we refuse to relay anything that isn't the user's own.
 */
export async function broadcastDbcTransaction(
  signedTransactionB64: string,
  userPublicKey: string,
): Promise<{ signature: string }> {
  if (!isValidSolanaAddress(userPublicKey)) {
    throw badRequest('INVALID_ADDRESS', 'userPublicKey is not a valid Solana address.');
  }
  if (!/^[A-Za-z0-9+/]{80,}={0,2}$/.test(signedTransactionB64)) {
    throw badRequest('VALIDATION_ERROR', 'transaction must be base64.');
  }
  let raw: Buffer;
  try {
    raw = Buffer.from(signedTransactionB64, 'base64');
  } catch {
    throw badRequest('VALIDATION_ERROR', 'transaction could not be decoded.');
  }
  // Wallets here sign versioned transactions; the config/pool builders still
  // produce legacy ones, so accept whichever shape the caller signed.
  let signer: string;
  let sig64: Uint8Array | null = null;
  try {
    const vtx = VersionedTransaction.deserialize(new Uint8Array(raw));
    const required = vtx.message.header?.numRequiredSignatures ?? 0;
    const first = vtx.signatures[0];
    if (!first || first.every((b) => b === 0)) {
      throw badRequest('VALIDATION_ERROR', 'Transaction is not signed.');
    }
    signer = required > 0 ? vtx.message.staticAccountKeys[0]?.toBase58() ?? '' : '';
    sig64 = first;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    let tx: Transaction;
    try {
      tx = Transaction.from(raw);
    } catch {
      throw badRequest('VALIDATION_ERROR', 'transaction could not be decoded.');
    }
    if (tx.signatures.some((s) => !s.signature || s.signature.equals(Buffer.alloc(64)))) {
      throw badRequest('VALIDATION_ERROR', 'Transaction is not signed.');
    }
    signer = tx.feePayer ? tx.feePayer.toBase58() : '';
    sig64 = new Uint8Array(tx.signatures[0]?.signature ?? []);
  }
  if (signer !== userPublicKey) {
    throw badRequest('VALIDATION_ERROR', 'Transaction signer does not match userPublicKey.');
  }
  let signature: string;
  try {
    signature = await getConnection().sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // A wallet that broadcast itself races us here; the tx is already known.
    if (!/already|processed|BlockhashNotFound/i.test(msg)) {
      throw upstream('PROVIDER_ERROR', 'Solana rejected this swap. Nothing was sent.');
    }
    signature = bs58(sig64 ?? new Uint8Array(64));
  }
  return { signature };
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
