import Decimal from 'decimal.js';
import { getPrice as getXstocksPrice } from '../xstocks/assets.service.js';
import { getPrestocksPrice } from '../prestocks/assets.js';

Decimal.set({ precision: 40 });

// In-memory price history ring per symbol: [{ t, p }]. Powers the ticker tape's
// 24h change and the hover-card sparkline — no chart infra, no new providers.
// Points sampled every SAMPLER_MS for the curated set; any on-demand price fetch
// also records a point, so hovered assets self-populate.

export interface PricePoint {
  t: number;
  p: string;
}

const MAX_POINTS = 1440; // 24h at 1/min
const RETENTION_MS = 25 * 60 * 60 * 1000;

// Curated sampler set: majors people put on a tape + full pre-IPO shelf + stables.
const SAMPLE_SYMBOLS = [
  'NVDAx', 'AAPLx', 'TSLAx', 'MSFTx', 'AMZNx', 'GOOGLx', 'METAx', 'SPYx', 'QQQx',
  'TSMx', 'AVGOx', 'AMDx', 'NFLXx', 'PLTRx', 'COINx', 'HOODx', 'MSTRx', 'GLDx',
  'SPACEX', 'OPENAI', 'ANTHROPIC', 'NEURALINK', 'ANDURIL', 'KALSHI', 'POLYMARKET', 'FIGUREAI',
];

const rings = new Map<string, PricePoint[]>();

export function recordPrice(symbol: string, price: string, at = Date.now()): void {
  const upper = symbol.toUpperCase();
  let ring = rings.get(upper);
  if (!ring) {
    ring = [];
    rings.set(upper, ring);
  }
  const last = ring[ring.length - 1];
  if (last && last.p === price) {
    last.t = at; // same price: extend freshness without growing the ring
    return;
  }
  // No synthetic 24h-old point: a price we never observed is not history, and
  // seeding one made the first real move read as a 24-hour change.
  ring.push({ t: at, p: price });
  const cutoff = at - RETENTION_MS;
  while (ring.length > 0 && (ring[0]?.t ?? 0) < cutoff) ring.shift();
  while (ring.length > MAX_POINTS) ring.shift();
}

export function getHistory(symbol: string): PricePoint[] {
  return [...(rings.get(symbol.toUpperCase()) ?? [])];
}

/** % change between now (or latest point) and the oldest point within windowMs.
 * null until we hold two real observations inside the window — a single sample
 * proves no movement happened, it does not prove a 0.00% 24h change. Points
 * older than the window are never used as the baseline. */
export function changePct(symbol: string, windowMs = 24 * 60 * 60 * 1000, now = Date.now()): number | null {
  const ring = rings.get(symbol.toUpperCase()) ?? [];
  if (ring.length === 0) return null;
  const cutoff = now - windowMs;
  const inWindow = ring.filter((pt) => pt.t >= cutoff);
  if (inWindow.length < 2) return null;
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  if (!first || !last || first === last) return 0;
  try {
    const base = new Decimal(first.p);
    if (base.isZero()) return null;
    return Number(new Decimal(last.p).sub(base).div(base).mul(100).toFixed(2));
  } catch {
    return null;
  }
}

/** Downsample a ring to at most n points for sparklines (even stride, always keep last). */
export function sparkline(symbol: string, n = 40): PricePoint[] {
  const ring = rings.get(symbol.toUpperCase()) ?? [];
  if (ring.length <= n) return [...ring];
  const stride = (ring.length - 1) / (n - 1);
  const out: PricePoint[] = [];
  for (let i = 0; i < n - 1; i++) {
    const pt = ring[Math.floor(i * stride)];
    if (pt) out.push(pt);
  }
  const last = ring[ring.length - 1];
  if (last) out.push(last);
  return out;
}

async function referencePrice(symbol: string): Promise<string | null> {
  const x = await getXstocksPrice(symbol).catch(() => null);
  if (x) return x.value;
  const pre = await getPrestocksPrice(symbol).catch(() => null);
  return pre?.value ?? null;
}

let samplerStarted = false;
let samplerRunning = false;

/** Background sampler for the tape set. Safe to call repeatedly (starts once). */
export function startSampler(sampleMs = 10 * 60 * 1000): void {
  if (samplerStarted) return;
  samplerStarted = true;
  const tick = async () => {
    if (samplerRunning) return; // never overlap cycles (avoids hammering upstream into a ban)
    samplerRunning = true;
    try {
      for (const symbol of SAMPLE_SYMBOLS) {
        try {
          const price = await referencePrice(symbol);
          if (price) recordPrice(symbol, price);
        } catch {
          // sampler never throws — gaps are fine, rings tolerate them
        }
        await new Promise((r) => setTimeout(r, 2000)); // gentle on upstream rate limits
      }
    } finally {
      samplerRunning = false;
    }
  };
  void tick();
  setInterval(() => void tick(), sampleMs);
}

export function samplerSymbols(): string[] {
  return [...SAMPLE_SYMBOLS];
}
