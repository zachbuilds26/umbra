import Decimal from 'decimal.js';
import { Transaction, VersionedTransaction } from '@solana/web3.js';
import { getJupiterOrder, type JupiterOrderResponse } from './client.js';
import { getConnection } from '../solana/connection.js';
import { getSolanaMint, getMultiplier, getPrice, canonicalSymbol, isStableSymbol } from '../xstocks/assets.service.js';
import { displayToBaseUnits, baseUnitsToDisplay } from '../solana/multiplier.js';
import { isValidSolanaAddress } from '../../utils/addresses.js';
import { newQuoteId } from '../../utils/ids.js';
import { quoteStore } from '../quotes.store.js';
import { badRequest, upstream, HttpError, type ErrorCode } from '../../utils/errors.js';
import type { UmbraQuote } from '../../domain/models.js';

Decimal.set({ precision: 40 });

const QUOTE_TTL_S = 60;
const DEFAULT_SLIPPAGE_BPS = 50;
/** Largest value an SPL token balance can hold: 2^64 − 1. */
const U64_MAX = 18446744073709551615n;

/** The "base" side of a swap: what you pay in or receive out. */
export function isBaseSymbol(symbol: string): boolean {
  return isStableSymbol(canonicalSymbol(symbol).toUpperCase());
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
 * Umbra swaps one stock against one base asset (USDC or USDT) on Solana.
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
    `Swaps are only supported between a tokenized stock and USDC or USDT. Got ${sell} → ${buy}.`,
  );
}

/**
 * User-entered decimal string -> on-chain atomic units, exactly.
 *
 * Decimal arithmetic only, never `Number`: 1.005 at 6dp is 1005000 in decimal,
 * but in binary floating point it is 1004999.9999999999, and flooring that sends
 * one atomic unit less than the user asked for.
 */
export function displayToAtomicUnits(displayAmount: string, decimals: number): string {
  return new Decimal(displayAmount).mul(new Decimal(10).pow(decimals)).floor().toFixed(0);
}

/** Display amount -> base units. Base assets 6dp (USDC/USDT);
 *  PreStocks plain 9dp; xStocks apply the live multiplier (plan §10). */
