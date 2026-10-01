import { BSC_CHAIN_ID, binanceGet, isBinanceEnabled } from './client.js';
import { TtlCache } from '../../utils/cache.js';
import { HttpError } from '../../utils/errors.js';

// RWA Data API: Ondo + bStocks token universe on BSC (xStocks is NOT covered
// here — it trades through the Trading API's AMM routes instead).
// Docs: .../dev-docs/catalog/web3-wallet/api/rest-api/rwa-data

export type RwaPlatformId = 'ondo' | 'bstock';

export interface BscToken {
  address: string;
  symbol: string;
  name: string;
  platform: RwaPlatformId;
  decimals: number;
  underlyingTicker: string;
  underlyingName: string;
  logoUrl: string | null;
  priceUsd: string | null;
  referencePriceUsd: string | null;
  marketOpen: boolean | null;
  marketStatus: string | null;
  volume24H: string | null;
  marketCap: string | null;
}

export interface BscPrice {
  address: string;
  platform: string | null;
  priceUsd: string | null;
  referencePriceUsd: string | null;
  updatedAt: number | null;
}

const tokensCache = new TtlCache<BscToken[]>(60_000, 32);
const searchCache = new TtlCache<BscToken[]>(60_000, 200);
const pricesCache = new TtlCache<BscPrice[]>(30_000, 200);
const platformsCache = new TtlCache<{ platformId: string; tickerCount: number }[]>(600_000, 4);

