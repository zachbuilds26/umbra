import Decimal from '../../utils/decimal.js';
import { BSC_CHAIN_ID, binanceGet, binancePost, isBinanceEnabled } from './client.js';
import { getBscTokens } from './rwa.service.js';
import { TtlCache } from '../../utils/cache.js';
import { HttpError, badRequest } from '../../utils/errors.js';

// Trading API on BSC (chain 56): aggregated quotes + unsigned swap builds.
// Phase 1 covers SWAP-mode routes (xStocks via AMM pools, stables) — the same
// shape as the Solana leg: quote -> build unsigned tx -> wallet signs+sends.
// RFQ routes (Ondo, bStocks PcsXRfq) need EIP-712 order submit (phase 2).
// Docs: .../dev-docs/products/trading-api/integration-flow

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Stables on BSC (Binance's own reference addresses). 18 decimals each.
export const BSC_STABLES: Record<string, { address: string; decimals: number }> = {
  USDC: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
  USDT: { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
};

export interface BscKnownToken {
  symbol: string;
  address: string;
  decimals: number;
  kind: 'stable' | 'bstock' | 'xstock';
}

export interface BscQuoteRoute {
  quoteId: string;
  vendorName: string;
  executionMode: 'SWAP' | 'RFQ';
  sellAmountBaseUnits: string;
  buyAmountBaseUnits: string;
  buyDecimals: number;
  priceImpactPercent: string | null;
  approveTarget: string | null;
}

export interface BscUnsignedTx {
  from: string;
  to: string;
  data: string;
  value: string;
  gas: string;
  gasPrice: string;
  maxPriorityFeePerGas: string | null;
  minReceiveAmount: string;
  slippagePercent: string;
}

interface MarketSearchHit {
  tokenSymbol?: unknown;
  tokenContractAddress?: unknown;
  decimals?: unknown;
  tagList?: unknown;
  liquidity?: unknown;
  marketCap?: unknown;
}

const tokenCache = new TtlCache<BscKnownToken>(300_000, 200);

function ensureEnabled(): void {
  if (!isBinanceEnabled()) {
    throw new HttpError(503, 'FEATURE_UNAVAILABLE', 'BSC leg is not configured.');
  }
}

/** Display units ("500.5") -> base units ("500500000000000000000"). Floors, never rounds. */
export function toBaseUnits(display: string, decimals: number): string {
  let parsed: InstanceType<typeof Decimal>;
  try {
    parsed = new Decimal(display);
  } catch {
    throw badRequest('VALIDATION_ERROR', 'Invalid amount.');
  }
  if (!parsed.isFinite() || parsed.lte(0)) throw badRequest('VALIDATION_ERROR', 'Invalid amount.');
  return parsed.mul(new Decimal(10).pow(decimals)).floor().toFixed(0);
}

/** Base units -> display units (for quote responses). */
export function fromBaseUnits(baseUnits: string, decimals: number): string {
  const parsed = new Decimal(baseUnits);
  if (!parsed.isFinite()) return '0';
  return parsed.div(new Decimal(10).pow(decimals)).toFixed();
}

/** Resolve a UI symbol to a BSC contract. Stables are fixed; bStocks resolve
 *  through the RWA list (exact symbol); anything else falls back to the
 *  Market search, preferring the recognized (non-clone) token. */
export async function resolveBscToken(symbol: string): Promise<BscKnownToken> {
  ensureEnabled();
  const upper = symbol.trim().toUpperCase();
  const stable = BSC_STABLES[upper];
  if (stable) return { symbol: upper, address: stable.address, decimals: stable.decimals, kind: 'stable' };
  const cached = tokenCache.get(upper);
  if (cached) return cached;
  // bStocks first: exact symbols (TSLAB, NVDAB), SWAP-mode liquidity.
  try {
    const bstocks = await getBscTokens({ platformId: 'bstock' });
    const match = bstocks.find((b) => b.symbol.toUpperCase() === upper);
    if (match) {
      const known: BscKnownToken = { symbol: match.symbol.toUpperCase(), address: match.address, decimals: 18, kind: 'bstock' };
      tokenCache.set(upper, known);
      return known;
    }
  } catch {
    // RWA list down — fall through to Market search, never fail the resolve.
  }
  const hits = await binanceGet<MarketSearchHit[]>('/api/v1/dex/market/token/search', {
    chains: BSC_CHAIN_ID,
    search: symbol.trim(),
  });
  const list = Array.isArray(hits) ? hits : [];
  let best: MarketSearchHit | null = null;
  let bestScore = -1;
  for (const hit of list) {
    if (typeof hit !== 'object' || hit === null) continue;
    const hitSymbol = typeof hit.tokenSymbol === 'string' ? hit.tokenSymbol.toUpperCase() : '';
    if (hitSymbol !== upper) continue;
    const address = typeof hit.tokenContractAddress === 'string' ? hit.tokenContractAddress : '';
    if (!ETH_ADDRESS_RE.test(address)) continue;
    const tagList = (hit.tagList ?? null) as { isRecognized?: boolean } | null;
    const recognized = tagList?.isRecognized === true;
    const liquidity = Number(hit.liquidity ?? 0);
    const marketCap = Number(hit.marketCap ?? 0);
    const score = (recognized ? 1e15 : 0) + (Number.isFinite(liquidity) ? liquidity : 0) + (Number.isFinite(marketCap) ? marketCap / 1e6 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = hit;
    }
  }
  if (!best) throw badRequest('UNSUPPORTED_ASSET', 'Token not found on BSC.');
  const decimalsRaw = Number(best.decimals ?? 18);
  const known: BscKnownToken = {
    symbol: upper,
    address: best.tokenContractAddress as string,
    decimals: Number.isInteger(decimalsRaw) && decimalsRaw >= 0 && decimalsRaw <= 36 ? decimalsRaw : 18,
    kind: 'xstock',
  };
  tokenCache.set(upper, known);
  return known;
}

export async function getBscQuote(args: {
  sell: BscKnownToken;
  buy: BscKnownToken;
  amountBaseUnits: string;
  wallet?: string;
}): Promise<BscQuoteRoute> {
  ensureEnabled();
  if (!/^\d+$/.test(args.amountBaseUnits) || args.amountBaseUnits === '0') {
    throw badRequest('VALIDATION_ERROR', 'Invalid amount.');
  }
  const data = await binanceGet<Array<Record<string, unknown>>>('/api/v1/dex/aggregator/quote', {
    binanceChainId: BSC_CHAIN_ID,
    amount: args.amountBaseUnits,
    fromTokenAddress: args.sell.address,
    toTokenAddress: args.buy.address,
    ...(args.wallet ? { userWalletAddress: args.wallet } : {}),
  });
  const routes = Array.isArray(data) ? data : [];
  // Prefer the flagged best SWAP route; RFQ routes belong to phase 2.
  const swapRoutes = routes.filter((r) => r['executionMode'] === 'SWAP');
  const pool = swapRoutes.length > 0 ? swapRoutes : routes;
  const picked =
    pool.find((r) => r['isBest'] === true) ??
    pool.slice().sort((a, b) => String(b['toTokenAmount'] ?? '').length - String(a['toTokenAmount'] ?? '').length)[0];
  if (!picked || typeof picked['quoteId'] !== 'string' || typeof picked['toTokenAmount'] !== 'string') {
    throw badRequest('NO_ROUTE', 'No route for this pair right now.');
  }
  const toToken = picked['toToken'] as { decimal?: unknown } | undefined;
  return {
    quoteId: picked['quoteId'] as string,
    vendorName: typeof picked['vendorName'] === 'string' ? (picked['vendorName'] as string) : 'unknown',
    executionMode: picked['executionMode'] === 'RFQ' ? 'RFQ' : 'SWAP',
    sellAmountBaseUnits: args.amountBaseUnits,
    buyAmountBaseUnits: picked['toTokenAmount'] as string,
    buyDecimals: Number(toToken?.decimal ?? args.buy.decimals) || args.buy.decimals,
    priceImpactPercent: typeof picked['priceImpactPercent'] === 'string' ? (picked['priceImpactPercent'] as string) : null,
    approveTarget: typeof picked['approveTarget'] === 'string' ? (picked['approveTarget'] as string) : null,
  };
}

export async function buildBscSwap(args: {
  quote: BscQuoteRoute;
  sell: BscKnownToken;
  buy: BscKnownToken;
  wallet: string;
  slippagePercent: string;
}): Promise<BscUnsignedTx> {
  ensureEnabled();
  if (!ETH_ADDRESS_RE.test(args.wallet)) throw badRequest('VALIDATION_ERROR', 'Invalid wallet address.');
  if (args.quote.executionMode !== 'SWAP') {
    throw badRequest('SWAP_UNAVAILABLE', 'RFQ route — coming soon.');
  }
  const data = await binanceGet<Record<string, unknown>>('/api/v1/dex/aggregator/swap', {
    binanceChainId: BSC_CHAIN_ID,
    amount: args.quote.sellAmountBaseUnits,
    fromTokenAddress: args.sell.address,
    toTokenAddress: args.buy.address,
    userWalletAddress: args.wallet,
    quoteId: args.quote.quoteId,
    slippagePercent: args.slippagePercent,
  });
  const tx = (data?.['tx'] ?? null) as Record<string, unknown> | null;
  if (!tx || typeof tx['to'] !== 'string' || typeof tx['data'] !== 'string') {
    throw badRequest('SWAP_UNAVAILABLE', 'No quote response — try again.');
  }
  return {
    from: typeof tx['from'] === 'string' ? (tx['from'] as string) : args.wallet,
    to: tx['to'] as string,
    data: tx['data'] as string,
    value: typeof tx['value'] === 'string' ? (tx['value'] as string) : '0',
    gas: typeof tx['gas'] === 'string' ? (tx['gas'] as string) : '0',
    gasPrice: typeof tx['gasPrice'] === 'string' ? (tx['gasPrice'] as string) : '0',
    maxPriorityFeePerGas: typeof tx['maxPriorityFeePerGas'] === 'string' ? (tx['maxPriorityFeePerGas'] as string) : null,
    minReceiveAmount: typeof tx['minReceiveAmount'] === 'string' ? (tx['minReceiveAmount'] as string) : '0',
    slippagePercent: typeof tx['slippagePercent'] === 'string' ? (tx['slippagePercent'] as string) : args.slippagePercent,
  };
}

export async function getBscApprove(args: {
  token: BscKnownToken;
  amountBaseUnits: string;
}): Promise<{ spender: string; calldata: string; gasLimit: string; gasPrice: string }> {
  ensureEnabled();
  const data = await binanceGet<Array<Record<string, unknown>>>('/api/v1/dex/aggregator/approve-transaction', {
    binanceChainId: BSC_CHAIN_ID,
    tokenContractAddress: args.token.address,
    approveAmount: args.amountBaseUnits,
  });
  const first = Array.isArray(data) ? data[0] : undefined;
  if (!first || typeof first['data'] !== 'string' || typeof first['dexContractAddress'] !== 'string') {
    throw badRequest('SWAP_UNAVAILABLE', 'No quote response — try again.');
  }
  return {
    spender: first['dexContractAddress'] as string,
    calldata: first['data'] as string,
    gasLimit: typeof first['gasLimit'] === 'string' ? (first['gasLimit'] as string) : '0',
    gasPrice: typeof first['gasPrice'] === 'string' ? (first['gasPrice'] as string) : '0',
  };
}

/** Tolerant parse of the simulate envelope (field names vary by chain). */
export function parseSimResult(raw: unknown): { ok: boolean; failReason: string | null } {
  const rec = (typeof raw === 'object' && raw !== null ? raw : null) as Record<string, unknown> | null;
  const status = rec && typeof rec['status'] === 'string' ? (rec['status'] as string).toUpperCase() : '';
  if (status === 'SUCCESS') return { ok: true, failReason: null };
  if (status === 'FAILED') {
    const reason = rec && typeof rec['failReason'] === 'string' ? (rec['failReason'] as string) : '';
    return { ok: false, failReason: reason || null };
  }
  return { ok: false, failReason: null };
}

/**
 * Off-chain dry-run of an exact EVM tx (the same bytes the wallet would send).
 * Read-only: nothing is signed or broadcast. A FAILED prediction means the
 * swap would revert — the frontend must not send it.
 */
export async function simulateBscTx(tx: { from: string; to: string; data: string; value: string }): Promise<{ ok: boolean; failReason: string | null }> {
  ensureEnabled();
  if (!ETH_ADDRESS_RE.test(tx.from) || !ETH_ADDRESS_RE.test(tx.to)) {
    throw badRequest('VALIDATION_ERROR', 'Invalid wallet address.');
  }
  if (!/^0x[0-9a-fA-F]*$/.test(tx.data) || !/^\d+$/.test(tx.value)) {
    throw badRequest('VALIDATION_ERROR', 'Invalid request.');
  }
  const data = await binancePost<unknown>(
    '/api/v1/dex/pre-transaction/simulate',
    {},
    { binanceChainId: BSC_CHAIN_ID, evmTx: { from: tx.from, to: tx.to, value: tx.value, data: tx.data } },
  );
  return parseSimResult(data);
}

export async function getBscTxStatus(txHash: string): Promise<{ status: 'pending' | 'success' | 'fail' | 'unknown' }> {  ensureEnabled();
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw badRequest('VALIDATION_ERROR', 'Invalid transaction hash.');
  const data = await binanceGet<Array<Record<string, unknown>>>(
    '/api/v1/dex/post-transaction/transaction-detail-by-txhash',
    { binanceChainId: BSC_CHAIN_ID, txHash },
  );
  const first = Array.isArray(data) ? data[0] : undefined;
  const status = first?.['txStatus'];
  if (status === 'success' || status === 'fail' || status === 'pending') return { status };
  return { status: 'unknown' };
}
