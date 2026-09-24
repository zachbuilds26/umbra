import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TtlCache } from '../../utils/cache.js';
import { xstocksClient } from './client.js';
import type { UmbraAsset } from '../../domain/models.js';

// Cache durations per plan §28.
const ASSET_TTL_MS = 10 * 60 * 1000;
const PRICE_TTL_MS = 60 * 1000; // covers the 60s tape poll: polls hit cache, upstream stays quiet
const MULT_TTL_MS = 60 * 1000;

const assetCache = new TtlCache<UmbraAsset>(ASSET_TTL_MS);
const priceCache = new TtlCache<{ value: string; timestamp: string }>(PRICE_TTL_MS);
const multCache = new TtlCache<string>(MULT_TTL_MS);
// Last-good reference prices: served (with their original timestamps) when the
// upstream blips, so the tape degrades to slightly-stale instead of blank.
// Persisted to disk so a backend restart still opens instantly.
const lastGoodPrice = new Map<string, { value: string; timestamp: string }>();
// Repo-root-relative (no import.meta: tsconfig module is CommonJS, and this
// must also resolve from dist/ after `npm run build`).
function lastGoodPath(): string {
  const direct = join(process.cwd(), 'data', 'last-good-prices.json');
  return direct;
}
const LAST_GOOD_FILE = lastGoodPath();
let lastGoodLoaded = false;
let lastGoodSaveTimer: ReturnType<typeof setInterval> | null = null;

// Last-good multipliers. The multiplier converts an xStock's raw on-chain units
// into share units, so a swap cannot be priced without it — but xStocks stalls
// often enough that losing it would break trading. Cached (memory + disk), the
// multiplier survives the blips the same way prices do.
const MULT_LAST_GOOD_FILE = join(process.cwd(), 'data', 'last-good-multipliers.json');
const lastGoodMult = new Map<string, { value: string; timestamp: string }>();
let lastGoodMultLoaded = false;

function loadLastGoodMultipliers(): void {
  if (lastGoodMultLoaded) return;
  lastGoodMultLoaded = true;
  try {
    const obj = JSON.parse(readFileSync(MULT_LAST_GOOD_FILE, 'utf-8')) as Record<string, { value: string; timestamp: string }>;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v.value === 'string' && Number(v.value) > 0) lastGoodMult.set(k, v);
    }
  } catch {
    // first boot / no file yet
  }
}

function saveLastGoodMultipliers(): void {
  try {
    mkdirSync(dirname(MULT_LAST_GOOD_FILE), { recursive: true });
    writeFileSync(MULT_LAST_GOOD_FILE, JSON.stringify(Object.fromEntries(lastGoodMult)));
  } catch {
    // best-effort persistence
  }
}

function loadLastGoodPrices(): void {
  if (lastGoodLoaded) return;
  lastGoodLoaded = true;
  try {
    const raw = readFileSync(LAST_GOOD_FILE, 'utf-8');
    const obj = JSON.parse(raw) as Record<string, { value: string; timestamp: string }>;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v.value === 'string') lastGoodPrice.set(k, v);
    }
  } catch {
    // first boot / no file yet — start empty
  }
  if (!lastGoodSaveTimer) {
    lastGoodSaveTimer = setInterval(() => {
      try {
        mkdirSync(dirname(LAST_GOOD_FILE), { recursive: true });
        writeFileSync(LAST_GOOD_FILE, JSON.stringify(Object.fromEntries(lastGoodPrice)));
      } catch {
        // cache persistence is best-effort
      }
    }, 60_000);
    lastGoodSaveTimer.unref?.();
  }
}

// Well-known Solana mints (not xStocks config — canonical stablecoin addresses,
// each verified: USDC via long-standing canonical mint, USDT confirmed live via
// Jupiter token search + on-chain getTokenSupply: 6 decimals, ~$3.8B supply).
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOLANA_USDC_DECIMALS = 6;
export const SOLANA_USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const SOLANA_USDT_DECIMALS = 6;
// Issuer logos (verified live): Circle + Tether via the Solana token-list copies
// Jupiter's token API points at (same mints we route).
export const SOLANA_USDC_LOGO =
  'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png';