function ensureEnabled(): void {
  if (!isBinanceEnabled()) {
    throw new HttpError(503, 'FEATURE_UNAVAILABLE', 'BSC leg is not configured.');
  }
}

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | null {
  return typeof v === 'object' && v !== null ? (v as Rec) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.length > 0 && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** The reference nests objects/arrays without stable field names — locate by shape, not by key. */
function findNestedWithKey(obj: Rec, key: string): Rec | null {
  for (const value of Object.values(obj)) {
    const rec = asRec(value);
    if (rec && key in rec) return rec;
  }
  return null;
}

function findNestedArray(obj: Rec): Rec[] | null {
  for (const value of Object.values(obj)) {
    if (Array.isArray(value) && value.length > 0 && asRec(value[0])) {
      return value as Rec[];
    }
  }
  return null;
}

function parseMarket(raw: unknown): { marketOpen: boolean | null; marketStatus: string | null } {
  const rec = asRec(raw);
  // Market info may sit on the token itself or in a nested object.
  const holder = rec && 'marketStatus' in rec ? rec : rec ? findNestedWithKey(rec, 'marketStatus') : null;
  if (!holder) return { marketOpen: null, marketStatus: null };
  return {
    marketOpen: typeof holder['openState'] === 'boolean' ? (holder['openState'] as boolean) : null,
    marketStatus: str(holder['marketStatus']),
  };
}

function parseToken(raw: unknown): BscToken | null {
  const rec = asRec(raw);
  if (!rec) return null;
  const address = str(rec['tokenContractAddress']);
  const symbol = str(rec['tokenSymbol']);
  if (!address || !symbol) return null;
  const platform = str(rec['platformId']);
  const market = parseMarket(raw);
  return {
    address,
    symbol,
    name: str(rec['tokenName']) ?? symbol,
    platform: platform === 'bstock' ? 'bstock' : 'ondo',
    decimals: num(rec['decimals']) ?? 18,
    underlyingTicker: str(rec['underlyingTicker']) ?? symbol,
    underlyingName: str(rec['underlyingName']) ?? '',
    logoUrl: str(rec['tokenLogoUrl']),
    priceUsd: str(rec['tokenPrice']),
    referencePriceUsd: str(rec['referencePrice']),
    marketOpen: market.marketOpen,
    marketStatus: market.marketStatus,
    volume24H: str(rec['volume24H']),
    marketCap: str(rec['marketCap']),
  };
}

export async function getBscPlatforms(): Promise<{ platformId: string; tickerCount: number }[]> {
  ensureEnabled();
  const cached = platformsCache.get('all');
  if (cached) return cached;
  const data = await binanceGet<unknown[]>('/api/v1/dex/market/rwa/platforms', {});
  const out = (Array.isArray(data) ? data : [])
    .map((p) => {
      const rec = asRec(p);
      const platformId = rec ? str(rec['platformId']) : null;
      if (!platformId) return null;
      return { platformId, tickerCount: (rec ? num(rec['tickerCount']) : null) ?? 0 };
    })
    .filter((p): p is { platformId: string; tickerCount: number } => p !== null);
  platformsCache.set('all', out);
  return out;
}

export async function getBscTokens(args: { platformId?: RwaPlatformId; tabId?: number } = {}): Promise<BscToken[]> {
  ensureEnabled();
  const key = `tokens:56:${args.platformId ?? 'all'}:${args.tabId ?? 'all'}`;
  const cached = tokensCache.get(key);
  if (cached) return cached;
  const data = await binanceGet<unknown[]>('/api/v1/dex/market/rwa/tokens', {
    binanceChainId: BSC_CHAIN_ID,
    ...(args.platformId ? { platformId: args.platformId } : {}),
    ...(args.tabId !== undefined ? { tabId: String(args.tabId) } : {}),
  });
  const out = (Array.isArray(data) ? data : [])
    .map(parseToken)
    .filter((t): t is BscToken => t !== null);
  tokensCache.set(key, out);
  return out;
}

export async function searchBscTokens(keyword: string): Promise<BscToken[]> {
  ensureEnabled();
  const key = `search:${keyword.trim().toLowerCase()}`;
  const cached = searchCache.get(key);
  if (cached) return cached;
  const data = await binanceGet<unknown[]>('/api/v1/dex/market/rwa/search', { keyword: keyword.trim() });
  const out: BscToken[] = [];
  for (const hit of Array.isArray(data) ? data : []) {
    const rec = asRec(hit);
    if (!rec) continue;
    const assets = findNestedArray(rec);
    if (!assets) continue;
    for (const asset of assets) {
      // Search assets carry the contract + platform + chain; enrich the rest
      // from the hit's own ticker/company fields.
      const address = str(asset['tokenContractAddress']);
      const chain = str(asset['binanceChainId']);
      if (!address || chain !== BSC_CHAIN_ID) continue;
      const platform = str(asset['platformId']);
      out.push({
        address,
        symbol: str(asset['tokenSymbol']) ?? str(rec['ticker']) ?? '',
        name: str(rec['companyName']) ?? '',
        platform: platform === 'bstock' ? 'bstock' : 'ondo',
        decimals: num(asset['decimals']) ?? 18,
        underlyingTicker: str(rec['ticker']) ?? '',
        underlyingName: str(rec['companyName']) ?? '',
        logoUrl: null,
        priceUsd: null,
        referencePriceUsd: null,
        marketOpen: null,
        marketStatus: null,
        volume24H: null,
        marketCap: null,
      });
    }
  }
  searchCache.set(key, out);
  return out;
}

export async function getBscPrices(addresses: string[]): Promise<BscPrice[]> {
  ensureEnabled();
  const clean = [...new Set(addresses.map((a) => a.trim()).filter(Boolean))].slice(0, 100);
  if (clean.length === 0) return [];
  const key = `prices:${clean.slice().sort().join(',')}`;
  const cached = pricesCache.get(key);
  if (cached) return cached;
  const data = await binanceGet<unknown[]>('/api/v1/dex/market/rwa/price', {
    binanceChainId: BSC_CHAIN_ID,
    tokenContractAddresses: clean.join(','),
  });
  const out = (Array.isArray(data) ? data : [])
    .map((p) => {
      const rec = asRec(p);
      const address = rec ? str(rec['tokenContractAddress']) : null;
      if (!address) return null;
      return {
        address,
        platform: rec ? str(rec['platformId']) : null,
        priceUsd: rec ? str(rec['tokenPrice']) : null,
        referencePriceUsd: rec ? str(rec['referencePrice']) : null,
        updatedAt: rec ? num(rec['tokenPriceUpdatedAt']) : null,
      } satisfies BscPrice;
    })
    .filter((p): p is BscPrice => p !== null);
  pricesCache.set(key, out);
  return out;
}
