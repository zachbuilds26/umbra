import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listSolanaAssets, enrichAsset, getPrice, getLastGoodPrice, getAsset, canonicalSymbol, canonicalAssetSymbol } from '../services/xstocks/assets.service.js';
import { getFairPrice } from '../services/pyth/fair-price.service.js';
import { recordPrice, changePct, sparkline } from '../services/prices/history.js';
import { getPrestocksPrice, getPrestocksSymbols } from '../services/prestocks/assets.js';
import { notFound, upstream } from '../utils/errors.js';
import { TtlCache } from '../utils/cache.js';
import type { UmbraAsset } from '../domain/models.js';

const ASSETS_CACHE_MS = 5 * 60 * 1000;
const assetsCache = new TtlCache<UmbraAsset[]>(ASSETS_CACHE_MS);
let assetsInflight: Promise<UmbraAsset[]> | null = null;
// Short-TTL ticker responses keyed by symbol set: tape + chunks re-request
// identical sets, and each uncached call repays ~10s of paced lookups.
const TICKER_CACHE_MS = 45 * 1000;
const tickerCache = new TtlCache<{ ticker: unknown[] }>(TICKER_CACHE_MS);
// Last-known-complete list: xStocks stalls/delist-blips must never shrink the
// served directory (the frontend count is fixed, so rows must be too).
let lastGoodAssets: UmbraAsset[] | null = null;

