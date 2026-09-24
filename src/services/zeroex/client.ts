import Decimal from 'decimal.js';
import { env } from '../../config/env.js';
import { fetchJson } from '../../utils/http.js';
import { TtlCache } from '../../utils/cache.js';
import { SOLANA_USDC_MINT, SOLANA_USDC_DECIMALS } from '../xstocks/assets.service.js';

// 0x Swap API (Solana, open beta) — quoter #2 behind Jupiter. Same REST shape
// idea (quote endpoint, key header), no installs, no custody: we only read the
// quoted amounts, we never build or send transactions with it. Scope is
// deliberately price-fallback: it kills the blank `—` when Jupiter 429s or
// can't price a thin xStock. Execution stays on Jupiter (0x returns raw
// instructions + ALTs that need client-side assembly — a later milestone).
//
// Docs: https://docs.0x.org/svm/solana-swap-api/guides/get-started-with-solana-swap-api
// POST {ZEROEX_BASE_URL}/solana/swap-instructions {token_in, token_out,
// amount_in, taker, slippage_bps} with `0x-api-key` header. Empty key =
// leg disabled (null, never throws).

Decimal.set({ precision: 40 });

const PRICE_TTL_MS = 60 * 1000;
const priceCache = new TtlCache<string>(PRICE_TTL_MS);

// Free tier is 5 RPS — light pacing so fallback fan-outs don't 429 themselves.
// Serialized through a promise tail: concurrent callers computing the same wait
// would otherwise all fire at the same instant.
let lastCallAt = 0;
let paceTail: Promise<void> = Promise.resolve();
function pace(): Promise<void> {
  const run = paceTail.then(async () => {
    const wait = 300 - (Date.now() - lastCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  paceTail = run.catch(() => undefined);
  return run;
}

/** Dummy taker for quote-only reads (quoting never checks funds). */
const QUOTE_TAKER = '11111111111111111111111111111111';

interface ZeroExInstructionsResponse {
  amountOut?: string | number;
  amount_out?: string | number;
  minAmountOut?: string | number;
  min_amount_out?: string | number;
  [key: string]: unknown;
}

export interface ZeroExQuote {
  amountOutBaseUnits: string;
  minAmountOutBaseUnits: string | null;
}

/** Defensive parse — beta field names may vary; accept snake_case + camelCase. */
export function parseZeroExQuote(data: unknown): ZeroExQuote | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as ZeroExInstructionsResponse;
  const out = d.amountOut ?? d.amount_out;
  if (out === undefined || out === null || out === '') return null;
  const min = d.minAmountOut ?? d.min_amount_out ?? null;
  return {
    amountOutBaseUnits: String(out),
    minAmountOutBaseUnits: min === null || min === undefined || min === '' ? null : String(min),
  };
}

export async function getZeroExQuote(params: {
  tokenIn: string;
  tokenOut: string;
  amountInBaseUnits: string;
  slippageBps?: number;
}): Promise<ZeroExQuote | null> {
  if (!env.ZEROEX_API_KEY) return null;
  await pace();
  const url = `${env.ZEROEX_BASE_URL.replace(/\/$/, '')}/solana/swap-instructions`;
  let res;
  try {
    // POSTs are never retried (http util rule) — one shot, fallback chain moves on.
    res = await fetchJson<ZeroExInstructionsResponse>(url, {
      method: 'POST',
      headers: { '0x-api-key': env.ZEROEX_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token_in: params.tokenIn,
        token_out: params.tokenOut,
        // 0x is strict: amount_in must be a JSON number (u64), not a string.
        amount_in: Number(params.amountInBaseUnits),
        taker: QUOTE_TAKER,
        slippage_bps: params.slippageBps ?? 50,
      }),
      timeoutMs: 8000,
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  return parseZeroExQuote(res.data);
}

/**
 * USD price for a mint via a 1-whole-token → USDC probe quote.
 * Returns the price string or null (disabled leg, unpriced, error — all null).
 */
export async function getZeroExUsdPrice(mint: string, decimals: number): Promise<string | null> {
  if (!env.ZEROEX_API_KEY) return null;
  const cacheKey = `0x:${mint}`;
  const cached = priceCache.get(cacheKey);
  if (cached) return cached;
  const oneToken = new Decimal(10).pow(decimals).toFixed(0);
  const quote = await getZeroExQuote({ tokenIn: mint, tokenOut: SOLANA_USDC_MINT, amountInBaseUnits: oneToken }).catch(
    () => null,
  );
  if (!quote) return null;
  const usdc = new Decimal(quote.amountOutBaseUnits).div(new Decimal(10).pow(SOLANA_USDC_DECIMALS));
  if (!usdc.isFinite() || usdc.lte(0)) return null;
  const price = usdc.toString();
  priceCache.set(cacheKey, price);
  return price;
}
