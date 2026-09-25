import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listSolanaAssets, enrichAsset, getPrice, getLastGoodPrice, getAsset, getSolanaMint, canonicalSymbol, canonicalAssetSymbol } from '../services/xstocks/assets.service.js';
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
    const CONCURRENCY = 8;
    // Prime prestocks symbol set once per request (single-flight cached)
    const preSet = await getPrestocksSymbols().catch(() => new Set<string>());
    // One batched Tokens snapshot call for every resolvable mint: price,
    // 24h change and liquidity for the whole shelf in a single request.
    // Pre-IPO mints are skipped — Tokens indexes no markets for them.
    const { getTokensSnapshots } = await import('../services/tokens/market.js');
    const mintBySymbol = new Map<string, string>();
    await Promise.all(
      requested.filter((s) => !preSet.has(s.toUpperCase())).map(async (symbol) => {
        const found = await getSolanaMint(symbol).catch(() => null);
        if (found) mintBySymbol.set(symbol, found.mint);
      }),
    );
    const snaps = await getTokensSnapshots([...mintBySymbol.values()]);
    const symbolSnap = (symbol: string) => {
      const mint = mintBySymbol.get(symbol);
      return mint ? (snaps.get(mint) ?? null) : null;
    };
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
              const { getJupiterLiquidity, getJupiterChange24h } = await import('../services/xstocks/assets.service.js');
              return {
                symbol,
                price: pre.value,
                marketCap: pa?.marketCap ?? null,
                liquidity: await getJupiterLiquidity(symbol).catch(() => null),
                change24hPct: (await getJupiterChange24h(symbol).catch(() => null)) ?? changePct(symbol),
                timestamp: pre.timestamp,
              };
            }
          }
          const mcap = null;
          // Change precedence (all measured, never invented): Tokens' real 24h
          // window first, then our own history ring. No live Jupiter calls
          // on this path — Tokens is the stocks page source.
          const snap = symbolSnap(symbol);
          const snapPrice =
            snap?.hasMarket && snap.priceUsd !== null
              ? { value: String(snap.priceUsd), currency: 'USD' as const, timestamp: new Date().toISOString() }
              : null;
          const lastGood = (() => {
            const last = getLastGoodPrice(symbol);
            return last ? { ...last, currency: 'USD' as const } : null;
          })();
          const served = snapPrice ?? lastGood;
          if (served) recordPrice(symbol, served.value);
          const snapChange = snap?.hasMarket ? snap.change24hPct : null;
          const snapLiq = snap?.hasMarket && snap.liquidityUsd !== null ? String(snap.liquidityUsd) : null;
          return {
            symbol,
            price: served?.value ?? null,
            marketCap: mcap,
            liquidity: snapLiq,
            change24hPct: served ? (snapChange ?? changePct(symbol)) : null,
            timestamp: served?.timestamp ?? new Date().toISOString(),
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
  // asset, price, 24h change, sparkline points, swap/bridge flags.
  app.get('/api/assets/:symbol/summary', async (req) => {
    const params = z.object({ symbol: z.string().min(1).max(16) }).parse(req.params);
    const symbol = await canonicalAssetSymbol(params.symbol);
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]) as Promise<T | null>;
    const asset = (await withTimeout(enrichAsset(symbol), 4000)) ?? (await getAsset(symbol).catch(() => null) as any);
    if (!asset) throw notFound('UNSUPPORTED_ASSET', `Asset ${params.symbol} is not supported.`);
    if (asset.price) recordPrice(symbol, asset.price.value);
    const { getTokensSnapshots } = await import('../services/tokens/market.js');
    const foundMint = await getSolanaMint(symbol).catch(() => null);
    const snap = foundMint ? (await getTokensSnapshots([foundMint.mint])).get(foundMint.mint) ?? null : null;
    return {
      summary: {
        asset,
        change24hPct: (snap?.hasMarket ? snap.change24hPct : null) ?? changePct(symbol),
        sparkline: sparkline(symbol),
      },
    };
  });

  app.get('/api/assets/:symbol', async (req) => {
    const params = z.object({ symbol: z.string().min(1).max(16) }).parse(req.params);
    const asset = await enrichAsset(params.symbol.toUpperCase());
    if (!asset) throw notFound('UNSUPPORTED_ASSET', `Asset ${params.symbol} is not supported.`);
    return { asset };
  });

  // GET /api/assets/marketcaps?symbols=A,B,C — one request for the whole shelf.
    //
  // Token market caps come from Tokens market snapshots (on-chain asset
  // values, not equity valuations): one batched call, no per-symbol fan-out.
  app.get('/api/assets/marketcaps', async (req) => {
    const q = z.object({ symbols: z.string().min(1).max(600) }).parse(req.query);
    const wanted = [...new Set(q.symbols.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 60);
    if (wanted.length === 0) return { marketCaps: {} };
    const { getTokensSnapshots } = await import('../services/tokens/market.js');
    const mintBySymbol = new Map<string, string>();
    await Promise.all(
      wanted.map(async (raw) => {
        const symbol = await canonicalAssetSymbol(raw).catch(() => null);
        if (!symbol) return;
        const found = await getSolanaMint(symbol).catch(() => null);
        if (found) mintBySymbol.set(symbol, found.mint);
      }),
    );
    const snaps = await getTokensSnapshots([...mintBySymbol.values()]);
    const marketCaps: Record<string, string> = {};
    for (const [symbol, mint] of mintBySymbol) {
      const snap = snaps.get(mint);
      if (snap?.hasMarket && snap.marketCapUsd !== null) marketCaps[symbol] = String(snap.marketCapUsd);
    }
    return { marketCaps };
  });

  // GET /api/assets/:symbol/marketcap — Tokens snapshot value for one symbol.
  app.get('/api/assets/:symbol/marketcap', async (req) => {
    const params = z.object({ symbol: z.string().min(1).max(16) }).parse(req.params);
    const symbol = await canonicalAssetSymbol(params.symbol);
    const found = await getSolanaMint(symbol).catch(() => null);
    if (!found) throw notFound('UNSUPPORTED_ASSET', `Asset ${params.symbol} is not supported.`);
    const { getTokensSnapshots } = await import('../services/tokens/market.js');
    const snap = (await getTokensSnapshots([found.mint])).get(found.mint) ?? null;
    return { symbol, marketCap: snap?.hasMarket && snap.marketCapUsd !== null ? String(snap.marketCapUsd) : null };
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