export const SOLANA_USDT_LOGO =
  'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg';
export const STABLE_SYMBOLS = ['USDC', 'USDT'] as const;
// Solana xStocks use 8 scaled decimals (svmDecimals observed live).
export const SOLANA_XSTOCK_DECIMALS = 8;

export function isStableSymbol(symbol: string): boolean {
  return (STABLE_SYMBOLS as readonly string[]).includes(symbol);
}

function solanaDeployment(deployments: Array<{ address: string; network: string }> = []) {
  return deployments.find((d) => d.network === 'Solana');
}

// xStocks symbols are case-sensitive upstream (NVDAx, not NVDAX).
// Canonical form: upper-case base + lower-case 'x'. Stables stay upper-case.
export function canonicalSymbol(symbol: string): string {
  const s = symbol.trim();
  const upper = s.toUpperCase();
  if (isStableSymbol(upper)) return upper;
  const m = /^([A-Za-z0-9]+)[xX]$/.exec(s);
  if (m?.[1]) return `${m[1].toUpperCase()}x`;
  return s;
}

/**
 * Full asset-symbol normalization: stables stay upper-case, PreStocks resolve to
 * ALL-CAPS via the live directory (disambiguates the ...X collision: SPACEX the
 * pre-IPO token vs *x the xStock pattern), everything else uses xStock canonical form.
 */
export async function canonicalAssetSymbol(symbol: string): Promise<string> {
  const upper = symbol.trim().toUpperCase();
  if (isStableSymbol(upper)) return upper;
  const { getPrestocksSymbols } = await import('../prestocks/assets.js');
  const pre = await getPrestocksSymbols().catch(() => new Set<string>());
  if (pre.has(upper)) return upper;
  return canonicalSymbol(symbol);
}

export async function getSolanaMint(symbol: string): Promise<{ mint: string; decimals: number } | null> {
  if (symbol === 'USDC') return { mint: SOLANA_USDC_MINT, decimals: SOLANA_USDC_DECIMALS };
  if (symbol === 'USDT') return { mint: SOLANA_USDT_MINT, decimals: SOLANA_USDT_DECIMALS };
  // Pre-IPO shelf (PreStocks, Solana-native, plain 9dp amounts — no multiplier).
  const pre = await getPrestocksMint(symbol).catch(() => null);
  if (pre) return pre;
  const asset = await getAsset(symbol, 'Solana');
  if (!asset) return null;
  return { mint: asset.address, decimals: asset.decimals ?? SOLANA_XSTOCK_DECIMALS };
}

async function getPrestocksMint(symbol: string): Promise<{ mint: string; decimals: number } | null> {
  const { listPrestocks, PRESTOCKS_DECIMALS } = await import('../prestocks/assets.js');
  const list = await listPrestocks();
  const found = list.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase());
  if (!found) return null;
  return { mint: found.contract_address, decimals: PRESTOCKS_DECIMALS };
}