export async function assetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/assets', async (req) => {
    // ?symbols=NVDAx,AAPLx,... — resolve only the requested shelf (fast path
    // for the fixed frontend list; skips 1000+ discovery lookups). No param =
    // full discovery (compat).
    const q = z.object({ symbols: z.string().min(1).max(1200).optional() }).parse(req.query);
    if (q.symbols) {
      const only = [...new Set(q.symbols.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 100);
      const assets = await listSolanaAssets(only);
      return { assets };
    }
    const cached = assetsCache.get('all');
    if (cached) return { assets: cached };
    if (assetsInflight) {
      const assets = await assetsInflight;
      return { assets };
    }
    assetsInflight = listSolanaAssets();
    try {
      const assets = await assetsInflight;
      if (!lastGoodAssets || assets.length >= lastGoodAssets.length) {
        lastGoodAssets = assets;
        assetsCache.set('all', assets);
      }
      return { assets: lastGoodAssets ?? assets };
    } finally {
      assetsInflight = null;
    }
  });

  // GET /api/assets/ticker?symbols=NVDAx,AAPLx,... (max 50) — one call for the tape.
  // Prices fetch with bounded concurrency (kind to upstream rate limits) and fall
  // back to last-good values, so the tape degrades to slightly-stale, never blank.
  // Change is null until the history ring holds 2+ points — honest, never backfilled.
  app.get('/api/assets/ticker', async (req) => {
    const q = z
      .object({ symbols: z.string().min(1).max(600).optional() })
      .parse(req.query);
    const requested = q.symbols
      ? (
          await Promise.all(
            [...new Set(q.symbols.split(',').map((s) => s.trim()).filter(Boolean))]
              .slice(0, 50)
              .map((s) => canonicalAssetSymbol(s)),
          )
        )
      : [];
    const tkey = [...requested].sort().join(',');
    const theld = tickerCache.get(tkey);
    if (theld) return theld;
    const out: Array<{ symbol: string; price: string | null; marketCap: string | null; liquidity: string | null; change24hPct: number | null; timestamp: string }> = [];
    // Bounded concurrency + per-symbol timeout: xStocks can stall (60s per
    // symbol when Cloudflare blocks us) — cap it so pre-IPO prices stay fast.
    // Pre-IPO symbols skip xStocks entirely (direct prestocks lookup is ~1ms).
    // Timeout is 9s: xStocks 6s + Jupiter ~1.1s pacing + overhead, still falls
    // back to last-good before the 10s fetchJsonWithRetry ceiling.
    const CONCURRENCY = 8;
    const PRICE_TIMEOUT_MS = 9000;
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]) as Promise<T | null>;
    // Prime prestocks symbol set once per request (single-flight cached)
    const preSet = await getPrestocksSymbols().catch(() => new Set<string>());
    for (let i = 0; i < requested.length; i += CONCURRENCY) {
      const batch = requested.slice(i, i + CONCURRENCY);
      const priced = await Promise.all(
        batch.map(async (symbol) => {
          // Pre-IPO: fast path, no xStocks timeout. Carry the valuation too —
          // the list reads marketCap off the ticker and would otherwise show —.
          if (preSet.has(symbol.toUpperCase())) {
            const pre = await getPrestocksPrice(symbol).catch(() => null);
            if (pre) {
              recordPrice(symbol, pre.value);
              const { getPrestocksAsset } = await import('../services/prestocks/assets.js');
              const pa = await getPrestocksAsset(symbol).catch(() => null);
              const { getJupiterLiquidity } = await import('../services/xstocks/assets.service.js');
              return {
                symbol,
                price: pre.value,
                marketCap: pa?.marketCap ?? null,
                liquidity: await getJupiterLiquidity(symbol).catch(() => null),
                change24hPct: changePct(symbol),
                timestamp: pre.timestamp,
              };
            }
          }
          let price =
            (await withTimeout(
              getPrice(symbol)
                .catch(() => null)
                .then(async (p) => {
                  if (p) return p;
                  const pre = await getPrestocksPrice(symbol).catch(() => null);
                  return pre ? { ...pre, currency: 'USD' as const } : null;
                }),
              PRICE_TIMEOUT_MS,
            )) ?? null;
          if (!price) {
            const last = getLastGoodPrice(symbol);
            if (last) price = { ...last, currency: 'USD' as const };
          }
          if (price) recordPrice(symbol, price.value);
          const mcap = null;
          // Change precedence (all measured, never invented): Jupiter's real 24h
          // window first, then our own history ring, then flat-0 for known prices.
          const { getJupiterChange24h, getJupiterLiquidity } = await import('../services/xstocks/assets.service.js');
          const jupChange = await getJupiterChange24h(symbol).catch(() => null);
          // Liquidity rides the same cached Jupiter object (warmed by the call above).
          const jupLiq = await getJupiterLiquidity(symbol).catch(() => null);
          return {
            symbol,
            price: price?.value ?? null,
            marketCap: mcap,
            liquidity: jupLiq,
            change24hPct: price ? (jupChange ?? changePct(symbol)) : null,
            timestamp: price?.timestamp ?? new Date().toISOString(),
          };
        }),
      );
      out.push(...priced);
    }
    // Preserve request order.
    const order = new Map(requested.map((s, i) => [s, i]));
    out.sort((a, b) => (order.get(a.symbol) ?? 0) - (order.get(b.symbol) ?? 0));
    tickerCache.set(tkey, { ticker: out });
    return { ticker: out };
  });

  // GET /api/assets/:symbol/summary — everything the hover card needs in one call:
  // asset, price, 24h change, sparkline points, fair-price spreads, swap/bridge flags.
  app.get('/api/assets/:symbol/summary', async (req) => {
    const params = z.object({ symbol: z.string().min(1).max(16) }).parse(req.params);
    const symbol = await canonicalAssetSymbol(params.symbol);
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]) as Promise<T | null>;
    const asset = (await withTimeout(enrichAsset(symbol), 4000)) ?? (await getAsset(symbol).catch(() => null) as any);
    if (!asset) throw notFound('UNSUPPORTED_ASSET', `Asset ${params.symbol} is not supported.`);
    if (asset.price) recordPrice(symbol, asset.price.value);
    const fair = await withTimeout(getFairPrice(symbol).catch(() => null), 3000);
    return {
      summary: {
        asset,
        change24hPct: changePct(symbol),
        sparkline: sparkline(symbol),
        fair: fair
          ? { tokenVsEquityBps: fair.tokenVsEquityBps, equityVsReferenceBps: fair.equityVsReferenceBps }
          : null,
      },
    };
  });

  // GET /api/pyth/coverage?symbols=… — which of these symbols this Pyth key
  // actually has a reference feed for. The UI uses it to say "covered" or
  // "not on our feed" instead of rendering an empty panel.
  app.get('/api/pyth/coverage', async (req) => {
    const q = z.object({ symbols: z.string().min(1).max(600) }).parse(req.query);
    const symbols = q.symbols.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 60);
    const { getCoverage } = await import('../services/pyth/fair-price.service.js');
    const covered = await getCoverage(symbols).catch(() => [] as never[]);
    return { covered };
  });

  app.get('/api/assets/:symbol', async (req) => {
    const params = z.object({ symbol: z.string().min(1).max(16) }).parse(req.params);
    const asset = await enrichAsset(params.symbol.toUpperCase());
    if (!asset) throw notFound('UNSUPPORTED_ASSET', `Asset ${params.symbol} is not supported.`);
    return { asset };
  });

  // GET /api/assets/:symbol/marketcap — valuation only (~300ms: no price or
  // multiplier legs). Powers the stocks list; Finnhub first, Jupiter fallback.
  app.get('/api/assets/:symbol/marketcap', async (req) => {
    const params = z.object({ symbol: z.string().min(1).max(16) }).parse(req.params);
    const symbol = await canonicalAssetSymbol(params.symbol);
    const asset = await getAsset(symbol).catch(() => null);
    if (!asset) throw notFound('UNSUPPORTED_ASSET', `Asset ${params.symbol} is not supported.`);
    const { getEquityMarketCapForAsset } = await import('../services/xstocks/assets.service.js');
    return { symbol, marketCap: await getEquityMarketCapForAsset(asset).catch(() => null) };
  });

  app.get('/api/assets/:symbol/price', async (req) => {
    const params = z.object({ symbol: z.string().min(1).max(16) }).parse(req.params);
    const symbol = canonicalSymbol(params.symbol);
    const { getPrestocksPrice, getPrestocksSymbols } = await import('../services/prestocks/assets.js');
    // Pre-IPO first (xStocks lookup stalls ~20s while their API is blocked)
    const preSet = await getPrestocksSymbols().catch(() => new Set<string>());
    if (preSet.has(symbol.toUpperCase())) {
      const pre = await getPrestocksPrice(symbol).catch(() => null);
      if (pre) return { symbol, price: pre.value, currency: 'USD' as const, timestamp: pre.timestamp };
    }
    const price = await getPrice(symbol);
    if (price) return { symbol, price: price.value, currency: price.currency, timestamp: price.timestamp };
    const pre = await getPrestocksPrice(symbol).catch(() => null);
    if (pre) return { symbol, price: pre.value, currency: 'USD' as const, timestamp: pre.timestamp };
    throw notFound('QUOTE_UNAVAILABLE', `No price available for ${symbol}.`);
  });

  // GET /api/assets/:symbol/fair-price — Pyth equity + token legs + token-vs-equity spread.
  app.get('/api/assets/:symbol/fair-price', async (req) => {
    const params = z.object({ symbol: z.string().min(1).max(16) }).parse(req.params);
    return getFairPrice(canonicalSymbol(params.symbol));
  });

  // GET /api/assets/:symbol/holders — supply + largest accounts from standard
  // RPC (no indexer key needed). Concentration only — exact holder *counts*
  // need an indexer (Helius free tier); we never fake that number.
  app.get('/api/assets/:symbol/holders', async (req) => {
    const params = z.object({ symbol: z.string().min(1).max(16) }).parse(req.params);
    const symbol = await canonicalAssetSymbol(params.symbol);
    const { getSolanaMint } = await import('../services/xstocks/assets.service.js');
    const found = await getSolanaMint(symbol);
    if (!found) throw notFound('UNSUPPORTED_ASSET', `Asset ${params.symbol} is not supported.`);
    const { getConnection } = await import('../services/solana/connection.js');
    const { PublicKey } = await import('@solana/web3.js');
    const conn = getConnection();
    let mint: InstanceType<typeof PublicKey>;
    try {
      mint = new PublicKey(found.mint);
    } catch {
      throw upstream('PROVIDER_ERROR', `On-chain data for ${symbol} is temporarily unreadable.`);
    }
    const [supply, largest] = await Promise.all([
      conn.getTokenSupply(mint).catch(() => null),
      conn.getTokenLargestAccounts(mint).catch(() => null),
    ]);
    if (!supply) throw upstream('RPC_ERROR', 'Solana RPC is temporarily unreachable. Retry shortly.');
    let total: bigint;
    try {
      total = BigInt(supply.value.amount);
    } catch {
      throw upstream('PROVIDER_ERROR', `On-chain data for ${symbol} is temporarily unreadable.`);
    }
    const rows = (largest?.value ?? []).flatMap((r) => {
      try {
        const amt = BigInt(r.amount);
        return [{
          address: r.address.toString(),
          amount: r.amount,
          pct: total > 0n ? Number((amt * 10000n) / total) / 100 : 0,
        }];
      } catch {
        return [];
      }
    });
    const top10Pct = rows.slice(0, 10).reduce((s, r) => s + r.pct, 0);
    return {
      symbol,
      decimals: supply.value.decimals,
      supply: supply.value.amount,
      top10Pct: Math.round(top10Pct * 100) / 100,
      largest: rows.slice(0, 10),
    };
  });
}
