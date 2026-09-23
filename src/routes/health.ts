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
      const headers: Record<string, string> = { 'user-agent': 'Umbra-backend/0.1.0 (Stocklana-hackathon)' };
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

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', service: 'umbra-backend', time: new Date().toISOString() }));

  app.get('/health/providers', async () => {
    const [xstocks, solana, jupiter, zeroex] = await Promise.all([
      checkXstocks(),
      checkSolana(),
      checkJupiter(),
      checkZeroEx(),
    ]);
    const allOk =
      xstocks === 'ok' && solana === 'ok' && jupiter === 'ok' && (zeroex === 'ok' || zeroex === 'disabled');
    return {
      status: allOk ? 'ok' : 'degraded',
      providers: { xstocks, jupiter, solana, zeroex },
    };
  });
}
