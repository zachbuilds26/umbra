import { env } from '../../config/env.js';
import { fetchJsonWithRetry } from '../../utils/http.js';
import { TtlCache } from '../../utils/cache.js';

// Jupiter Price API V3: last-swapped USD price + measured 24h change per mint,
// up to 50 mints per call. Tokens Jupiter can't price reliably are OMITTED
// (no key at all) — never null-filled. Docs: https://developers.jup.ag/docs/price
// Used as the honest fallback when xStocks is unreachable, and as the real 24h
// change source so the tape never needs invented history.

export interface JupiterPrice {
  usdPrice: number;
  decimals: number;
  priceChange24h: number;
  blockId: number;
  stockData?: { price?: number; mcap?: number; updatedAt?: string };
  scaledUiConfig?: { multiplier?: number };
}

const PRICE_TTL_MS = 60 * 1000;
const priceCache = new TtlCache<Map<string, JupiterPrice>>(PRICE_TTL_MS);
const CACHE_KEY = 'v3';

function headers(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (env.JUPITER_API_KEY) h['x-api-key'] = env.JUPITER_API_KEY;
  return h;
}

// Free tier is ~1 RPS: pace keyed calls so cold-boot fan-outs don't 429 themselves.
// Serialized through a promise tail — a plain "lastCallAt" check lets every
// concurrent caller compute the same wait and then fire together.
let lastCallAt = 0;
let paceTail: Promise<void> = Promise.resolve();
function pace(): Promise<void> {
  const run = paceTail.then(async () => {
    const wait = 1100 - (Date.now() - lastCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  paceTail = run.catch(() => undefined);
  return run;
}

const inflights = new Map<string, Promise<Map<string, JupiterPrice>>>();

/** Refresh the cached price map for exactly these mints (batched, single-flight per mint set). */
export async function refreshJupiterPrices(mints: string[]): Promise<Map<string, JupiterPrice>> {
  const unique = [...new Set(mints)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const cached = priceCache.get(CACHE_KEY);
  // Only serve from cache when EVERY requested mint is actually present.
  // Returning a partial subset made a caller silently price one asset and see
  // nothing for the rest.
  if (cached && unique.every((m) => cached.has(m))) {
    const subset = new Map<string, JupiterPrice>();
    for (const m of unique) {
      const v = cached.get(m);
      if (v) subset.set(m, v);
    }
    return subset;
  }
  // Keyed by the requested set: a shared global promise handed an NVDAx caller
  // whatever AAPLx request happened to be in flight.
  const key = [...unique].sort().join(',');
  const existing = inflights.get(key);
  if (existing) return existing;
  const promise = (async () => {
    try {
      // Collect only what THIS request actually fetched...
      const fetched = new Map<string, JupiterPrice>();
      for (let i = 0; i < unique.length; i += 50) {
        const batch = unique.slice(i, i + 50);
        await pace();
        const url = `${env.JUPITER_PRICE_URL.replace(/\/$/, '')}?ids=${batch.join(',')}`;
        const res = await fetchJsonWithRetry<Record<string, JupiterPrice>>(url, { headers: headers(), timeoutMs: 10_000 }, 0);
        if (res.data) {
          for (const [mint, v] of Object.entries(res.data)) {
            if (v && typeof v.usdPrice === 'number') fetched.set(mint, v);
          }
        }
      }
      // ...and merge it into the cache as it stands NOW, not into a snapshot
      // taken before the awaits. Two concurrent batches each wrote back the whole
      // map they started with, so whichever finished last silently discarded the
      // other's newly fetched prices.
      const live = new Map<string, JupiterPrice>(priceCache.get(CACHE_KEY) ?? []);
      for (const [mint, v] of fetched) live.set(mint, v);
      priceCache.set(CACHE_KEY, live);
      return new Map([...live].filter(([mint]) => unique.includes(mint)));
    } finally {
      inflights.delete(key);
    }
  })();
  inflights.set(key, promise);
  return promise;
}

/** Single-mint convenience (goes through the same cache). */
export async function getJupiterPrice(mint: string): Promise<JupiterPrice | null> {
  const map = await refreshJupiterPrices([mint]).catch(() => new Map());
  return map.get(mint) ?? null;
}

interface JupiterTokenEntry {
  id: string;
  symbol: string;
  decimals: number;
}

const mintCache = new TtlCache<{ mint: string; decimals: number }>(60 * 60 * 1000);

/** Resolve a symbol to its Solana mint via Jupiter's token directory (fallback
 * when xStocks/bridge config is unreachable — same verified mints, other road). */
export async function getJupiterMint(symbol: string): Promise<{ mint: string; decimals: number } | null> {
  const key = symbol.toUpperCase();
  const cached = mintCache.get(key);
  if (cached) return cached;
  const url = `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(symbol)}`;
  await pace();
  const res = await fetchJsonWithRetry<JupiterTokenEntry[]>(url, { headers: headers(), timeoutMs: 10_000 }, 0).catch(
    () => null,
  );
  // A 200 can still carry an error object; .find on it would throw a 500.
  const entries = Array.isArray(res?.data) ? res.data : [];
  const hit = entries.find((t) => typeof t?.symbol === 'string' && t.symbol.toUpperCase() === key);
  if (!hit?.id) return null;
  const out = { mint: hit.id, decimals: hit.decimals ?? 8 };
  mintCache.set(key, out);
  return out;
}