export async function getAsset(symbol: string, network = 'Solana'): Promise<UmbraAsset | null> {
  const canonical = canonicalSymbol(symbol);
  const key = `${canonical.toUpperCase()}:${network}`;
  const cached = assetCache.get(key);
  if (cached) return cached;

  if (canonical === 'USDC' || canonical === 'USDT') {
    const isUsdc = canonical === 'USDC';
    const stable: UmbraAsset = {
      symbol: canonical,
      name: isUsdc ? 'USD Coin' : 'Tether USD',
      network: 'Solana',
      address: isUsdc ? SOLANA_USDC_MINT : SOLANA_USDT_MINT,
      decimals: SOLANA_USDC_DECIMALS,
      logo: isUsdc ? SOLANA_USDC_LOGO : SOLANA_USDT_LOGO,
      tokenStandard: 'SPL_TOKEN',
      bridgeSupported: false,
      swapSupported: true,
    };
    assetCache.set(key, stable);
    return stable;
  }

  // Pre-IPO shelf (PreStocks). Solana-native, no bridge leg.
  const { getPrestocksAsset } = await import('../prestocks/assets.js');
  const pre = await getPrestocksAsset(canonical).catch(() => null);
  if (pre) {
    assetCache.set(key, pre);
    return pre;
  }

  const res = await xstocksClient.getAsset(canonical);
  if (!res.data) return null;
  const raw = res.data;
  const dep = solanaDeployment(raw.deployments ?? []);
  const bridgeSupported = await isBridgeSupported(raw.symbol).catch(() => false);
  const asset: UmbraAsset = {
    symbol: raw.symbol,
    name: raw.name,
    underlyingSymbol: raw.underlying?.symbol ?? raw.underlyingSymbol ?? undefined,
    network,
    address: network === 'Solana' ? (dep?.address ?? '') : (dep?.address ?? raw.deployments?.[0]?.address ?? ''),
    decimals: SOLANA_XSTOCK_DECIMALS,
    ...(raw.logo ? { logo: raw.logo } : {}),
    tokenStandard: 'SPL_TOKEN_2022',
    bridgeSupported,
    swapSupported: Boolean(dep?.address),
  };
  if (!asset.address) return null;
  assetCache.set(key, asset);
  return asset;
}

/** Dynamic discovery: supported xStocks come from the live bridge product list + direct lookup.
 * When `only` is given, resolve just those symbols and skip bridge discovery
 * entirely — the frontend's fixed 56-symbol shelf must not pay for 1000+
 * stalled lookups on a throttled network. */
export async function listSolanaAssets(only?: string[]): Promise<UmbraAsset[]> {
  const wanted: string[] =
    only && only.length
      ? [...new Set(only.map((s) => s.trim()).filter(Boolean))].slice(0, 100)
      : await (async () => {
          const { listBridgeAssets } = await import('../bridge/bridge-config.service.js');
          const symbols = await listBridgeAssets().catch(() => [] as string[]);
          const { listPrestocks } = await import('../prestocks/assets.js');
          const preList = await listPrestocks().catch(() => []);
          return [
            ...STABLE_SYMBOLS,
            ...preList.map((p) => p.symbol),
            ...symbols,
          ];
        })();
  // Bounded parallel fan-out: the old sequential loop made cold /api/assets take
  // ~40s+ (115 symbols × up-to-6s stalls). 12-way keeps worst case near one stall.
  const CONCURRENCY = 12;
  const out: UmbraAsset[] = [];
  for (let i = 0; i < wanted.length; i += CONCURRENCY) {
    const batch = wanted.slice(i, i + CONCURRENCY);
    const got = await Promise.all(batch.map((s) => getAsset(s).catch(() => null)));
    for (const a of got) if (a) out.push(a);
  }
  // Stables first, then pre-IPO, then xStocks — stable order for the pickers.
  const rank = (s: string) =>
    (STABLE_SYMBOLS as readonly string[]).includes(s) ? 0 : /x$/.test(s) ? 2 : 1;
  out.sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol));
  return out;
}

async function isBridgeSupported(symbol: string): Promise<boolean> {
  const { isAssetBridgeableToSolana } = await import('../bridge/bridge-config.service.js');
  return isAssetBridgeableToSolana(symbol);
}

export function getLastGoodPrice(symbol: string): { value: string; timestamp: string } | null {
  loadLastGoodPrices();
  return lastGoodPrice.get(symbol.toUpperCase()) ?? null;
}

