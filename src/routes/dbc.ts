import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DBC_QUOTE_MINT,
  EQUITY_PRESETS,
  describePreset,
} from '../services/meteora/dbc-presets.js';
import {
  buildDbcCreateConfigTransaction,
  buildDbcCreatePoolTransaction,
  buildDbcSwapTransaction,
  broadcastDbcTransaction,
  getDbcPoolByMint,
  getDbcQuote,
} from '../services/meteora/dbc.service.js';
import {
  dbcBroadcastBody,
  dbcCreateConfigBody,
  dbcCreatePoolBody,
  dbcQuoteQuery,
  dbcSwapBody,
  solanaAddress,
} from '../schemas/index.js';
import { badRequest } from '../utils/errors.js';
import { isValidSolanaAddress, isValidSolanaPublicKey } from '../utils/addresses.js';

// solanaAddress (schemas) constrains length only — base58/curve-invalid values
// would otherwise throw raw Errors inside `new PublicKey()` (-> 500). Reject
// them here as 400 before any service call. Pool addresses are program-derived
// and off-curve, so they get format validation, not signer validation.
function requireAddress(value: string, field: string): void {
  if (!isValidSolanaAddress(value)) {
    throw badRequest('INVALID_ADDRESS', `${field} is not a valid Solana address.`);
  }
}

function requireAccount(value: string, field: string): void {
  if (!isValidSolanaPublicKey(value)) {
    throw badRequest('INVALID_ADDRESS', `${field} is not a valid Solana address.`);
  }
}

// Meteora DBC launchpad: equity-tuned bonding-curve launches (the primitive
// Jupiter can't cover — Jupiter routes existing liquidity, DBC bootstraps it
// for newly tokenized / thinly-traded names), plus pool reads, quotes and
// unsigned transactions. No custody anywhere: every transaction is returned
// base64-unsigned for the user's wallet to sign.
export async function dbcRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/dbc/presets — equity launch presets with real curve economics
  // (start price + graduation threshold computed from the assembled curve).
  app.get('/api/dbc/presets', async () => {
    return { presets: EQUITY_PRESETS.map((p) => describePreset(p.id)), quoteMint: DBC_QUOTE_MINT };
  });

  // GET /api/dbc/pools?baseMint= — pool state, or pool:null for unlaunched names.
  app.get('/api/dbc/pools', async (req) => {
    const q = z.object({ baseMint: solanaAddress }).parse(req.query);
    requireAddress(q.baseMint, 'baseMint');
    const pool = await getDbcPoolByMint(q.baseMint);
    if (!pool) return { pool: null, hint: 'No DBC pool on this mint yet — pick a preset and launch one.' };
    return { pool };
  });

  // GET /api/dbc/quote?pool=&side=buy|sell&amount=&slippageBps= — live curve quote.
  app.get(
    '/api/dbc/quote',
    { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } },
    async (req) => {
      const q = dbcQuoteQuery.parse(req.query);
      requireAccount(q.pool, 'pool');
      return { quote: await getDbcQuote(q.pool, q.side, q.amount, q.slippageBps) };
    },
  );

  // POST /api/dbc/broadcast { transaction, userPublicKey } — submit a curve swap
  // the wallet signed. Same relay rule as /api/swap/broadcast: we verify the
  // fee payer is the connected wallet, then send it over our own RPC.
  app.post(
    '/api/dbc/broadcast',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const b = dbcBroadcastBody.parse(req.body);
      requireAddress(b.userPublicKey, 'userPublicKey');
      return broadcastDbcTransaction(b.transaction, b.userPublicKey);
    },
  );

  // POST /api/dbc/transaction — unsigned exact-in swap against a pool.
  app.post(
    '/api/dbc/transaction',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const b = dbcSwapBody.parse(req.body);
      requireAccount(b.pool, 'pool');
      requireAddress(b.userPublicKey, 'userPublicKey');
      const { transaction, quote } = await buildDbcSwapTransaction(b.pool, b.side, b.amount, b.userPublicKey, b.slippageBps);
      return { transaction, quote };
    },
  );

  // POST /api/dbc/config/transaction — unsigned createConfig for a preset.
  // `config` must be a fresh keypair pubkey the caller generated; it signs
  // alongside the wallet (backend never sees the secret).
  app.post(
    '/api/dbc/config/transaction',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const b = dbcCreateConfigBody.parse(req.body);
      requireAddress(b.config, 'config');
      requireAddress(b.feeClaimer, 'feeClaimer');
      requireAddress(b.leftoverReceiver, 'leftoverReceiver');
      requireAddress(b.payer, 'payer');
      try {
        return await buildDbcCreateConfigTransaction(b.preset, b.config, b.feeClaimer, b.leftoverReceiver, b.payer);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('Unknown DBC preset')) {
          throw badRequest('VALIDATION_ERROR', e.message);
        }
        throw e;
      }
    },
  );

  // POST /api/dbc/pool/transaction — unsigned createPool from a live config.
  app.post(
    '/api/dbc/pool/transaction',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const b = dbcCreatePoolBody.parse(req.body);
      requireAddress(b.config, 'config');
      requireAddress(b.baseMint, 'baseMint');
      requireAddress(b.payer, 'payer');
      if (b.poolCreator) requireAddress(b.poolCreator, 'poolCreator');
      return buildDbcCreatePoolTransaction(b.config, b.baseMint, b.name, b.symbol, b.uri, b.payer, b.poolCreator);
    },
  );
}

