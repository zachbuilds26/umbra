import { env } from '../../config/env.js';
import { fetchJsonWithRetry } from '../../utils/http.js';
import { HttpError } from '../../utils/errors.js';

// Pyth Pro (Lazer) REST client.
// - Symbology: GET {symbology}/v1/symbols?entitled_only=true -> full feed catalog for this key.
// - Prices: POST {pro}/v1/latest_price { priceFeedIds, properties, formats, channel }.
// Docs: https://docs.pyth.network/price-feeds/pro/rest
// The key stays server-side (plan §30: never expose provider secrets to the frontend).

export interface ProSymbol {
  pyth_lazer_id: number;
  symbol: string;
  asset_type: string;
  instrument_type: string;
  exponent: number;
  state: string;
  min_channel: string;
}

export interface ProFeedUpdate {
  priceFeedId: number;
  price?: string;
  exponent?: number;
  confidence?: number | string;
  marketSession?: string;
  feedUpdateTimestamp?: number;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (env.PYTH_API_KEY) h.Authorization = `Bearer ${env.PYTH_API_KEY}`;
  return h;
}

function requireKey(): void {
  if (!env.PYTH_API_KEY) {
    throw new HttpError(
      503,
      'PROVIDER_ERROR',
      'Pyth prices need a PYTH_API_KEY (Pro key from https://docs.pyth.network/price-feeds/pro). Set it in .env and restart.',
    );
  }
}

/** Full entitled catalog for this key (demo keys cover a limited set). */
export async function getSymbols(): Promise<ProSymbol[]> {
  requireKey();
  const url = `${env.PYTH_SYMBOLOGY_URL.replace(/\/$/, '')}/v1/symbols?entitled_only=true`;
  const res = await fetchJsonWithRetry<ProSymbol[]>(url, { headers: authHeaders(), timeoutMs: 15_000 }, 1);
  if (!res.data) {
    throw new HttpError(502, 'PROVIDER_ERROR', `Pyth symbology unavailable (upstream ${res.status}).`);
  }
  return res.data;
}

/** Latest price for numeric Pro feed IDs. fixed_rate@1000ms is valid for every feed. */
export async function getLatestPrices(feedIds: number[]): Promise<ProFeedUpdate[]> {
  requireKey();
  const url = `${env.PYTH_PRO_URL.replace(/\/$/, '')}/v1/latest_price`;
  const res = await fetchJsonWithRetry<{ parsed?: { priceFeeds?: ProFeedUpdate[] } }>(
    url,
    {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        priceFeedIds: feedIds,
        properties: ['price', 'feedUpdateTimestamp'],
        formats: ['leUnsigned'],
        channel: 'fixed_rate@1000ms',
      }),
      timeoutMs: 15_000,
    },
    1,
  );
  if (!res.data) {
    throw new HttpError(502, 'PROVIDER_ERROR', `Pyth prices unavailable (upstream ${res.status}).`);
  }
  return res.data.parsed?.priceFeeds ?? [];
}