export async function getPrice(symbol: string): Promise<{ value: string; currency: 'USD'; timestamp: string } | null> {
  const canonical = canonicalSymbol(symbol);
  // USD-pegged stables: the $1.00 reference is definitional (and matches how quotes value them).
  if (isStableSymbol(canonical)) {
    return { value: '1', currency: 'USD', timestamp: new Date().toISOString() };
  }
  const key = canonical.toUpperCase();
  const cached = priceCache.get(key);
  if (cached) return { ...cached, currency: 'USD' as const };
  loadLastGoodPrices();
  const last = lastGoodPrice.get(key);
  const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
    Promise.race([p, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]) as Promise<T | null>;
  // xStocks blackholes us (6s stall) when Cloudflare blocks — fail fast so
  // Jupiter/last-good can serve the tape in ~2.5s instead of 6s.
  const res = await withTimeout(xstocksClient.getPrice(canonical).catch(() => null), 2500);
  const quoteOk = typeof res?.quote === 'number' && Number.isFinite(res.quote) && res.quote > 0;
  if (!res || !quoteOk) {
    // Jupiter-only for price — OKX/Finnhub disabled per request to stick to Jupiter
    const jup = await withTimeout(getJupiterPriceFor(canonical).catch(() => null), 3500);
    if (jup) {
      const entry = { value: jup, timestamp: new Date().toISOString() };
      priceCache.set(key, entry);
      lastGoodPrice.set(key, entry);
      return { ...entry, currency: 'USD' as const };
    }
    return last ? { ...last, currency: 'USD' as const } : null;
  }
  const entry = { value: String(res.quote), timestamp: new Date().toISOString() };
  priceCache.set(key, entry);
  lastGoodPrice.set(key, entry);
  return { ...entry, currency: 'USD' };
}

async function resolveMintForJupiter(symbol: string): Promise<string | null> {
  const { getJupiterMint } = await import('../jupiter/price.service.js');
  // Jupiter directory first (cached, not blocked) — avoids the 2.5s xStocks stall
  // on getSolanaMint when Cloudflare is blackholing us.
  const via = await getJupiterMint(symbol).catch(() => null);
  if (via) return via.mint;
  const direct = await getSolanaMint(symbol).catch(() => null);
  if (direct) return direct.mint;
  return null;
}

/** Jupiter last-swapped USD price for a symbol's verified Solana mint (or null). */
export async function getJupiterPriceFor(symbol: string): Promise<string | null> {
  const { getJupiterPrice } = await import('../jupiter/price.service.js');
  const mint = await resolveMintForJupiter(symbol);
  if (!mint) return null;
  const jp = await getJupiterPrice(mint).catch(() => null);
  // Zero/negative "prices" are provider glitches, never a market: refuse them
  // so the tape degrades to last-good instead of flashing $0 as live.
  if (!jp || !Number.isFinite(jp.usdPrice) || jp.usdPrice <= 0) return null;
  return String(jp.usdPrice);
}

/** Jupiter's published liquidity USD for a symbol (or null when unindexed).
 * 11 of our 56 have no indexed liquidity anywhere (Jupiter and DexScreener
 * both) — callers must show '—', never invent. */
export async function getJupiterLiquidity(symbol: string): Promise<string | null> {
  const { getJupiterPrice } = await import('../jupiter/price.service.js');
  const mint = await resolveMintForJupiter(symbol).catch(() => null);
  if (!mint) return null;
  const jp = await getJupiterPrice(mint).catch(() => null);
  const v = (jp as unknown as { liquidity?: number } | null)?.liquidity;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? String(v) : null;
}

/** Jupiter's measured 24h change for a symbol (or null when unpriced). */
export async function getJupiterChange24h(symbol: string): Promise<number | null> {
  const { getJupiterPrice } = await import('../jupiter/price.service.js');
  const mint = await resolveMintForJupiter(symbol);
  if (!mint) return null;
  const jp = await getJupiterPrice(mint).catch(() => null);
  if (!jp || !Number.isFinite(jp.priceChange24h)) return null;
  return Math.round(jp.priceChange24h * 100) / 100;
}

