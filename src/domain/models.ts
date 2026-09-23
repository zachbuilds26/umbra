// Normalized domain objects. The frontend only ever sees these — never raw
// provider shapes (plan: "Product principle").
export interface UmbraAsset {
  symbol: string;
  name: string;
  underlyingSymbol?: string;
  network: string;
  address: string;
  decimals?: number;
  /** Issuer-provided logo URL (xStocks metadata, PreStocks site, token-list for stables). */
  logo?: string;
  tokenStandard?: 'SPL_TOKEN_2022' | 'ERC20' | 'JETTON' | string;
  multiplier?: string;
  price?: {
    value: string;
    currency: 'USD';
    timestamp: string;
  };
  /** Formatted valuation for pre-IPO (markValuation / impliedValuation) — xStocks leave null. */
  marketCap?: string | null;
  liquidity?: string | null;
  bridgeSupported: boolean;
  swapSupported: boolean;
}

export interface UmbraQuote {
  quoteId: string;
  sell: { symbol: string; amount: string; mint: string };
  receive: { symbol: string; amount: string; usdValue: string | null; mint: string };
  rate: string;
  priceImpactBps: number | null;
  // Sum of Jupiter's signature + prioritization + rent lamports. estimated=true
  // means quote-only (no taker yet) so Jupiter couldn't price it — conservative
  // 0.00001 SOL placeholder, never presented as measured.
  networkFee: { currency: 'SOL'; amount: string; estimated: boolean } | null;
  // Jupiter's own routing cut in bps (e.g. 10 on xStock pairs), baked into the price.
  platformFeeBps: number | null;
  minimumReceived: string;
  route: Array<{ symbol: string }>;
  expiresAt: string;
  transaction: string | null;
}

export interface UmbraBridgeRoute {
  sourceNetwork: string;
  destinationNetwork: 'Solana';
  bridgeAddress: string;
  supportedAssets: string[];
}

export interface UmbraBridgeQuote {
  bridgeQuoteId: string;
  sourceNetwork: string;
  destinationNetwork: 'Solana';
  asset: string;
  amount: string;
  estimatedReceived: string | null;
  fee: string | null;
  estimatedTime: string | null;
  route: Array<{ network?: string; symbol?: string }>;
  expiresAt: string;
}

export type SwapTxStatus = 'pending' | 'submitted' | 'confirmed' | 'failed' | 'expired';
export type BridgeTxStatus =
  | 'source_pending'
  | 'source_confirmed'
  | 'ccip_in_flight'
  | 'destination_pending'
  | 'completed'
  | 'failed';

export interface UmbraTransaction {
  id: string;
  type: 'swap' | 'bridge';
  status: SwapTxStatus | BridgeTxStatus;
  sourceNetwork?: string;
  destinationNetwork?: string;
  sourceAsset?: string;
  destinationAsset?: string;
  sourceAmount?: string;
  destinationAmount?: string | null;
  sourceWallet?: string;
  destinationWallet?: string;
  providerReference?: string | null;
  sourceTxHash?: string | null;
  destinationTxHash?: string | null;
  ccipMessageId?: string | null;
  signature?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
}
