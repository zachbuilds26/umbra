import Decimal from 'decimal.js';
import { TtlCache } from '../../utils/cache.js';
import { getSymbols, getLatestPrices, type ProSymbol } from './client.js';
import { getPrice as getXstocksPrice, canonicalSymbol } from '../xstocks/assets.service.js';

Decimal.set({ precision: 40 });

// Entitled catalog: 24h TTL (entitlements change only when the plan changes).
const catalogCache = new TtlCache<ProSymbol[]>(24 * 60 * 60 * 1000);

/**
 * Cross-asset references. Some Umbra shelf names aren't equities: GLDx is
 * tokenized gold, so its honest Pyth benchmark is the gold spot feed, not an
 * "Equity.US.GLD" that doesn't exist. This is the compare-across-asset-classes
 * case Pyth explicitly supports.
 */
const CROSS_ASSET_FEEDS: Record<string, string> = {
  GLDX: 'Metal.XAU/USD',
};

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
  /** Why no spread is shown, when the units are not comparable. */
  note: string | null;
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

/** Resolve the Pyth reference feed for an Umbra symbol (either may be absent).
 *  Order: the token's own feed, the underlying equity, then a cross-asset
 *  benchmark (gold for GLDx). Only feeds this key is actually entitled to are
 *  ever used, so a missing leg means "not covered", never "not found". */
export async function resolveFeeds(symbol: string): Promise<{ equity: ProSymbol | null; token: ProSymbol | null }> {
  const upper = symbol.toUpperCase();
  const base = upper.endsWith('X') ? upper.slice(0, -1) : upper;
  const catalog = await getCatalog();
  const pick = (feedSymbol: string): ProSymbol | null =>
    catalog.find((f) => f.symbol === feedSymbol && f.state === 'stable') ?? null;
  const token = pick(`Crypto.${upper}/USD`);
  const equity = pick(`Equity.US.${base}/USD`) ?? pick(CROSS_ASSET_FEEDS[upper] ?? '');
  return { equity, token };
}

/**
 * Which Umbra symbols this Pyth key actually covers. Powers the honest
 * "covered / not covered" state in the UI instead of a silently empty panel.
 */
export async function getCoverage(symbols: string[]): Promise<Array<{ symbol: string; feed: string; kind: 'equity' | 'token' | 'cross-asset' }>> {
  const catalog = await getCatalog();
  const has = (feedSymbol: string): boolean =>
    catalog.some((f) => f.symbol === feedSymbol && f.state === 'stable');
  const out: Array<{ symbol: string; feed: string; kind: 'equity' | 'token' | 'cross-asset' }> = [];
  for (const raw of symbols) {
    const upper = raw.toUpperCase();
    const base = upper.endsWith('X') ? upper.slice(0, -1) : upper;
    const tokenFeed = `Crypto.${upper}/USD`;
    const equityFeed = `Equity.US.${base}/USD`;
    const crossFeed = CROSS_ASSET_FEEDS[upper];
    if (has(tokenFeed)) out.push({ symbol: upper, feed: tokenFeed, kind: 'token' });
    if (has(equityFeed)) out.push({ symbol: upper, feed: equityFeed, kind: 'equity' });
    else if (crossFeed && has(crossFeed)) out.push({ symbol: upper, feed: crossFeed, kind: 'cross-asset' });
  }
  return out;
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
  // Cross-asset benchmarks price a different unit than the token. Gold spot is
  // per troy ounce; GLDx is a per-share ETF token. Dividing one by the other
  // yields a spectacular, meaningless number (a "99,000 bps premium"), so we
  // show the feed and say why there is no spread instead of inventing one.
  const crossAsset = Boolean(equity && CROSS_ASSET_FEEDS[upper]);
  const note = crossAsset
    ? `${equity?.symbol} prices per troy ounce; ${canonical} is priced per share. Shown as context, not compared.`
    : null;

  return {
    symbol: canonical,
    equity: equityLeg,
    token: tokenLeg,
    reference: reference ? { value: reference.value, timestamp: reference.timestamp } : null,
    tokenVsEquityBps:
      crossAsset || !equityLeg || !tokenLeg ? null : spreadBps(tokenLeg.price, equityLeg.price),
    equityVsReferenceBps:
      crossAsset || !equityLeg || !reference ? null : spreadBps(equityLeg.price, reference.value),
    note,
  };
}
