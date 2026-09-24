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
  putBridge(q: StoredBridgeQuote): void {
    const ttl = q.expiresAt - Date.now();
    if (ttl <= 0) return;
    bridgeQuotes.set(q.bridgeQuoteId, q, ttl);
  },
  getBridge(quoteId: string): StoredBridgeQuote | undefined {
    return bridgeQuotes.get(quoteId);
  },
};
