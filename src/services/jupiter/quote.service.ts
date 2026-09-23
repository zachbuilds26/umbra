import Decimal from 'decimal.js';
import { getJupiterOrder, type JupiterOrderResponse } from './client.js';
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

interface ResolvedSide {
  symbol: string;
  mint: string;
  decimals: number;
  isXstock: boolean;
}

/** Resolve a domain symbol to its verified Solana mint. Rejects arbitrary mints (plan §11). */
async function resolveSide(symbol: string, extraStocks: Set<string> = new Set()): Promise<ResolvedSide> {
  // xStocks symbols are case-sensitive upstream (NVDAx, not NVDAX) — canonicalize, never blindly upper-case.
  // Exception: PreStocks symbols are ALL-CAPS (SPACEX); the set disambiguates the ...X collision.
  let canonical = canonicalSymbol(symbol);
  if (extraStocks.has(canonical.toUpperCase())) canonical = canonical.toUpperCase();
  if (canonical === 'SOL') {
    throw badRequest('UNSUPPORTED_ASSET', 'SOL is not part of the Umbra swap MVP. Use stables (USDC/USDT) and stocks (xStocks / Pre-IPO).');
  }
  if (!isStableSymbol(canonical) && !/^[A-Z0-9]+x$/.test(canonical) && !/^[A-Z]{2,12}$/.test(canonical)) {
    throw badRequest('UNSUPPORTED_ASSET', `Asset ${symbol} is not supported for swap.`);
  }
  // getSolanaMint is authoritative: unknown symbols resolve to null here even if
  // they pass the shape gate above (plan §11 — no arbitrary mints).
  const found = await getSolanaMint(canonical);
  if (!found) throw badRequest('UNSUPPORTED_ASSET', `Asset ${symbol} has no verified Solana mint.`);
  return { symbol: canonical, mint: found.mint, decimals: found.decimals, isXstock: !isStableSymbol(canonical) };
}

/**
 * Umbra swaps are stock↔stable only, on Solana only: one side must be a supported
 * stable (USDC/USDT), the other a supported stock (xStock or PreStocks pre-IPO).
 * No stock→stock, no stable→stable. Pure (no network) so bad pairs fail fast and
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
  const sStable = isStableSymbol(s);
  const bStable = isStableSymbol(b);
  if (sStable && isStock(b)) return { stock: normStock(b), stable: s };
  if (bStable && isStock(s)) return { stock: normStock(s), stable: b };
  throw badRequest(
    'UNSUPPORTED_ASSET',
    `Swaps are only supported between a tokenized stock and a stable (USDC/USDT). Got ${sell} → ${buy}.`,
  );
}

/** Display amount -> base units. Stables use 6dp; PreStocks plain 9dp; xStocks apply the live multiplier (plan §10). */
async function toBaseUnits(symbol: string, displayAmount: string): Promise<string> {
  if (isStableSymbol(symbol)) {
    return new Decimal(displayAmount).mul(new Decimal(10).pow(6)).floor().toFixed(0);
  }
  const { getPrestocksSymbols, PRESTOCKS_DECIMALS } = await import('../prestocks/assets.js');
  const pre = await getPrestocksSymbols().catch(() => new Set<string>());
  if (pre.has(symbol.toUpperCase())) {
    return new Decimal(displayAmount).mul(new Decimal(10).pow(PRESTOCKS_DECIMALS)).floor().toFixed(0);
  }
  const multiplier = await getMultiplier(symbol, 'Solana');
  if (!multiplier) {
    throw upstream('QUOTE_UNAVAILABLE', `No live multiplier for ${symbol}; refusing to quote without it.`);
  }
  return displayToBaseUnits(displayAmount, multiplier, 8);
}

/** Base units -> display amount (applies multiplier for xStocks; plain for stables/PreStocks). */
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
    throw upstream('QUOTE_UNAVAILABLE', `No live multiplier for ${symbol}; cannot normalize quote.`);
  }
  return baseUnitsToDisplay(baseUnits, multiplier, 8);
}

async function fetchOrder(args: {
  inputMint: string;
  outputMint: string;
  amountBaseUnits: string;
  taker?: string;
}): Promise<JupiterOrderResponse> {
  let res;
  try {
    res = await getJupiterOrder(args);
  } catch (err) {
    throw upstream('SWAP_UNAVAILABLE', `Swap quote unavailable: ${(err as Error).message}`);
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
  slippageBps: number;
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
    minimumReceived: new Decimal(receiveDisplay)
      .mul(new Decimal(10_000 - args.slippageBps))
      .div(10_000)
      .toString(),
    // Provider-neutral route derived from the actual quote (plan §1.3). Never invented venues.
    route: [{ symbol: sellSide.symbol }, { symbol: buySide.symbol }],
    expiresAt: args.expiresAt,
    transaction: null,
  };
}

function buildRate(sell: string, buy: string, sellAmount: string, receiveAmount: string): string {
  try {
    if (isStableSymbol(buy)) {
      // Stables ≈ USD: price per unit sold.
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
  if (['SOL'].includes(params.sell.toUpperCase()) || ['SOL'].includes(params.buy.toUpperCase())) {
    throw badRequest('UNSUPPORTED_ASSET', 'SOL is not part of the Umbra swap MVP. Use stables (USDC/USDT) and stocks (xStocks / Pre-IPO).');
  }
  // Stock↔stable only (offline check — fails fast before any provider call).
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

  const order = await fetchOrder({ inputMint: sellSide.mint, outputMint: buySide.mint, amountBaseUnits, taker });

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

  let usdValue: string | null = null;
  try {
    if (isStableSymbol(buySide.symbol)) {
      usdValue = receiveDisplay;
    } else {
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
    outAmountBaseUnits: order.outAmount,
    receiveAmountDisplay: receiveDisplay,
    expiresAt: expiresAtMs,
  });

  const quote = normalizeQuote({
    quoteId,
    sellSide,
    buySide,
    amount: params.amount,
    receiveDisplay,
    usdValue,
    slippageBps,
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
  });
  if (!order.transaction) {
    throw upstream('SWAP_UNAVAILABLE', order.errorMessage || 'Jupiter could not build this swap transaction.');
  }
  quoteStore.updateSwap(quoteId, {
    taker: userPublicKey,
    transaction: order.transaction,
    jupiterRequestId: order.requestId ?? stored.jupiterRequestId,
  });
  return {
    transaction: order.transaction,
    requestId: order.requestId,
    expiresAt: new Date(stored.expiresAt).toISOString(),
  };
}
