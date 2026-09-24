import { env } from '../../config/env.js';
import { fetchJsonWithRetry } from '../../utils/http.js';
import { TtlCache } from '../../utils/cache.js';

// Finnhub company profile → underlying equity market cap, for xStocks list
// display. Finnhub answers in ~200ms for any ticker (vs Jupiter per-mint
// lookups gated at 1 RPS + xStocks stalls), so the whole shelf fills fast.
// marketCapitalization is MILLIONS of USD → ×1e6. ETFs (SPY/QQQ/GLD) return
// {} here — callers keep the Jupiter fallback for those. Cached 1h: company
// value moves slowly, and free tier is 60 calls/min.
// NEVER a price source: Finnhub quotes the equity, not our token (which
// carries multiplier + premium/discount). Price stays Jupiter/xStocks.

interface FinnhubProfile {
  ticker?: string;
  marketCapitalization?: number;
}

const MCAP_TTL_MS = 60 * 60 * 1000;
const mcapCache = new TtlCache<string>(MCAP_TTL_MS);

// Free tier is 60/min: pace keyed calls.
let lastCallAt = 0;
async function pace(): Promise<void> {
  const wait = 1100 - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/** Underlying equity market cap in USD (integer string), or null. */
export async function getFinnhubMarketCap(underlying: string): Promise<string | null> {
  const key = underlying.trim().toUpperCase();
  if (!key || !env.FINNHUB_API_KEY) return null;
  const cached = mcapCache.get(key);
  if (cached) return cached;
  await pace();
  const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(key)}&token=${encodeURIComponent(env.FINNHUB_API_KEY)}`;
  const res = await fetchJsonWithRetry<FinnhubProfile>(url, { timeoutMs: 8000 }, 0).catch(() => null);
  const m = res?.data?.marketCapitalization;
  if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0) return null;
  const out = String(Math.round(m * 1_000_000));
  mcapCache.set(key, out);
  return out;
}
