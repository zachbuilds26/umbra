import Decimal from '../../utils/decimal.js';
import { getPrice as getXstocksPrice } from '../xstocks/assets.service.js';
import { getPrestocksPrice } from '../prestocks/assets.js';


// In-memory price history ring per symbol: [{ t, p }]. Powers the ticker tape's
// 24h change and the hover-card sparkline — no chart infra, no new providers.
// Points sampled every SAMPLER_MS for the curated set; any on-demand price fetch
// also records a point, so hovered assets self-populate.

interface PricePoint {
  /** When this price was FIRST observed — the event time, never rewritten. */
  t: number;
  /** When we last saw this price — freshness only, never a history point. */
  seen: number;
  p: string;
}

const MAX_POINTS = 1440; // 24h at 1/min
const RETENTION_MS = 25 * 60 * 60 * 1000;
/** Symbols with no fresh observation for this long are dropped entirely. */
const SYMBOL_TTL_MS = 60 * 60 * 1000;
const MAX_SYMBOLS = 500;

// Curated sampler set: majors people put on a tape + full pre-IPO shelf + stables.
// Which names the background sampler prices. Order mirrors the tape (pre-IPO
// interleaved, not grouped) so nothing in the UI implies a ranking.
const SAMPLE_SYMBOLS = [
  'NVDAx', 'SPACEX', 'AAPLx', 'OPENAI', 'TSLAx', 'ANTHROPIC', 'MSFTx', 'NEURALINK',
  'AMZNx', 'ANDURIL', 'GOOGLx', 'KALSHI', 'METAx', 'POLYMARKET', 'SPYx', 'FIGUREAI',
  'QQQx', 'TSMx', 'AVGOx', 'AMDx', 'NFLXx', 'PLTRx', 'COINx', 'HOODx', 'MSTRx', 'GLDx',
];

const rings = new Map<string, PricePoint[]>();

/** Drop symbols nothing has refreshed recently, so the map cannot grow forever. */
function sweepRings(now: number): void {
  for (const [symbol, ring] of rings) {
    const last = ring[ring.length - 1];
    // `>=` so a symbol expires exactly at the TTL, matching TtlCache. A ring
    // that survived on the boundary was never actually expired.
    if (!last || now - last.seen >= SYMBOL_TTL_MS) {
      rings.delete(symbol);
      continue;
    }
    if (ring[0] && now - ring[0].t > RETENTION_MS) {
      const cutoff = now - RETENTION_MS;
      while (ring.length > 0 && (ring[0]?.t ?? 0) < cutoff) ring.shift();
    }
  }
  while (rings.size > MAX_SYMBOLS) {
    // Evict the least recently SEEN symbol, not the first inserted. Insertion
    // order let a long-lived symbol be dropped while a just-created one stayed,
    // destroying real history.
    let oldestKey: string | null = null;
    let oldestSeen = Infinity;
    for (const [symbol, ring] of rings) {
      const seen = ring[ring.length - 1]?.seen ?? 0;
      if (seen < oldestSeen) {
        oldestSeen = seen;
        oldestKey = symbol;
      }
    }
    if (!oldestKey) break;
    rings.delete(oldestKey);
  }
}

export function recordPrice(symbol: string, price: string, at = Date.now()): void {
  const upper = symbol.toUpperCase();
  sweepRings(at);
  let ring = rings.get(upper);
  if (!ring) {
    ring = [];
    rings.set(upper, ring);
  }
  const last = ring[ring.length - 1];
  if (last && last.p === price) {
    // Same price, so no new history point — but the event time must stay put.
    // Rewriting it made the 24h baseline slide forward with every poll, so a
    // move that happened seconds ago was reported as a 24-hour change.
    last.seen = at;
    return;
  }
  // No synthetic 24h-old point: a price we never observed is not history, and
  // seeding one made the first real move read as a 24-hour change.
  ring.push({ t: at, seen: at, p: price });
  const cutoff = at - RETENTION_MS;
  while (ring.length > 0 && (ring[0]?.t ?? 0) < cutoff) ring.shift();
  while (ring.length > MAX_POINTS) ring.shift();
}

/**
 * % change over the window, from the oldest observation inside it to the newest.
 *
 * The baseline is always a point inside the window: a price we last saw before
 * the window opened is not evidence about this window. With only one observation
 * inside it we cannot prove any movement, so the answer is null rather than a
 * fabricated 0.00%.
 */
export function changePct(symbol: string, windowMs = 24 * 60 * 60 * 1000, now = Date.now()): number | null {
  const ring = rings.get(symbol.toUpperCase()) ?? [];
  if (ring.length === 0) return null;
  const cutoff = now - windowMs;
  // A point dated in the future is not an observation we can reason about — it
  // comes from a clock skew or a bad upstream timestamp. Ignoring it stops a
  // future point from being read as the "oldest" price and inventing a swing.
  const inWindow = ring.filter((pt) => pt.t >= cutoff && pt.t <= now);
  if (inWindow.length < 2) return null;
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  if (!first || !last) return null;
  // Two different prices observed at the same instant tell us nothing about a
  // change over time, so this is unknown rather than 0%.
  if (first.t === last.t) return null;
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
