import type { FastifyInstance } from 'fastify';
import { xstocksClient } from '../services/xstocks/client.js';
import { getConnection } from '../services/solana/connection.js';
import { env } from '../config/env.js';

async function checkXstocks(): Promise<'ok' | 'degraded'> {
  try {
    const res = await xstocksClient.getPrice('NVDAx');
    return res.quote !== undefined ? 'ok' : 'degraded';
  } catch {
    return 'degraded';
  }
}

async function checkSolana(): Promise<'ok' | 'degraded'> {
  try {
    const conn = getConnection();
    await Promise.race([
      conn.getSlot(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    return 'ok';
  } catch {
    return 'degraded';
  }
}

async function checkJupiter(): Promise<'ok' | 'degraded'> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const headers: Record<string, string> = { 'user-agent': 'Umbra-backend/0.1.0 (Umbra)' };
      if (env.JUPITER_API_KEY) headers['x-api-key'] = env.JUPITER_API_KEY;
      const res = await fetch('https://api.jup.ag/tokens/v2/search?query=USDC', {
        headers,
        signal: controller.signal,
      });
      return res.ok ? 'ok' : 'degraded';
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return 'degraded';
  }
}

function checkZeroEx(): Promise<'ok' | 'degraded' | 'disabled'> {
  // No key = leg disabled (by design, not a failure). With a key, a cheap
  // probe quote decides ok/degraded.
  if (!env.ZEROEX_API_KEY) return Promise.resolve('disabled');
  return (async () => {
    // USDC→USDT probe (same-mint quotes are rejected by the API).
    const { getZeroExQuote } = await import('../services/zeroex/client.js');
    const { SOLANA_USDC_MINT, SOLANA_USDT_MINT } = await import('../services/xstocks/assets.service.js');
    const q = await getZeroExQuote({
      tokenIn: SOLANA_USDC_MINT,
      tokenOut: SOLANA_USDT_MINT,
      amountInBaseUnits: '1000000',
    }).catch(() => null);
    return q ? 'ok' : 'degraded';
  })().catch((): 'degraded' => 'degraded');
}

interface ProviderReport {
  status: 'ok' | 'degraded';
  providers: { xstocks: string; jupiter: string; solana: string; zeroex: string };
  checkedAt: string;
}

let providerCache: ProviderReport | null = null;
let providerProbe: Promise<ProviderReport> | null = null;
const PROVIDER_CACHE_MS = 30_000;

/**
 * One shared, cached provider probe.
 *
 * Every request used to fire four upstream calls, so a public endpoint was a
 * free amplifier against our rate-limited provider keys. Results are shared for
 * 30 seconds and concurrent callers await the same in-flight probe.
 */
async function probeProviders(): Promise<ProviderReport> {
  const now = Date.now();
  if (providerCache && now - Date.parse(providerCache.checkedAt) < PROVIDER_CACHE_MS) {
    return providerCache;
  }
  if (providerProbe) return providerProbe;
  providerProbe = (async () => {
    try {
      const [xstocks, solana, jupiter, zeroex] = await Promise.all([
        checkXstocks(),
        checkSolana(),
        checkJupiter(),
        checkZeroEx(),
      ]);
      const allOk =
        xstocks === 'ok' && solana === 'ok' && jupiter === 'ok' && (zeroex === 'ok' || zeroex === 'disabled');
      providerCache = {
        status: allOk ? 'ok' : 'degraded',
        providers: { xstocks, jupiter, solana, zeroex },
        checkedAt: new Date().toISOString(),
      };
      return providerCache;
    } finally {
      providerProbe = null;
    }
  })();
  return providerProbe;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', service: 'umbra-backend', time: new Date().toISOString() }));

  app.get('/health/providers', async () => probeProviders());
}
