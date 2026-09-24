import Decimal from 'decimal.js';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  createInitializeAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { getJupiterOrder, type JupiterOrderResponse } from './client.js';
import { getConnection } from '../solana/connection.js';
import { getSolanaMint, getMultiplier, getPrice, canonicalSymbol, isStableSymbol } from '../xstocks/assets.service.js';
import { displayToBaseUnits, baseUnitsToDisplay } from '../solana/multiplier.js';
import { isValidSolanaAddress } from '../../utils/addresses.js';
import { newQuoteId } from '../../utils/ids.js';
import { quoteStore } from '../quotes.store.js';
import { badRequest, upstream, HttpError } from '../../utils/errors.js';
import type { UmbraQuote } from '../../domain/models.js';

Decimal.set({ precision: 40 });

const QUOTE_TTL_S = 60;
const DEFAULT_SLIPPAGE_BPS = 50;

/** Wrapped SOL is the mint Jupiter routes SOL through; native SOL itself is not
 *  an SPL token. 9 decimals on both sides of a wrap. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_DECIMALS = 9;

/** The "base" side of a swap: what you pay in or receive out. */
export function isBaseSymbol(symbol: string): boolean {
  const s = canonicalSymbol(symbol).toUpperCase();
  return s === 'SOL' || isStableSymbol(s);
}

interface ResolvedSide {
  symbol: string;
  mint: string;
  decimals: number;
}

/** Resolve a domain symbol to its verified Solana mint. Rejects arbitrary mints (plan §11). */
async function resolveSide(symbol: string, extraStocks: Set<string> = new Set()): Promise<ResolvedSide> {
  // xStocks symbols are case-sensitive upstream (NVDAx, not NVDAX) — canonicalize, never blindly upper-case.
  // Exception: PreStocks symbols are ALL-CAPS (SPACEX); the set disambiguates the ...X collision.
  let canonical = canonicalSymbol(symbol);
  if (extraStocks.has(canonical.toUpperCase())) canonical = canonical.toUpperCase();
  if (canonical === 'SOL') {
    return { symbol: 'SOL', mint: SOL_MINT, decimals: SOL_DECIMALS };
  }
  if (!isStableSymbol(canonical) && !/^[A-Z0-9]+x$/.test(canonical) && !/^[A-Z]{2,12}$/.test(canonical)) {
    throw badRequest('UNSUPPORTED_ASSET', `Asset ${symbol} is not supported for swap.`);
  }
  // getSolanaMint is authoritative: unknown symbols resolve to null here even if
  // they pass the shape gate above (plan §11 — no arbitrary mints).
  const found = await getSolanaMint(canonical);
  if (!found) throw badRequest('UNSUPPORTED_ASSET', `Asset ${symbol} has no verified Solana mint.`);
  return { symbol: canonical, mint: found.mint, decimals: found.decimals };
}

/**
 * Umbra swaps one stock against one base asset (USDC, USDT or SOL) on Solana.
 * No stock→stock, no base→base. Pure (no network) so bad pairs fail fast and
 * offline-testably; the caller supplies the live PreStocks set.
 */
export function assertStockStablePair(
  sell: string,
  buy: string,
  extraStocks: Set<string> = new Set(),
): { stock: string; stable: string } {
  const s = canonicalSymbol(sell);
  const b = canonicalSymbol(buy);
  const isStock = (sym: string) => /^[A-Z0-9]+x$/.test(sym) || extraStocks.has(sym.toUpperCase());
  const normStock = (sym: string) => (extraStocks.has(sym.toUpperCase()) ? sym.toUpperCase() : sym);
  const sBase = isBaseSymbol(s);
  const bBase = isBaseSymbol(b);
  if (sBase && isStock(b)) return { stock: normStock(b), stable: s.toUpperCase() };
  if (bBase && isStock(s)) return { stock: normStock(s), stable: b.toUpperCase() };
  throw badRequest(
    'UNSUPPORTED_ASSET',
    `Swaps are only supported between a tokenized stock and USDC, USDT or SOL. Got ${sell} → ${buy}.`,
  );
}