export async function getMultiplier(symbol: string, network = 'Solana'): Promise<string | null> {
  const canonical = canonicalSymbol(symbol);
  const key = `${canonical.toUpperCase()}:${network}`;
  const cached = multCache.get(key);
  if (cached) return cached;
  loadLastGoodMultipliers();
  const last = lastGoodMult.get(key);
  let res: { currentMultiplier?: number } | null = null;
  try {
    // xStocks can stall for the full fetch timeout. A swap must not hang behind
    // it, and a raw transport error must never surface as a quote failure.
    res = await Promise.race([
      xstocksClient.getMultiplier(canonical, network).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 4_000)),
    ]);
  } catch {
    res = null;
  }
  if (res?.currentMultiplier === undefined || !Number.isFinite(res.currentMultiplier) || res.currentMultiplier <= 0) {
    // Upstream is down or has no value: the last known multiplier still converts
    // raw units correctly (it barely moves), so trading continues.
    return last ? last.value : null;
  }
  const value = String(res.currentMultiplier);
  multCache.set(key, value);
  lastGoodMult.set(key, { value, timestamp: new Date().toISOString() });
  saveLastGoodMultipliers();
  return value;
}

// Underlyings Finnhub would misattribute (Vx -> "V" = Visa Inc). Skipped there;
// the Jupiter fallback below still applies.
const FINNHUB_SKIP = new Set(['V']);

/** Underlying equity market cap for display: Finnhub first (fast, complete
 * for single stocks), Jupiter fallback (covers ETFs like SPY/QQQ/GLD that
 * Finnhub profile2 doesn't return). Pre-IPO assets already carry theirs. */
export async function getEquityMarketCapForAsset(asset: UmbraAsset): Promise<string | null> {
  if (asset.marketCap) return asset.marketCap;
  const underlying = asset.underlyingSymbol ?? asset.symbol.replace(/x$/i, '');
  if (underlying && !FINNHUB_SKIP.has(underlying.toUpperCase())) {
    const { getFinnhubMarketCap } = await import('../marketcap/finnhub.js');
    const mcap = await getFinnhubMarketCap(underlying).catch(() => null);
    if (mcap) return mcap;
  }
  if (!asset.address) return null;
  const { getJupiterPrice } = await import('../jupiter/price.service.js');
  const jp = await getJupiterPrice(asset.address).catch(() => null);
  const m = (jp as unknown as { stockData?: { mcap?: number }; marketCap?: number } | null);
  const v = m?.stockData?.mcap ?? m?.marketCap;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? String(Math.round(v)) : null;
}

/** Attach live price + multiplier + marketCap to a base asset (GET /api/assets/:symbol). */
export async function enrichAsset(symbol: string): Promise<UmbraAsset | null> {
  const asset = await getAsset(symbol);
  if (!asset) return null;
  const [price, multiplier, marketCap, liquidity] = await Promise.all([
    getPrice(symbol).catch(() => null),
    isStableSymbol(canonicalSymbol(symbol)) ? Promise.resolve('1') : getMultiplier(symbol).catch(() => null),
    isStableSymbol(canonicalSymbol(symbol))
      ? Promise.resolve(null)
      : getEquityMarketCapForAsset(asset).catch(() => null),
    isStableSymbol(canonicalSymbol(symbol))
      ? Promise.resolve(null)
      : import('../jupiter/price.service.js')
          .then((m) => m.getJupiterPrice(asset.address).then((jp) => (jp as any)?.liquidity ? String((jp as any).liquidity) : null).catch(() => null))
          .catch(() => null),
  ]);
  return {
    ...asset,
    ...(price ? { price } : {}),
    ...(multiplier ? { multiplier } : {}),
    ...(marketCap ? { marketCap } : {}),
    ...(liquidity ? { liquidity } : {}),
  };
}
