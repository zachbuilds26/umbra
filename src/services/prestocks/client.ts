import { fetchJsonWithRetry } from '../../utils/http.js';

// PreStocks public API (no auth): tokenized pre-IPO stocks, Solana-native.
// Verified live: 8 products with `Pre…` mints, Token-2022, 9 decimals, plain
// amounts (no rebase/multiplier concept — markPrice/tokenPrice are reference
// prices, not multipliers).
const PRESTOCKS_URL = 'https://prestocks.com/api/prestocks';

export interface PrestocksRaw {
  name: string;
  symbol: string;
  description?: string;
  image?: string;
  external_url?: string;
  contract_address: string;
  markPrice?: number;
  markValuation?: number;
  tokenPrice?: number;
  impliedValuation?: number;
  supply?: number;
}

export async function fetchPrestocks(): Promise<PrestocksRaw[]> {
  const res = await fetchJsonWithRetry<PrestocksRaw[]>(PRESTOCKS_URL, { timeoutMs: 15_000 }, 1);
  if (!res.data || !Array.isArray(res.data)) return [];
  return res.data.filter((p) => p?.symbol && p?.contract_address);
}