async function toBaseUnits(symbol: string, displayAmount: string): Promise<string> {
  if (isStableSymbol(symbol)) {
    return displayToAtomicUnits(displayAmount, 6);
  }
  const { getPrestocksSymbols, PRESTOCKS_DECIMALS } = await import('../prestocks/assets.js');
  const pre = await getPrestocksSymbols().catch(() => new Set<string>());
  if (pre.has(symbol.toUpperCase())) {
    return displayToAtomicUnits(displayAmount, PRESTOCKS_DECIMALS);
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

/**
 * Turn a Jupiter order failure into the reason a trader can actually act on.
 *
 * Jupiter answers HTTP 200 with `errorCode`/`errorMessage` for most failures and
 * uses HTTP 400 when it cannot build a route at all. The distinction that matters
 * most: "Insufficient funds" is the TAKER's wallet (missing input tokens, or not
 * enough SOL for the fee and the destination account rent), never pool liquidity.
 * Reporting that as thin liquidity sent users off to shrink an amount that was
 * never the problem.
 */
export function classifyJupiterFailure(input: {
  status: number;
  errorCode?: number;
  errorMessage?: string;
  hasTaker: boolean;
}): { code: ErrorCode; message: string; reason: string } {
  const raw = (input.errorMessage ?? '').trim();
  const text = raw.toLowerCase();
  const reason = raw || `upstream http ${input.status}`;

  if (/insufficient (funds|balance)|not enough (funds|sol|lamports)|exceeds balance|balance too low/.test(text)) {
    return {
      code: 'INSUFFICIENT_BALANCE',
      message:
        'Your wallet cannot cover this swap yet. It needs the token you are selling plus a little SOL for the network fee and to open the destination account.',
      reason,
    };
  }
  if (/no route|route not found|could not find any route|failed to find any route|no path|invalid route|unsupported pair|token not supported/.test(text)) {
    return {
      code: 'NO_ROUTE',
      message: 'No executable route is currently available for this pair.',
      reason,
    };
  }
  if (/insufficient liquidity|not enough liquidity|exceeds liquidity|slippage exceeded|price impact too high/.test(text)) {
    return {
      code: 'INSUFFICIENT_LIQUIDITY',
      message: 'The pool for this pair is too thin for this size right now. Try a smaller amount or the reverse direction.',
      reason,
    };
  }
  // HTTP 400 from /order means Jupiter declined the pair/amount outright. That is
  // a missing route unless Jupiter named a cause above — never call it "thin".
  if (input.status === 400 || input.errorCode) {
    return {
      code: 'NO_ROUTE',
      message: 'No executable route is currently available for this pair.',
      reason,
    };
  }
  return {
    code: 'SWAP_UNAVAILABLE',
    message: 'Our routing provider could not complete this request. Try again in a moment.',
    reason,
  };
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
  const hasTaker = Boolean(args.taker);
  if (!res.data) {
    if (res.status === 429) {
      throw new HttpError(429, 'RATE_LIMITED', 'Quote provider is rate limiting us — retry in a moment.');
    }
    const classified = classifyJupiterFailure({ status: res.status, hasTaker });
    throw upstream(classified.code, classified.message, { reason: classified.reason });
  }
  const order = res.data;
  // A quote-only order legitimately has no transaction. A taker order that comes
  // back without one is a failure: either Jupiter flagged it, or it silently
  // declined. Both must be classified, never passed on as a usable order.
  if (order.errorCode || (hasTaker && !order.transaction)) {
    const classified = classifyJupiterFailure({
      status: res.status,
      errorCode: order.errorCode,
      errorMessage: order.errorMessage,
      hasTaker,
    });
    throw upstream(classified.code, classified.message, { reason: classified.reason });
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
  routeVenue: string | null;
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
    // The venue is Jupiter's own word for it, or null when it named none.
    routeVenue: args.routeVenue,
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
  // An SPL token amount is a u64. A large display amount can scale past that
  // (9dp: 999,999,999,999 tokens is ~1e21 atomic units), which no transaction
  // could carry — reject it here rather than let the provider return nonsense.
  if (BigInt(amountBaseUnits) > U64_MAX) {
    throw badRequest('VALIDATION_ERROR', 'Amount is too large for Solana. Reduce the amount.');
  }

  const order = await fetchOrder({
    inputMint: sellSide.mint,
    outputMint: buySide.mint,
    amountBaseUnits,
    taker,
    slippageBps,
  });
  logSwapAttempt({
    stage: 'quote',
    inputMint: sellSide.mint,
    outputMint: buySide.mint,
    inputBaseUnits: amountBaseUnits,
    outBaseUnits: order.outAmount ?? null,
    routeVenue: typeof order.router === 'string' ? order.router : null,
    priceImpactPct: order.priceImpactPct ?? null,
    slippageBps,
    routeAvailable: Boolean(order.outAmount),
  });

  if (!order.outAmount) throw upstream('NO_ROUTE', 'No executable route is currently available for this pair.');
  try {
    if (!new Decimal(order.outAmount).gt(0)) {
      // Jupiter priced the route at zero output: there is no executable route for
      // this size. That is a missing route, not an invented "thin liquidity".
      throw upstream('NO_ROUTE', 'No executable route is currently available for this pair.');
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw upstream('NO_ROUTE', 'No executable route is currently available for this pair.');
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
          // Floor, never ceil: this value is the worst case the user is
          // guaranteed. Rounding up would promise one atomic unit more than the
          // transaction can actually deliver.
          .floor()
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

  // Jupiter reports price impact as a decimal ratio (0.015 = 1.5%), so a basis
  // point count is ratio × 10,000. Scaling by 100 understated a 1.5% move as
  // 1bp, which is the difference between "fine" and "you are being filled badly".
  const priceImpactBps = computePriceImpactBps(order);

  const quoteId = newQuoteId('umbra_q');
  const expiresAtMs = Date.now() + QUOTE_TTL_S * 1000;
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
    transaction: order.transaction ?? null,
    receiveAmountDisplay: receiveDisplay,
    outBaseUnits: order.outAmount ?? null,
    routeVenue: typeof order.router === 'string' && order.router ? order.router : null,
    priceImpactPct:
      order.priceImpactPct === undefined || order.priceImpactPct === null
        ? null
        : String(order.priceImpactPct),
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
    routeVenue: typeof order.router === 'string' && order.router ? order.router : null,
  });
  quote.priceImpactBps = priceImpactBps;
  return quote;
}

/**
 * Price impact in basis points, from whichever field Jupiter populated.
 *
 * `priceImpact` is percentage points (1.5 = 1.5%), so ×100 gives bps.
 * `priceImpactPct` is the deprecated decimal ratio (0.015 = 1.5%), so ×10,000
 * gives bps. Treating the ratio as percentage points understated every impact
 * by 100× — a 1.5% move was reported as 1 basis point.
 */
export function computePriceImpactBps(order: {
  priceImpact?: string | number | null;
  priceImpactPct?: string | number | null;
}): number | null {
  const { priceImpact, priceImpactPct } = order;
  const hasCurrent = priceImpact !== undefined && priceImpact !== null;
  const source = hasCurrent ? priceImpact : priceImpactPct;
  if (source === undefined || source === null) return null;
  try {
    const bps = hasCurrent
      ? new Decimal(String(source)).mul(100)
      : new Decimal(String(source)).mul(10_000);
    const v = Math.round(bps.toNumber());
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Everything needed to explain a swap after the fact, logged before the wallet is
 * asked to sign. Deliberately free of secrets: mints, atomic amounts and the
 * provider's own route/impact figures only.
 */
function logSwapAttempt(args: {
  stage: 'quote' | 'transaction';
  inputMint: string;
  outputMint: string;
  inputBaseUnits: string;
  outBaseUnits?: string | null;
  routeVenue?: string | null;
  priceImpactPct?: string | number | null;
  slippageBps: number;
  routeAvailable: boolean;
  rejectReason?: string | null;
  errorCode?: string | null;
}): void {
  console.log(
    '[swap]',
    JSON.stringify({
      stage: args.stage,
      inputMint: args.inputMint,
      outputMint: args.outputMint,
      inputBaseUnits: args.inputBaseUnits,
      outBaseUnits: args.outBaseUnits ?? null,
      routeVenue: args.routeVenue ?? null,
      priceImpactPct: args.priceImpactPct ?? null,
      slippageBps: args.slippageBps,
      routeAvailable: args.routeAvailable,
      rejectReason: args.rejectReason ?? null,
      errorCode: args.errorCode ?? null,
    }),
  );
}

/**
 * POST /api/swap/transaction — return the wallet-signable unsigned transaction.
 *
 * One route, one order: when the quote already carried a transaction for this
 * exact wallet it is returned untouched, so the numbers the user saw and the
 * transaction they sign come from the same Jupiter order. Otherwise the order is
 * built once here, stored, and reused for any later call on the same quote.
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
    logSwapAttempt({
      stage: 'transaction',
      inputMint: stored.inputMint,
      outputMint: stored.outputMint,
      inputBaseUnits: stored.amountBaseUnits,
      outBaseUnits: stored.outBaseUnits,
      routeVenue: stored.routeVenue,
      priceImpactPct: stored.priceImpactPct,
      slippageBps: stored.slippageBps,
      routeAvailable: true,
    });
    return {
      transaction: stored.transaction,
      requestId: stored.jupiterRequestId,
      expiresAt: new Date(stored.expiresAt).toISOString(),
    };
  }
  // Claim the quote for this wallet before any await. A quote already bound to
  // another wallet is never rebound: otherwise the numbers wallet A saw on
  // screen could end up in a transaction wallet B signs.
  const claim = quoteStore.claimSwapTaker(quoteId, userPublicKey);
  if (claim === 'taken') {
    throw badRequest('VALIDATION_ERROR', 'This quote belongs to a different wallet. Request a new quote.');
  }
  if (claim === 'missing') {
    throw badRequest('QUOTE_EXPIRED', 'Quote not found or expired. Request a fresh quote.', { quoteId });
  }
  const order = await fetchOrder({
    inputMint: stored.inputMint,
    outputMint: stored.outputMint,
    amountBaseUnits: stored.amountBaseUnits,
    taker: userPublicKey,
    slippageBps: stored.slippageBps,
  });
  if (!order.transaction) {
    logSwapAttempt({
      stage: 'transaction',
      inputMint: stored.inputMint,
      outputMint: stored.outputMint,
      inputBaseUnits: stored.amountBaseUnits,
      routeVenue: typeof order.router === 'string' ? order.router : null,
      priceImpactPct: order.priceImpactPct ?? null,
      slippageBps: stored.slippageBps,
      routeAvailable: false,
      rejectReason: order.errorMessage ?? 'no transaction returned',
    });
    throw upstream('NO_ROUTE', 'No executable route is currently available for this pair.');
  }
  logSwapAttempt({
    stage: 'transaction',
    inputMint: stored.inputMint,
    outputMint: stored.outputMint,
    inputBaseUnits: stored.amountBaseUnits,
    outBaseUnits: order.outAmount,
    routeVenue: typeof order.router === 'string' ? order.router : null,
    priceImpactPct: order.priceImpactPct ?? null,
    slippageBps: stored.slippageBps,
    routeAvailable: true,
  });
  const bound = quoteStore.bindSwapTransaction(quoteId, userPublicKey, {
    transaction: order.transaction,
    jupiterRequestId: order.requestId ?? stored.jupiterRequestId,
    outBaseUnits: order.outAmount ?? null,
    routeVenue: typeof order.router === 'string' && order.router ? order.router : null,
    priceImpactPct:
      order.priceImpactPct === undefined || order.priceImpactPct === null
        ? stored.priceImpactPct
        : String(order.priceImpactPct),
  });
  if (!bound) {
    // The quote expired while the provider was working. Returning the transaction
    // now would hand the wallet a trade whose quote no longer exists.
    throw badRequest('QUOTE_EXPIRED', 'Quote expired while the transaction was being built. Request a fresh quote.');
  }
  return {
    transaction: order.transaction,
    requestId: order.requestId,
    expiresAt: new Date(stored.expiresAt).toISOString(),
  };
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

/** One in-flight send per quote, so a double-tap cannot broadcast twice. */
const inFlightBroadcasts = new Map<string, Promise<{ signature: string }>>();

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
  const running = inFlightBroadcasts.get(quoteId);
  if (running) return running;
  const task = broadcastSignedSwapOnce(quoteId, signedTransactionB64, userPublicKey).finally(() => {
    inFlightBroadcasts.delete(quoteId);
  });
  inFlightBroadcasts.set(quoteId, task);
  return task;
}

async function broadcastSignedSwapOnce(
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
  if (!stored.transaction) {
    throw badRequest('VALIDATION_ERROR', 'This quote has no transaction to sign yet. Request the transaction first.');
  }

  let raw: Uint8Array;
  let vtx: VersionedTransaction;
  try {
    raw = new Uint8Array(Buffer.from(signedTransactionB64, 'base64'));
    vtx = VersionedTransaction.deserialize(raw);
  } catch {
    throw badRequest('VALIDATION_ERROR', 'signedTransaction could not be decoded.');
  }

  // The signed payload must be the quote's own transaction. Comparing the
  // message bytes (not the signatures) is what makes this safe: any different
  // amount, mint, route or destination produces a different message, so a
  // correctly-signed but unrelated transaction can never ride a live quote.
  const expected = messageBytesOf(Buffer.from(stored.transaction, 'base64'));
  const actual = messageBytesOf(Buffer.from(signedTransactionB64, 'base64'));
  if (!expected || !actual || !expected.equals(actual)) {
    throw badRequest('VALIDATION_ERROR', 'Signed transaction does not match the transaction for this quote.');
  }

  // Every required signature slot must be filled. Checking only the first slot
  // let a partially signed transaction through.
  const required = vtx.message.header?.numRequiredSignatures ?? 0;
  for (let i = 0; i < required; i++) {
    if (isZeroSig(vtx.signatures[i])) {
      throw badRequest('VALIDATION_ERROR', 'Transaction is not fully signed.');
    }
  }
  // web3.js 1.x keeps signatures as raw bytes: the signer is the message's
  // first required static account (the fee payer Jupiter built the tx around).
  const signer = required > 0 ? vtx.message.staticAccountKeys[0] : undefined;
  if (!signer || signer.toBase58() !== userPublicKey) {
    throw badRequest('VALIDATION_ERROR', 'Transaction signer does not match userPublicKey.');
  }
  const signature = base58(vtx.signatures[0] as Uint8Array);
  try {
    await getConnection().sendRawTransaction(raw, { maxRetries: 3 });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    // Only a genuinely duplicate submission counts as success. BlockhashNotFound
    // means the transaction was rejected (expired or unknown blockhash), and
    // reporting it as sent would leave a phantom signature in the ledger.
    if (!/already processed|alreadyprocessed|transaction already/i.test(msg)) {
      if (/blockhash/i.test(msg)) {
        throw badRequest('TRANSACTION_EXPIRED', 'This transaction expired before it was submitted. Request a fresh quote.');
      }
      throw upstream('SWAP_UNAVAILABLE', 'We could not submit this swap to Solana. Try again in a moment.');
    }
  }
  quoteStore.bindSwapSignature(quoteId, userPublicKey, signature);
  return { signature };
}

/**
 * Serialize a transaction's message, whichever wire format it arrived in.
 * Returns null when the bytes are not a Solana transaction we can compare.
 */
function messageBytesOf(txBytes: Buffer): Buffer | null {
  try {
    return Buffer.from(VersionedTransaction.deserialize(new Uint8Array(txBytes)).message.serialize());
  } catch {
    // not a versioned transaction
  }
  try {
    return Buffer.from(Transaction.from(txBytes).compileMessage().serialize());
  } catch {
    return null;
  }
}
