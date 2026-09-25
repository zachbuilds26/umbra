import { env } from '../../config/env.js';
import { fetchJsonWithRetry } from '../../utils/http.js';
import { TtlCache } from '../../utils/cache.js';

export interface TokensSnapshot {
  mint: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  priceUsd: number | null;
  change24hPct: number | null;
  change1hPct: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
  hasMarket: boolean;
}

export function tokensEnabled(): boolean {
  return env.TOKENS_API_KEY.length > 0 && !env.isTest;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function round2(v: number | null): number | null {
  if (v === null) return null;
  return Math.round(v * 100) / 100;
}

export function toSnapshot(mint: string, row: unknown): TokensSnapshot | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as { address?: unknown; hasMarket?: unknown; token?: unknown };
  const t = (r.token ?? null) as {
    symbol?: unknown;
    name?: unknown;
    decimals?: unknown;
    price?: unknown;
    priceChange24hPercent?: unknown;
    priceChange1hPercent?: unknown;
    liquidity?: unknown;
    volume24hUSD?: unknown;
    marketCap?: unknown;
  } | null;
  const hasMarket = r.hasMarket === true && t !== null;
  const price = t ? num(t.price) : null;
  return {
    mint,
    symbol: t && typeof t.symbol === 'string' ? t.symbol : null,
    name: t && typeof t.name === 'string' ? t.name : null,
    decimals: t && Number.isInteger(t.decimals) ? (t.decimals as number) : null,
    priceUsd: price !== null && price > 0 ? price : null,
    change24hPct: t ? round2(num(t.priceChange24hPercent)) : null,
    change1hPct: t ? round2(num(t.priceChange1hPercent)) : null,
    liquidityUsd: t ? num(t.liquidity) : null,
    volume24hUsd: t ? num(t.volume24hUSD) : null,
    marketCapUsd: t ? num(t.marketCap) : null,
    hasMarket,
  };
}

const SNAPSHOT_TTL_MS = 60 * 1000;
const snapCache = new TtlCache<Map<string, TokensSnapshot>>(SNAPSHOT_TTL_MS);
const CACHE_KEY = 'snaps';
let inflight: Promise<Map<string, TokensSnapshot>> | null = null;

function headers(): Record<string, string> {
  return { Accept: 'application/json', 'x-api-key': env.TOKENS_API_KEY };
}

export async function getTokensSnapshots(mints: string[]): Promise<Map<string, TokensSnapshot>> {
  const unique = [...new Set(mints)].filter(Boolean).slice(0, 250);
  const empty = new Map<string, TokensSnapshot>();
  if (unique.length === 0 || !tokensEnabled()) return empty;
  const cached = snapCache.get(CACHE_KEY);
  if (cached && unique.every((m) => cached.has(m))) {
    const subset = new Map<string, TokensSnapshot>();
    for (const m of unique) {
      const v = cached.get(m);
      if (v) subset.set(m, v);
    }
    return subset;
  }
  if (inflight) {
    const shared = await inflight.catch(() => new Map<string, TokensSnapshot>());
    return new Map([...shared].filter(([m]) => unique.includes(m)));
  }
  inflight = (async () => {
    try {
      const url = `${env.TOKENS_BASE_URL.replace(/\/$/, '')}/assets/market-snapshots`;
      const res = await fetchJsonWithRetry<unknown[]>(
        url,
        {
          method: 'POST',
          headers: { ...headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ mints: unique }),
          timeoutMs: 12_000,
        },
        0,
      );
      const rows = Array.isArray(res.data) ? res.data : [];
      const fetched = new Map<string, TokensSnapshot>();
      for (const row of rows) {
        const addr = (row as { address?: unknown })?.address;
        if (typeof addr !== 'string' || !unique.includes(addr)) continue;
        const snap = toSnapshot(addr, row);
        if (snap) fetched.set(addr, snap);
      }
      const live = new Map<string, TokensSnapshot>(snapCache.get(CACHE_KEY) ?? []);
      for (const [m, v] of fetched) live.set(m, v);
      snapCache.set(CACHE_KEY, live);
      return new Map([...live].filter(([m]) => unique.includes(m)));
    } catch {
      const stale = snapCache.get(CACHE_KEY);
      if (stale) return new Map([...stale].filter(([m]) => unique.includes(m)));
      return new Map<string, TokensSnapshot>();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
