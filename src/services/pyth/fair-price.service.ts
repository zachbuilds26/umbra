import Decimal from 'decimal.js';
import { TtlCache } from '../../utils/cache.js';
import { getSymbols, getLatestPrices, type ProSymbol } from './client.js';
import { getPrice as getXstocksPrice, canonicalSymbol } from '../xstocks/assets.service.js';

Decimal.set({ precision: 40 });

// Entitled catalog: 24h TTL (entitlements change only when the plan changes).
const catalogCache = new TtlCache<ProSymbol[]>(24 * 60 * 60 * 1000);

export interface PythLeg {
  feed: string;
  feedId: number;
  price: string;
  marketSession: string | null;
  publishTime: string | null;
  stalenessSeconds: number | null;
}

export interface FairPrice {
  symbol: string;
  equity: PythLeg | null;
  token: PythLeg | null;
  /** xStocks reference price (display only). */
  reference: { value: string; timestamp: string } | null;
  /** Token feed vs equity feed, in bps. Null when either leg is missing. */
  tokenVsEquityBps: number | null;
  /** Equity feed vs xStocks reference, in bps. Null when either is missing. */
  equityVsReferenceBps: number | null;
}

/** Human price from mantissa × 10^exponent. Exact decimal math. */
export function humanPrice(mantissa: string | number, exponent: number): string {
  return new Decimal(mantissa).mul(new Decimal(10).pow(exponent)).toString();
}

export function spreadBps(a: string, b: string): number | null {
  try {
    const base = new Decimal(b);
    if (base.isZero()) return null;
    return Number(new Decimal(a).sub(base).div(base).mul(10_000).toFixed(2));
  } catch {
    return null;
  }
}

async function getCatalog(): Promise<ProSymbol[]> {
  const cached = catalogCache.get('catalog');
  if (cached) return cached;
  const symbols = await getSymbols();
  catalogCache.set('catalog', symbols);
  return symbols;
}

/** Resolve the two Pro feeds for an xStock: real equity + on-chain token (either may be absent). */
export async function resolveFeeds(symbol: string): Promise<{ equity: ProSymbol | null; token: ProSymbol | null }> {
  const upper = symbol.toUpperCase();
  const base = upper.endsWith('X') ? upper.slice(0, -1) : upper;
  const catalog = await getCatalog();
  const equity = catalog.find((f) => f.symbol === `Equity.US.${base}/USD` && f.state === 'stable') ?? null;
  const token = catalog.find((f) => f.symbol === `Crypto.${upper}/USD` && f.state === 'stable') ?? null;
  return { equity, token };
}

/**
 * GET /api/assets/:symbol/fair-price — Pyth equity + token legs, xStocks reference,
 * and spreads. Display/analysis only; execution quotes stay authoritative.
 * Legs are independently nullable: demo/limited keys may entitle only some feeds.
 */
export async function getFairPrice(symbol: string): Promise<FairPrice> {
  const canonical = canonicalSymbol(symbol);
  const upper = canonical.toUpperCase();
  const { equity, token } = await resolveFeeds(upper);
  const feeds = [equity, token].filter((f): f is ProSymbol => Boolean(f));

  const updates =
    feeds.length > 0 ? await getLatestPrices(feeds.map((f) => f.pyth_lazer_id)) : [];
  const byId = new Map(updates.map((u) => [u.priceFeedId, u]));

  const leg = (feed: ProSymbol | null): PythLeg | null => {
    if (!feed) return null;
    const update = byId.get(feed.pyth_lazer_id);
    if (!update?.price) return null;
    const expo = update.exponent ?? feed.exponent;
    if (expo === undefined || expo === null || !Number.isFinite(Number(expo))) return null;
    // Provider mantissas are untrusted input: garbage must blank the leg,
    // never throw a 500 for the whole fair-price response.
    let price: string;
    try {
      price = humanPrice(update.price, expo);
    } catch {
      return null;
    }
    if (!Number.isFinite(Number(price)) || Number(price) <= 0) return null;
    let publishTime: string | null = null;
    let stalenessSeconds: number | null = null;
    if (update.feedUpdateTimestamp) {
      const ms = Math.round(update.feedUpdateTimestamp / 1000);
      publishTime = new Date(ms).toISOString();
      stalenessSeconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
    }
    return {
      feed: feed.symbol,
      feedId: feed.pyth_lazer_id,
      price,
      marketSession: update.marketSession ?? null,
      publishTime,
      stalenessSeconds,
    };
  };

  const equityLeg = leg(equity);
  const tokenLeg = leg(token);
  const reference = await getXstocksPrice(upper).catch(() => null);

  return {
    symbol: canonical,
    equity: equityLeg,
    token: tokenLeg,
    reference: reference ? { value: reference.value, timestamp: reference.timestamp } : null,
    tokenVsEquityBps:
      equityLeg && tokenLeg ? spreadBps(tokenLeg.price, equityLeg.price) : null,
    equityVsReferenceBps:
      equityLeg && reference ? spreadBps(equityLeg.price, reference.value) : null,
  };
}
