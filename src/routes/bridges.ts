import type { FastifyInstance } from 'fastify';
import { bridgeQuoteBody, bridgeTransactionBody, transactionId, solanaAddress } from '../schemas/index.js';
import { getBridgeRoutes } from '../services/bridge/bridge-config.service.js';
import { buildBridgeQuote, buildBridgeTransaction } from '../services/bridge/bridge-transaction.service.js';
import { getTransaction } from '../db/transactions.store.js';
import { notFound, HttpError } from '../utils/errors.js';
import { z } from 'zod';

/**
 * The bridge is not executable yet: there is no transaction construction on the
 * source chain, so Umbra can neither send nor verify a transfer. Until that
 * exists, the write endpoints refuse rather than accept.
 *
 * They used to create a tracking row for a transfer that had not happened and
 * let any caller mark that row as source-confirmed by supplying a wallet address
 * and a hash. Both are unauthenticated writes to a financial ledger: a stranger
 * who knew a public address and a tracking id could move someone else's row to
 * "confirmed". A read-only routes endpoint remains, and the product already
 * presents the bridge as unavailable.
 */
const bridgeUnavailable = (): never => {
  throw new HttpError(
    501,
    'FEATURE_UNAVAILABLE',
    'Bridging is not available yet. Umbra cannot send or verify a cross-chain transfer, so nothing is recorded.',
  );
};

export async function bridgeRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/bridge/routes — Solana destination only, from the live public config
  app.get('/api/bridge/routes', async () => getBridgeRoutes());

  // POST /api/bridge/quote — indicative pricing only; never executable.
  app.post(
    '/api/bridge/quote',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const body = bridgeQuoteBody.parse(req.body);
      return { ...(await buildBridgeQuote(body)), executable: false };
    },
  );

  // POST /api/bridge/transaction — disabled: see bridgeUnavailable above.
  app.post(
    '/api/bridge/transaction',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      bridgeTransactionBody.parse(req.body);
      return bridgeUnavailable();
    },
  );

  // GET /api/bridge/transactions/:id?wallet=... — only the owning wallet.
  app.get('/api/bridge/transactions/:id', async (req) => {
    const params = z.object({ id: transactionId }).parse(req.params);
    const q = z.object({ wallet: solanaAddress }).parse(req.query);
    const tx = await getTransaction(params.id, q.wallet);
    if (!tx || tx.type !== 'bridge') throw notFound('NOT_FOUND', `Bridge transaction ${params.id} not found.`);
    return { transaction: tx };
  });

  // POST /api/bridge/transactions/:id/source — disabled. Recording a source
  // confirmation means asserting that a transfer happened; without verifying it
  // against the source chain, any caller could assert it for any row.
  app.post('/api/bridge/transactions/:id/source', async (req) => {
    z.object({ id: transactionId }).parse(req.params);
    return bridgeUnavailable();
  });
}