/** Display amount -> base units. Base assets 6dp (USDC/USDT) or 9dp (SOL);
 *  PreStocks plain 9dp; xStocks apply the live multiplier (plan §10). */
async function toBaseUnits(symbol: string, displayAmount: string): Promise<string> {
  if (isStableSymbol(symbol)) {
    return new Decimal(displayAmount).mul(new Decimal(10).pow(6)).floor().toFixed(0);
  }
  if (canonicalSymbol(symbol).toUpperCase() === 'SOL') {
    return new Decimal(displayAmount).mul(new Decimal(10).pow(SOL_DECIMALS)).floor().toFixed(0);
  }
  const { getPrestocksSymbols, PRESTOCKS_DECIMALS } = await import('../prestocks/assets.js');
  const pre = await getPrestocksSymbols().catch(() => new Set<string>());
  if (pre.has(symbol.toUpperCase())) {
    return new Decimal(displayAmount).mul(new Decimal(10).pow(PRESTOCKS_DECIMALS)).floor().toFixed(0);
  }
  // getMultiplier never throws (it degrades to last-known/null), so a failure
  // here is a genuine "we cannot convert units" — one clean message, no
  // transport text leaking through from the provider fetch.
  const multiplier = await getMultiplier(symbol, 'Solana').catch(() => null);
  if (!multiplier) {
    throw upstream(
      'QUOTE_UNAVAILABLE',
      `${symbol} pricing is temporarily unavailable, so we cannot quote it right now. Try again shortly or pick another asset.`,
    );
  }
  return displayToBaseUnits(displayAmount, multiplier, 8);
}

/** Base units -> display amount (applies multiplier for xStocks; plain for base assets/PreStocks). */
async function fromBaseUnits(symbol: string, baseUnits: string): Promise<string> {
  if (isStableSymbol(symbol)) {
    return new Decimal(baseUnits).div(new Decimal(10).pow(6)).toString();
  }
  if (canonicalSymbol(symbol).toUpperCase() === 'SOL') {
    return new Decimal(baseUnits).div(new Decimal(10).pow(SOL_DECIMALS)).toString();
  }
  const { getPrestocksSymbols, PRESTOCKS_DECIMALS } = await import('../prestocks/assets.js');
  const pre = await getPrestocksSymbols().catch(() => new Set<string>());
  if (pre.has(symbol.toUpperCase())) {
    return new Decimal(baseUnits).div(new Decimal(10).pow(PRESTOCKS_DECIMALS)).toString();
  }
  const multiplier = await getMultiplier(symbol, 'Solana').catch(() => null);
  if (!multiplier) {
    throw upstream(
      'QUOTE_UNAVAILABLE',
      `${symbol} pricing is temporarily unavailable, so we cannot quote it right now. Try again shortly or pick another asset.`,
    );
  }
  return baseUnitsToDisplay(baseUnits, multiplier, 8);
}

async function fetchOrder(args: {
  inputMint: string;
  outputMint: string;
  amountBaseUnits: string;
  taker?: string;
  slippageBps: number;
}): Promise<JupiterOrderResponse> {
  let res;
  try {
    res = await getJupiterOrder(args);
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 429) {
      throw new HttpError(429, 'RATE_LIMITED', 'Quote provider is rate limiting us — retry in a moment.');
    }
    // Never pass a raw transport error (timeouts, aborts, socket text) to the
    // user: it says nothing they can act on.
    throw upstream('SWAP_UNAVAILABLE', 'Our quote provider did not respond. Try again in a moment.');
  }
  if (!res.data) {
    // Jupiter 400 = no route for this exact pair/amount (thin or missing pools),
    // not a bug in the request. Say so plainly instead of leaking "upstream 400".
    if (res.status === 400) {
      throw upstream(
        'INSUFFICIENT_LIQUIDITY',
        'No swap route for this pair and amount right now (thin liquidity). Try a smaller amount or the reverse direction.',
      );
    }
    if (res.status === 429) {
      throw new HttpError(429, 'RATE_LIMITED', 'Quote provider is rate limiting us — retry in a moment.');
    }
    throw upstream('SWAP_UNAVAILABLE', `Swap quote unavailable (upstream ${res.status}).`);
  }
  const order = res.data;
  if (order.transaction === '' || order.errorCode) {
    const msg = order.errorMessage || 'Jupiter could not build this swap.';
    if (/insufficient/i.test(msg)) {
      throw upstream('INSUFFICIENT_LIQUIDITY', msg);
    }
    throw upstream('SWAP_UNAVAILABLE', msg);
  }
  return order;
}

