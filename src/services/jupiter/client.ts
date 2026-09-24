import { env } from '../../config/env.js';
import { fetchJsonWithRetry } from '../../utils/http.js';

// Current Jupiter Developer Platform — Swap API V2 (verified 2026-09-18):
//   GET  {base}/order?inputMint&outputMint&amount&taker[&slippageBps]  -> { transaction, requestId, outAmount, router, ... }
//   POST {base}/execute { signedTransaction, requestId }               -> managed landing
// Umbra never custodies keys: we call /order with the USER's taker address, return the
// UNSIGNED base64 transaction to the frontend, and never call /execute ourselves.
// Docs: https://developers.jup.ag/docs/swap/order-and-execute

export interface JupiterOrderResponse {
  transaction: string | null;
  requestId: string;
  outAmount: string;
  inAmount?: string;
  router?: string;
  mode?: string;
  feeBps?: number;
  feeMint?: string;
  platformFee?: { feeBps?: number; feeMint?: string; amount?: string };
  // Real per-transaction cost fields (populated when a taker is set and a tx is assembled)
  signatureFeeLamports?: number;
  prioritizationFeeLamports?: number;
  rentFeeLamports?: number;
  inUsdValue?: number;
  outUsdValue?: number;
  errorCode?: number;
  errorMessage?: string;
  priceImpactPct?: string | number;
  slippageBps?: number;
  /** Exact on-chain minimum output in base units — the real slippage floor. */
  otherAmountThreshold?: string;
  [key: string]: unknown;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (env.JUPITER_API_KEY) h['x-api-key'] = env.JUPITER_API_KEY;
  return h;
}

export async function getJupiterOrder(params: {
  inputMint: string;
  outputMint: string;
  amountBaseUnits: string;
  /** Omit for quote-only pricing (no assembled transaction). */
  taker?: string;
  slippageBps?: number;
}): Promise<{ status: number; data?: JupiterOrderResponse; raw: string }> {
  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amountBaseUnits,
  });
  if (params.taker) qs.set('taker', params.taker);
  if (params.slippageBps !== undefined) qs.set('slippageBps', String(params.slippageBps));
  const url = `${env.JUPITER_BASE_URL.replace(/\/$/, '')}/order?${qs}`;
  const res = await fetchJsonWithRetry<JupiterOrderResponse>(url, { headers: headers(), timeoutMs: 15_000 }, 1);
  return { status: res.status, data: res.ok ? res.data : undefined, raw: res.rawText };
}
