import { env } from '../../config/env.js';
import { fetchJson } from '../../utils/http.js';

// 0x Swap API (Solana, open beta) — quoter #2 behind Jupiter. Same REST shape
// idea (quote endpoint, key header), no installs, no custody: we only read the
// quoted amounts, we never build or send transactions with it. Execution stays
// on Jupiter (0x returns raw instructions + ALTs that need client-side
// assembly — a later milestone). Currently used by the provider health probe.
//
// Docs: https://docs.0x.org/svm/solana-swap-api/guides/getting-started
// POST {ZEROEX_BASE_URL}/solana/swap-instructions {token_in, token_out,
// amount_in, taker, slippage_bps} with `0x-api-key` header. Empty key =
// leg disabled (null, never throws).

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
  // The API insists on a JSON number, which caps us at 2^53-1. Converting a
  // larger u64 with Number() would silently round the trade size, so refuse
  // instead of quoting an amount the user never asked for.
  if (!/^\d+$/.test(params.amountInBaseUnits)) return null;
  const amountIn = Number(params.amountInBaseUnits);
  if (!Number.isSafeInteger(amountIn) || amountIn <= 0) return null;
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
        amount_in: amountIn,
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