/**
 * Real network fee = Jupiter's signature + prioritization + rent lamports.
 * Zero/absent (quote-only, no taker) -> conservative 0.00001 SOL *marked estimated*.
 */
export function networkFeeFromOrder(order: JupiterOrderResponse): { currency: 'SOL'; amount: string; estimated: boolean } {
  const total = (order.signatureFeeLamports ?? 0) + (order.prioritizationFeeLamports ?? 0) + (order.rentFeeLamports ?? 0);
  if (total > 0) {
    const sol = new Decimal(total).div(new Decimal(10).pow(9)).toString();
    return { currency: 'SOL', amount: sol, estimated: false };
  }
  return { currency: 'SOL', amount: '0.00001', estimated: true };
}

function normalizeQuote(args: {
  quoteId: string;
  sellSide: ResolvedSide;
  buySide: ResolvedSide;
  amount: string;
  receiveDisplay: string;
  usdValue: string | null;
  minimumReceived: string;
  expiresAt: string;
  networkFee: { currency: 'SOL'; amount: string; estimated: boolean };
  platformFeeBps: number | null;
}): UmbraQuote {
  const { sellSide, buySide, amount, receiveDisplay } = args;
  return {
    quoteId: args.quoteId,
    sell: { symbol: sellSide.symbol, amount, mint: sellSide.mint },
    receive: { symbol: buySide.symbol, amount: receiveDisplay, usdValue: args.usdValue, mint: buySide.mint },
    rate: buildRate(sellSide.symbol, buySide.symbol, amount, receiveDisplay),
    priceImpactBps: null,
    networkFee: args.networkFee,
    platformFeeBps: args.platformFeeBps,
    minimumReceived: args.minimumReceived,
    // Provider-neutral route derived from the actual quote (plan §1.3). Never invented venues.
    route: [{ symbol: sellSide.symbol }, { symbol: buySide.symbol }],
    expiresAt: args.expiresAt,
    transaction: null,
  };
}

function buildRate(sell: string, buy: string, sellAmount: string, receiveAmount: string): string {
  try {
    if (isBaseSymbol(buy)) {
      // Receiving USDC/USDT/SOL: price per unit sold, quoted in dollars.
      const perSell = new Decimal(receiveAmount).div(new Decimal(sellAmount));
      return `1 ${sell} = $${perSell.toString()}`;
    }
    const perBuy = new Decimal(sellAmount).div(new Decimal(receiveAmount));
    return `1 ${buy} = $${perBuy.toString()}`;
  } catch {
    return `1 ${buy} = ?`;
  }
}

/**
 * GET /api/swap/quote — executable pricing, normalized to the Umbra domain.
 * With userPublicKey the Jupiter order includes an assembled tx (stored server-side);
 * without it we return quote-only pricing and the tx is built at POST /api/swap/transaction.
 */
