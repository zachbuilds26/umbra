import { TtlCache } from '../utils/cache.js';

// Executable swap quotes are time-sensitive (plan §28). Short TTL, never cached long.
const QUOTE_TTL_MS = 60 * 1000;
const BRIDGE_QUOTE_TTL_MS = 5 * 60 * 1000;

export interface StoredSwapQuote {
  quoteId: string;
  sellSymbol: string;
  buySymbol: string;
  sellAmountDisplay: string;
  inputMint: string;
  outputMint: string;
  amountBaseUnits: string;
  taker: string | null;
  slippageBps: number;
  jupiterRequestId: string | null;
  transaction: string | null;
  receiveAmountDisplay: string;
  /** Jupiter's quoted output in atomic units, as returned on the order. */
  outBaseUnits: string | null;
  /** The venue Jupiter routed through on that order ("metis", "dflow", ...). */
  routeVenue: string | null;
  priceImpactPct: string | null;
  signature: string | null;
  expiresAt: number;
}

export interface StoredBridgeQuote {
  bridgeQuoteId: string;
  sourceNetwork: string;
  asset: string;
  amount: string;
  destinationAddress: string;
  sourceTokenAddress: string;
  sourceDecimals: number;
  solanaMint: string;
  bridgeAddress: string;
  expiresAt: number;
}

const swapQuotes = new TtlCache<StoredSwapQuote>(QUOTE_TTL_MS);
const bridgeQuotes = new TtlCache<StoredBridgeQuote>(BRIDGE_QUOTE_TTL_MS);

export const quoteStore = {
  putSwap(q: StoredSwapQuote): void {
    const ttl = q.expiresAt - Date.now();
    if (ttl <= 0) return;
    swapQuotes.set(q.quoteId, q, ttl);
  },
  getSwap(quoteId: string): StoredSwapQuote | undefined {
    return swapQuotes.get(quoteId);
  },
  updateSwap(quoteId: string, patch: Partial<StoredSwapQuote>): StoredSwapQuote | undefined {
    const existing = swapQuotes.get(quoteId);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch, quoteId };
    const ttl = updated.expiresAt - Date.now();
    if (ttl <= 0) {
      swapQuotes.delete(quoteId);
      return undefined;
    }
    swapQuotes.set(quoteId, updated, ttl);
    return updated;
  },
  /**
   * Bind a quote to a wallet, or report that someone else already owns it.
   *
   * Synchronous on purpose: no `await` can interleave between the read and the
   * write, so two callers racing for the same unbound quote cannot both win.
   * Without this, wallet A's quote could be silently taken over by wallet B and
   * B would sign a transaction for A's displayed terms.
   */
  claimSwapTaker(quoteId: string, taker: string): 'claimed' | 'owned' | 'taken' | 'missing' {
    const existing = swapQuotes.get(quoteId);
    if (!existing) return 'missing';
    if (existing.taker === taker) return 'owned';
    if (existing.taker !== null) return 'taken';
    const ttl = existing.expiresAt - Date.now();
    if (ttl <= 0) {
      swapQuotes.delete(quoteId);
      return 'missing';
    }
    swapQuotes.set(quoteId, { ...existing, taker }, ttl);
    return 'claimed';
  },
  /**
   * Write the built transaction, but only while `taker` still owns the quote.
   * Returns the stored quote, or undefined when the quote expired or was taken.
   */
  bindSwapTransaction(
    quoteId: string,
    taker: string,
    patch: Partial<StoredSwapQuote>,
  ): StoredSwapQuote | undefined {
    const existing = swapQuotes.get(quoteId);
    if (!existing) return undefined;
    if (existing.taker !== taker) return undefined;
    const updated = { ...existing, ...patch, quoteId, taker };
    const ttl = updated.expiresAt - Date.now();
    if (ttl <= 0) {
      swapQuotes.delete(quoteId);
      return undefined;
    }
    swapQuotes.set(quoteId, updated, ttl);
    return updated;
  },
  /** Record the submitted signature only if this quote has none yet. */
  bindSwapSignature(quoteId: string, taker: string, signature: string): boolean {
    const existing = swapQuotes.get(quoteId);
    if (!existing || existing.taker !== taker) return false;
    if (existing.signature) return existing.signature === signature;
    const ttl = existing.expiresAt - Date.now();
    if (ttl <= 0) {
      swapQuotes.delete(quoteId);
      return false;
    }
    swapQuotes.set(quoteId, { ...existing, signature }, ttl);
    return true;
  },
  putBridge(q: StoredBridgeQuote): void {
    const ttl = q.expiresAt - Date.now();
    if (ttl <= 0) return;
    bridgeQuotes.set(q.bridgeQuoteId, q, ttl);
  },
  getBridge(quoteId: string): StoredBridgeQuote | undefined {
    return bridgeQuotes.get(quoteId);
  },
};
