import Decimal from '../../utils/decimal.js';
import { TtlCache } from '../../utils/cache.js';
import { fetchPrestocks, type PrestocksRaw } from './client.js';
import type { UmbraAsset } from '../../domain/models.js';


// PreStocks directory: 5 min TTL. Solana-native, so no bridge leg —
// bridgeSupported is always false and no cross-chain config is consulted.
const LIST_TTL_MS = 5 * 60 * 1000;
const listCache = new TtlCache<PrestocksRaw[]>(LIST_TTL_MS);
let lastGood: PrestocksRaw[] | null = null;
let inflight: Promise<PrestocksRaw[]> | null = null;

export const PRESTOCKS_DECIMALS = 9;

export async function listPrestocks(): Promise<PrestocksRaw[]> {
  const cached = listCache.get('all');
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const list = await fetchPrestocks();
      if (list.length > 0) {
        listCache.set('all', list);
        lastGood = list;
        return list;
      }
      if (lastGood) return lastGood;
      return [] as PrestocksRaw[];
    } catch {
      if (lastGood) return lastGood;
      return [] as PrestocksRaw[];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Upper-case symbol set for pair classification (pure helper takes the set). */
export async function getPrestocksSymbols(): Promise<Set<string>> {
  const list = await listPrestocks();
  return new Set(list.map((p) => p.symbol.toUpperCase()));
}

export async function getPrestocksAsset(symbol: string): Promise<UmbraAsset | null> {
  const upper = symbol.toUpperCase();
  const list = await listPrestocks();
  const found = list.find((p) => p.symbol.toUpperCase() === upper);
  if (!found) return null;
  const price = found.tokenPrice ?? found.markPrice;
  const hasPrice = price !== undefined && price !== null && Number.isFinite(Number(price));
  const mcapRaw = found.markValuation ?? found.impliedValuation ?? null;
  const hasMcap = mcapRaw !== null && mcapRaw !== undefined && Number.isFinite(Number(mcapRaw));
  return {
    symbol: found.symbol.toUpperCase(),
    name: found.name,
    network: 'Solana',
    address: found.contract_address,
    decimals: PRESTOCKS_DECIMALS,
    ...(found.image ? { logo: found.image } : {}),
    tokenStandard: 'SPL_TOKEN_2022',
    ...(hasPrice ? { price: { value: String(price), currency: 'USD' as const, timestamp: new Date().toISOString() } } : {}),
    ...(hasMcap ? { marketCap: String(mcapRaw) } : { marketCap: null }),
    bridgeSupported: false,
    swapSupported: true,
  };
}

/** Reference price for display (tokenPrice preferred, markPrice fallback). */
const lastGoodPre = new Map<string, { value: string; timestamp: string }>();

export async function getPrestocksPrice(symbol: string): Promise<{ value: string; timestamp: string } | null> {
  const upper = symbol.toUpperCase();
  const list = await listPrestocks();
  const found = list.find((p) => p.symbol.toUpperCase() === upper);
  const price = found?.tokenPrice ?? found?.markPrice;
  if (price === undefined || price === null || !Number.isFinite(Number(price))) return lastGoodPre.get(upper) ?? null;
  const entry = { value: String(price), timestamp: new Date().toISOString() };
  lastGoodPre.set(upper, entry);
  return entry;
}

