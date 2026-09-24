import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3002),

  SOLANA_RPC_URL: z.string().url().default('https://api.mainnet-beta.solana.com'),
  SOLANA_COMMITMENT: z.enum(['processed', 'confirmed', 'finalized']).default('confirmed'),

  JUPITER_API_KEY: z.string().optional().default(''),
  JUPITER_BASE_URL: z.string().url().default('https://api.jup.ag/swap/v2'),
  JUPITER_PRICE_URL: z.string().url().default('https://api.jup.ag/price/v3'),

  // 0x Swap API (Solana, open beta) — quoter #2 behind Jupiter. Free key from
  // https://dashboard.0x.org; empty = 0x leg disabled, everything else works.
  ZEROEX_API_KEY: z.string().optional().default(''),
  ZEROEX_BASE_URL: z.string().url().default('https://api.0x.org'),

  XSTOCKS_API_BASE_URL: z.string().url().default('https://api.xstocks.fi/api/v2'),

  // Pyth Pro (Lazer) key — demo keys cover a limited feed set (see /v1/symbols?entitled_only=true).
  PYTH_API_KEY: z.string().optional().default(''),
  PYTH_PRO_URL: z.string().url().default('https://pyth-lazer.dourolabs.app'),
  PYTH_SYMBOLOGY_URL: z.string().url().default('https://pyth.dourolabs.app'),

  // Finnhub for xStocks marketCap (free 60/min, https://finnhub.io). Empty = mcap stays null.
  FINNHUB_API_KEY: z.string().optional().default(''),

  DATABASE_URL: z.string().optional().default(''),

  CORS_ORIGINS: z.string().default('http://localhost:3000'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  isProd: parsed.data.NODE_ENV === 'production',
};
