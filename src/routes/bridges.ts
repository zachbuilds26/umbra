import type { FastifyInstance } from 'fastify';
import { bridgeQuoteBody, bridgeTransactionBody } from '../schemas/index.js';
import { getBridgeRoutes } from '../services/bridge/bridge-config.service.js';
import { buildBridgeQuote, buildBridgeTransaction } from '../services/bridge/bridge-transaction.service.js';
import { createTransaction, getTransaction, updateTransaction } from '../db/transactions.store.js';
import { notFound, badRequest } from '../utils/errors.js';
import { z } from 'zod';

export async function bridgeRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/bridge/routes — Solana destination only, from the live public config
  app.get('/api/bridge/routes', async () => getBridgeRoutes());

  // POST /api/bridge/quote { sourceNetwork, asset, amount, destinationNetwork, destinationAddress }
  app.post('/api/bridge/quote', async (req) => {
    const body = bridgeQuoteBody.parse(req.body);
    return buildBridgeQuote(body);
  });

  // POST /api/bridge/transaction { bridgeQuoteId, sourceWalletAddress, destinationSolanaAddress }
  app.post('/api/bridge/transaction', async (req) => {
    const body = bridgeTransactionBody.parse(req.body);
    const payload = await buildBridgeTransaction(body);

    const tracking = await createTransaction({
      type: 'bridge',
      status: 'source_pending',
      sourceNetwork: payload.sourceNetwork,
      destinationNetwork: 'Solana',
      sourceAsset: payload.asset,
      destinationAsset: payload.asset,
      sourceAmount: payload.amount,
      destinationAmount: null,
      sourceWallet: body.sourceWalletAddress,
      destinationWallet: body.destinationSolanaAddress,
      providerReference: payload.bridgeQuoteId,
      sourceTxHash: null,
      destinationTxHash: null,
      ccipMessageId: null,
      signature: null,
      errorCode: null,
      errorMessage: null,
    });

    return { ...payload, trackingId: tracking.id };
  });

  // GET /api/bridge/transactions/:id — bridge status (source_pending → … → completed/failed)
  app.get('/api/bridge/transactions/:id', async (req) => {
    const params = z.object({ id: z.string().min(1) }).parse(req.params);
    const tx = await getTransaction(params.id);
    if (!tx || tx.type !== 'bridge') throw notFound('NOT_FOUND', `Bridge transaction ${params.id} not found.`);
    return { transaction: tx };
  });

  // POST /api/bridge/transactions/:id/source { sourceTxHash, ccipMessageId? } — record source confirmation
  app.post('/api/bridge/transactions/:id/source', async (req) => {
    const params = z.object({ id: z.string().min(1) }).parse(req.params);
    const body = z
      .object({ sourceTxHash: z.string().min(1), ccipMessageId: z.string().optional() })
      .parse(req.body);
    const tx = await getTransaction(params.id);
    if (!tx || tx.type !== 'bridge') throw notFound('NOT_FOUND', `Bridge transaction ${params.id} not found.`);
    const updated = await updateTransaction(params.id, {
      sourceTxHash: body.sourceTxHash,
      ccipMessageId: body.ccipMessageId ?? null,
      status: body.ccipMessageId ? 'ccip_in_flight' : 'source_confirmed',
    });
    if (!updated) throw badRequest('TRANSACTION_FAILED', 'Could not update bridge transaction.');
    return { transaction: updated };
  });
}
