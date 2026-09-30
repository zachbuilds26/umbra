import 'dotenv/config';
import { z } from 'zod';

// Provider base URLs carry API keys in their headers, so plaintext HTTP would
// send those credentials in the clear. `z.string().url()` happily accepts
// http:// and any host, which is how a typo could downgrade a key-bearing call.
const httpsUrl = z
  .string()
  .url()
  .refine((v) => new URL(v).protocol === 'https:', { message: 'must use https' });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3002),

  SOLANA_RPC_URL: httpsUrl.default('https://api.mainnet-beta.solana.com'),
  SOLANA_COMMITMENT: z.enum(['processed', 'confirmed', 'finalized']).default('confirmed'),

  JUPITER_API_KEY: z.string().optional().default(''),
  JUPITER_BASE_URL: httpsUrl.default('https://api.jup.ag/swap/v2'),
  JUPITER_PRICE_URL: httpsUrl.default('https://api.jup.ag/price/v3'),

  // Tokens Assets API (Solana market data) — key from https://app.tokens.xyz;
  // empty = Tokens leg disabled, everything else works.
  TOKENS_API_KEY: z.string().optional().default(''),
  TOKENS_BASE_URL: httpsUrl.default('https://api.tokens.xyz/v1'),

  // 0x Swap API (Solana, open beta) — quoter #2 behind Jupiter. Free key from
  // https://dashboard.0x.org; empty = 0x leg disabled, everything else works.
  ZEROEX_API_KEY: z.string().optional().default(''),
  ZEROEX_BASE_URL: httpsUrl.default('https://api.0x.org'),

  XSTOCKS_API_BASE_URL: httpsUrl.default('https://api.xstocks.fi/api/v2'),

  DATABASE_URL: z.string().optional().default(''),

  CORS_ORIGINS: z.string().default('http://localhost:3000'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

const isProd = parsed.data.NODE_ENV === 'production';
const corsOrigins = parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

// A wildcard entry silently disables the allowlist: @fastify/cors treats any
// list containing "*" as "reflect every origin". That is fine for a local
// experiment and never acceptable for a deployed wallet application.
if (isProd && corsOrigins.some((o) => o === '*' || o.includes('*'))) {
  throw new Error('CORS_ORIGINS must list exact origins in production; wildcards are rejected');
}

export const env = {
  ...parsed.data,
  corsOrigins,
  isProd,
  // node:test sets NODE_TEST_CONTEXT in its child processes. Detecting it here
  // means `npm test` is safe on any shell (no NODE_ENV= prefix required) and can
  // never reach a real database or provider account.
  isTest: parsed.data.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT),
};