export async function buildSwapQuote(params: {
  sell: string;
  buy: string;
  amount: string;
  userPublicKey?: string;
  slippageBps?: number;
}): Promise<UmbraQuote> {
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (params.sell.toUpperCase() === params.buy.toUpperCase()) {
    throw badRequest('VALIDATION_ERROR', 'Sell and buy assets must differ.');
  }
  // Stock↔base only (offline check — fails fast before any provider call), where
  // the base side is USDC, USDT or SOL.
  // PreStocks symbols come from the live directory (cached 5 min).
  const { getPrestocksSymbols } = await import('../prestocks/assets.js');
  const extraStocks = await getPrestocksSymbols().catch(() => new Set<string>());
  assertStockStablePair(params.sell, params.buy, extraStocks);
  // NB: Decimal('0').isPositive() is true (+0 sign) — gt(0) is the correct zero guard.
  // Garbage amounts must be a 400, never an unhandled Decimal throw (500).
  let amountOk = false;
  try {
    const d = new Decimal(params.amount);
    amountOk = d.isFinite() && d.gt(0);
  } catch {
    amountOk = false;
  }
  if (!amountOk) {
    throw badRequest('VALIDATION_ERROR', 'Amount must be greater than zero.');
  }
  const taker = params.userPublicKey;
  if (taker && !isValidSolanaAddress(taker)) {
    throw badRequest('INVALID_ADDRESS', 'userPublicKey is not a valid Solana address.');
  }

  const [sellSide, buySide] = await Promise.all([
    resolveSide(params.sell, extraStocks),
    resolveSide(params.buy, extraStocks),
  ]);
  const amountBaseUnits = await toBaseUnits(sellSide.symbol, params.amount);
  // Dust that floors to zero base units is unroutable: a 400, never a 502
  // from Jupiter on amount "0".
  if (!/^[1-9]\d*$/.test(amountBaseUnits)) {
    throw badRequest('VALIDATION_ERROR', 'Amount is too small to represent on-chain. Increase the amount.');
  }

  const order = await fetchOrder({
    inputMint: sellSide.mint,
    outputMint: buySide.mint,
    amountBaseUnits,
    taker,
    slippageBps,
  });

  if (!order.outAmount) throw upstream('SWAP_UNAVAILABLE', 'Jupiter returned no output amount.');
  try {
    if (!new Decimal(order.outAmount).gt(0)) {
      throw upstream(
        'INSUFFICIENT_LIQUIDITY',
        'No swap route for this pair and amount right now (thin liquidity). Try a smaller amount or the reverse direction.',
      );
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw upstream('SWAP_UNAVAILABLE', 'Jupiter returned no output amount.');
  }

  // Normalize with multiplier-aware conversion (xStocks) — never raw==display.
  const receiveDisplay = await fromBaseUnits(buySide.symbol, order.outAmount);

  // Slippage floor = Jupiter's own on-chain threshold when it is real
  // protection, else our ceil of (out × (1 − slippage)). Quote-only orders come
  // back with threshold == outAmount (nothing is enforced yet), which would
  // promise the full amount while the signed tx enforces less. Never floor it.
  const jupThreshold = order.otherAmountThreshold && /^\d+$/.test(order.otherAmountThreshold)
    ? new Decimal(order.otherAmountThreshold)
    : null;
  const outAmount = new Decimal(order.outAmount);
  const thresholdBaseUnits =
    jupThreshold && jupThreshold.lt(outAmount) && jupThreshold.gt(0)
      ? order.otherAmountThreshold as string
      : outAmount
          .mul(new Decimal(10_000 - slippageBps))
          .div(10_000)
          .ceil()
          .toFixed(0);
  const minimumReceived = await fromBaseUnits(buySide.symbol, thresholdBaseUnits);

  let usdValue: string | null = null;
  try {
    if (isStableSymbol(buySide.symbol)) {
      usdValue = receiveDisplay;
    } else {
      // SOL and stocks are quoted in dollars via their own reference price.
      const price = await getPrice(buySide.symbol).catch(() => null);
      if (price) {
        usdValue = new Decimal(receiveDisplay).mul(new Decimal(price.value)).toString();
      } else {
        // Pre-IPO shelf reference (display only; execution quote stays authoritative).
        const { getPrestocksPrice } = await import('../prestocks/assets.js');
        const pre = await getPrestocksPrice(buySide.symbol).catch(() => null);
        if (pre) usdValue = new Decimal(receiveDisplay).mul(new Decimal(pre.value)).toString();
      }
    }
  } catch {
    usdValue = null;
  }

  const priceImpactBps =
    typeof order.priceImpactPct === 'string' || typeof order.priceImpactPct === 'number'
      ? (() => {
          const v = Math.round(Number(order.priceImpactPct) * 100);
          return Number.isFinite(v) ? v : null;
        })()
      : null;

  const quoteId = newQuoteId('umbra_q');
  const expiresAtMs = Date.now() + QUOTE_TTL_S * 1000;
  // A taker was supplied, so the transaction can be finished now. Native SOL has
  // no mint: Jupiter routes through wrapped SOL, so paying in SOL needs a wrap in
  // the same transaction and receiving SOL needs the empty wSOL account closed
  // afterwards, otherwise the user gets a wrapped balance instead of native SOL.
  const nativeSolIn = sellSide.mint === SOL_MINT;
  const nativeSolOut = buySide.mint === SOL_MINT;
  let storedTransaction = order.transaction ?? null;
  if (storedTransaction && taker && (nativeSolIn || nativeSolOut)) {
    storedTransaction = await withNativeSol(
      storedTransaction,
      taker,
      BigInt(amountBaseUnits),
      nativeSolIn,
      nativeSolOut,
    );
  }
  quoteStore.putSwap({
    quoteId,
    sellSymbol: sellSide.symbol,
    buySymbol: buySide.symbol,
    sellAmountDisplay: params.amount,
    inputMint: sellSide.mint,
    outputMint: buySide.mint,
    amountBaseUnits,
    taker: taker ?? null,
    slippageBps,
    jupiterRequestId: order.requestId ?? null,
    transaction: storedTransaction,
    receiveAmountDisplay: receiveDisplay,
    signature: null,
    expiresAt: expiresAtMs,
  });

  const quote = normalizeQuote({
    quoteId,
    sellSide,
    buySide,
    amount: params.amount,
    receiveDisplay,
    usdValue,
    minimumReceived,
    expiresAt: new Date(expiresAtMs).toISOString(),
    networkFee: networkFeeFromOrder(order),
    platformFeeBps: order.platformFee?.feeBps ?? order.feeBps ?? null,
  });
  quote.priceImpactBps = priceImpactBps;
  return quote;
}

/**
 * POST /api/swap/transaction — return the wallet-signable unsigned transaction.
 * Reuses the stored tx when the taker matches, otherwise builds a fresh /order
 * with the caller's address (quote stays the pricing reference).
 */
export async function getSwapTransaction(quoteId: string, userPublicKey: string) {
  if (!isValidSolanaAddress(userPublicKey)) {
    throw badRequest('INVALID_ADDRESS', 'userPublicKey is not a valid Solana address.');
  }
  const stored = quoteStore.getSwap(quoteId);
  if (!stored) {
    throw badRequest('QUOTE_EXPIRED', 'Quote not found or expired. Request a fresh quote.', { quoteId });
  }
  if (stored.transaction && stored.taker === userPublicKey) {
    return {
      transaction: stored.transaction,
      requestId: stored.jupiterRequestId,
      expiresAt: new Date(stored.expiresAt).toISOString(),
    };
  }
  const order = await fetchOrder({
    inputMint: stored.inputMint,
    outputMint: stored.outputMint,
    amountBaseUnits: stored.amountBaseUnits,
    taker: userPublicKey,
    slippageBps: stored.slippageBps,
  });
  if (!order.transaction) {
    throw upstream('SWAP_UNAVAILABLE', order.errorMessage || 'Jupiter could not build this swap transaction.');
  }
  // Native SOL has no mint, so Jupiter routes through wrapped SOL. Paying in SOL
  // needs a wrap in the same transaction; receiving SOL needs the wSOL account
  // closed afterwards or the user gets a wrapped balance, not native SOL.
  const nativeSolIn = stored.inputMint === SOL_MINT;
  const nativeSolOut = stored.outputMint === SOL_MINT;
  let transaction = order.transaction;
  if (nativeSolIn || nativeSolOut) {
    transaction = await withNativeSol(
      order.transaction,
      userPublicKey,
      BigInt(stored.amountBaseUnits),
      nativeSolIn,
      nativeSolOut,
    );
  }
  quoteStore.updateSwap(quoteId, {
    taker: userPublicKey,
    transaction,
    jupiterRequestId: order.requestId ?? stored.jupiterRequestId,
  });
  return {
    transaction,
    requestId: order.requestId,
    expiresAt: new Date(stored.expiresAt).toISOString(),
  };
}

/**
 * Wrap native SOL in (pay side) and/or unwrap to native (receive side) around
 * Jupiter's own instructions. Closing the wSOL account is only safe when it held
 * nothing before this swap — otherwise we would sweep the user's own wSOL.
 */
export async function withNativeSol(
  jupiterTxB64: string,
  userPublicKey: string,
  amountBaseUnits: bigint,
  wrapIn: boolean,
  unwrapOut: boolean,
  connection?: Connection,
): Promise<string> {
  const owner = new PublicKey(userPublicKey);
  const wsolMint = new PublicKey(SOL_MINT);
  const wsolAta = getAssociatedTokenAddressSync(wsolMint, owner, true);
  const conn = connection ?? getConnection();
  const pre = await conn.getAccountInfo(wsolAta).catch(() => null);
  // Only a real token balance matters: an existing but empty wSOL account is safe
  // to close, and closing it is what turns the swap output back into native SOL.
  const wsolBalanceBefore = await conn
    .getTokenAccountBalance(wsolAta)
    .then((r) => BigInt(r.value.amount))
    .catch(() => 0n);
  // web3.js 1.x takes lamports as a number; SOL amounts stay far below 2^53.
  const lamports = Number(amountBaseUnits);
  if (!Number.isSafeInteger(lamports)) {
    throw badRequest('VALIDATION_ERROR', 'SOL amount is out of range.');
  }

  // Jupiter returns a versioned transaction whose message points at address
  // lookup tables, so the accounts have to be fetched and resolved before we can
  // read its instructions. Whatever shape it arrives in, we rebuild an unsigned
  // transaction with the wrap/unwrap instructions spliced in and always hand the
  // wallet the versioned shape.
  const raw = Buffer.from(jupiterTxB64, 'base64');
  let inner: TransactionInstruction[];
  let recentBlockhash: string;
  let versionedError: unknown;
  try {
    const vtx = VersionedTransaction.deserialize(new Uint8Array(raw));
    const tables = await Promise.all(
      vtx.message.addressTableLookups.map(async (lookup) => {
        const res = await getConnection().getAddressLookupTable(new PublicKey(lookup.accountKey));
        if (!res.value) {
          throw badRequest('SWAP_UNAVAILABLE', 'Jupiter returned an unusable transaction. Try again.');
        }
        return res.value;
      }),
    );
    // decompile is web3.js's own inverse of compile: it restores every account's
    // signer/writable flag for us instead of us re-deriving them.
    const decompiled = TransactionMessage.decompile(
      vtx.message,
      tables.length > 0 ? { addressLookupTableAccounts: tables } : undefined,
    );
    inner = decompiled.instructions;
    recentBlockhash = decompiled.recentBlockhash;
  } catch (e) {
    versionedError = e;
    try {
      const legacy = Transaction.from(raw);
      inner = legacy.instructions;
      recentBlockhash = legacy.recentBlockhash || (await conn.getLatestBlockhash('confirmed')).blockhash;
    } catch {
      throw versionedError;
    }
  }

  const lead: TransactionInstruction[] = [];
  if (wrapIn) {
    if (!pre) {
      const rentExempt = await conn.getMinimumBalanceForRentExemption(165);
      lead.push(
        SystemProgram.createAccount({
          fromPubkey: owner,
          newAccountPubkey: wsolAta,
          space: 165,
          lamports: lamports + rentExempt,
          programId: TOKEN_PROGRAM_ID,
        }),
      );
      lead.push(createInitializeAccountInstruction(wsolAta, wsolMint, owner));
    } else {
      lead.push(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: wsolAta,
          lamports,
        }),
      );
    }
    lead.push(createSyncNativeInstruction(wsolAta));
  }
  const tail: TransactionInstruction[] = [];
  if (unwrapOut && wsolBalanceBefore === 0n) {
    // Only close when the account was empty before: a pre-existing wSOL balance
    // belongs to the user and must not be swept by our close.
    tail.push(createCloseAccountInstruction(wsolAta, owner, owner));
  }
  // Recompile as a plain legacy transaction, which is the shape wallets already
  // parse. Jupiter keeps its own transactions under Solana's 1232-byte cap by
  // referencing address lookup tables; resolving those tables to splice our wrap
  // in puts every account back in the message, which can push it over the cap.
  // That is a real, explainable limit rather than a fault, so say so.
  const transaction = new Transaction({
    feePayer: owner,
    blockhash: recentBlockhash,
    lastValidBlockHeight: 0,
  }).add(...lead, ...inner, ...tail);
  try {
    return transaction.serialize({ requireAllSignatures: false }).toString('base64');
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (/too large/i.test(raw)) {
      throw upstream(
        'SWAP_UNAVAILABLE',
        'This route is too large to complete in one transaction with native SOL. Try USDC or USDT, or a larger amount.',
      );
    }
    throw upstream('SWAP_UNAVAILABLE', 'We could not assemble this swap transaction. Try again.');
  }
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Uint8Array): string {
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

function isZeroSig(bytes: Uint8Array | null | undefined): boolean {
  if (!bytes || bytes.length === 0) return true;
  return bytes.every((b) => b === 0);
}

/**
 * POST /api/swap/broadcast — submit the wallet-signed swap.
 * The wallet signs; the backend broadcasts over our RPC and records the
 * signature. Signed-but-unsent transactions can never confirm, so this step
 * is mandatory before the ledger records anything.
 */
export async function broadcastSignedSwap(
  quoteId: string,
  signedTransactionB64: string,
  userPublicKey: string,
): Promise<{ signature: string }> {
  if (!isValidSolanaAddress(userPublicKey)) {
    throw badRequest('INVALID_ADDRESS', 'userPublicKey is not a valid Solana address.');
  }
  if (!/^[A-Za-z0-9+/]{80,}={0,2}$/.test(signedTransactionB64)) {
    throw badRequest('VALIDATION_ERROR', 'signedTransaction must be base64.');
  }
  const stored = quoteStore.getSwap(quoteId);
  if (!stored) {
    throw badRequest('QUOTE_EXPIRED', 'Quote not found or expired. Request a fresh quote.', { quoteId });
  }
  if (stored.taker && stored.taker !== userPublicKey) {
    throw badRequest('VALIDATION_ERROR', 'This quote belongs to a different wallet.');
  }
  if (stored.signature) return { signature: stored.signature };

  let raw: Uint8Array;
  let vtx: VersionedTransaction;
  try {
    raw = new Uint8Array(Buffer.from(signedTransactionB64, 'base64'));
    vtx = VersionedTransaction.deserialize(raw);
  } catch {
    throw badRequest('VALIDATION_ERROR', 'signedTransaction could not be decoded.');
  }
  const first = vtx.signatures[0];
  if (!first || isZeroSig(first)) {
    throw badRequest('VALIDATION_ERROR', 'Transaction is not signed.');
  }
  // web3.js 1.x keeps signatures as raw bytes: the signer is the message's
  // first required static account (the fee payer Jupiter built the tx around).
  const required = vtx.message.header?.numRequiredSignatures ?? 0;
  const signer = required > 0 ? vtx.message.staticAccountKeys[0] : undefined;
  if (!signer || signer.toBase58() !== userPublicKey) {
    throw badRequest('VALIDATION_ERROR', 'Transaction signer does not match userPublicKey.');
  }
  const signature = base58(first);
  try {
    await getConnection().sendRawTransaction(raw, { maxRetries: 3 });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    // A wallet that broadcast itself (sign-and-send) races us here: the tx is
    // already known, which is success, not failure.
    if (!/already|processed|BlockhashNotFound/i.test(msg)) {
      throw upstream('SWAP_UNAVAILABLE', `Could not submit the swap: ${msg.slice(0, 140)}`);
    }
  }
  quoteStore.updateSwap(quoteId, { taker: userPublicKey, signature });
  return { signature };
}
