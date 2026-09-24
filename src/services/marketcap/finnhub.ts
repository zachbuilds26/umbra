import { env } from '../../config/env.js';
import Decimal from 'decimal.js';
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

// Free tier is 60/min: pace keyed calls (serialized — see price.service.ts).
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

const inflight = new Map<string, Promise<string | null>>();

/** Underlying equity market cap in USD (integer string), or null. */
export async function getFinnhubMarketCap(underlying: string): Promise<string | null> {
  const key = underlying.trim().toUpperCase();
  if (!key || !env.FINNHUB_API_KEY) return null;
  const cached = mcapCache.get(key);
  if (cached) return cached;
  // One in-flight call per ticker: 56 shelf rows must not become 56 duplicates.
  const running = inflight.get(key);
  if (running) return running;
  const request = (async () => {
    await pace();
    const url = `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(key)}&token=${encodeURIComponent(env.FINNHUB_API_KEY)}`;
    const res = await fetchJsonWithRetry<FinnhubProfile>(url, { timeoutMs: 8000 }, 0).catch(() => null);
    const m = res?.data?.marketCapitalization;
    if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0) return null;
    // Decimal, not float: ×1e6 on a large value can drift or reach Infinity.
    const out = new Decimal(m).mul(1_000_000).toFixed(0);
    mcapCache.set(key, out);
    return out;
  })().finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}
