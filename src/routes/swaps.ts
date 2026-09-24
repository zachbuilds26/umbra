import type { FastifyInstance } from 'fastify';
import { swapQuoteQuery, swapTransactionBody, swapSubmitBody, swapBroadcastBody, transactionsQuery } from '../schemas/index.js';
import { buildSwapQuote, getSwapTransaction, broadcastSignedSwap } from '../services/jupiter/quote.service.js';
import { quoteStore } from '../services/quotes.store.js';
import { createTransaction, getTransaction, updateTransaction, listTransactions } from '../db/transactions.store.js';
import { confirmSignature } from '../services/solana/connection.js';
import { badRequest, notFound } from '../utils/errors.js';

const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{87,88}$/;

export async function swapRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/swap/quote?sell=USDC&buy=NVDAx&amount=500[&userPublicKey=...][&slippageBps=50]
  app.get(
    '/api/swap/quote',
    { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } },
    async (req) => {
    const q = swapQuoteQuery.parse(req.query);
    // Support both domain-level (sell/buy/amount) and mint-level (inputMint/outputMint) requests.
    const sell = q.sell;
    const buy = q.buy;
    const amount = q.amount;
    if (!sell || !buy || !amount) {
      throw badRequest('VALIDATION_ERROR', 'Query must include sell, buy and amount (e.g. ?sell=USDC&buy=NVDAx&amount=500).');
    }
    return buildSwapQuote({
      sell,
      buy,
      amount,
      userPublicKey: q.userPublicKey,
      slippageBps: q.slippageBps,
    });
  });

  // POST /api/swap/transaction { quoteId, userPublicKey } -> unsigned tx for the wallet to sign
  app.post(
    '/api/swap/transaction',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const body = swapTransactionBody.parse(req.body);
      return getSwapTransaction(body.quoteId, body.userPublicKey);
    },
  );

  // POST /api/swap/broadcast { quoteId, userPublicKey, signedTransaction } -> send it
  // The wallet signs; we broadcast over our own RPC. A signed-but-unsent swap can
  // never confirm, so this runs before anything is written to the ledger.
  app.post(
    '/api/swap/broadcast',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const body = swapBroadcastBody.parse(req.body);
      return broadcastSignedSwap(body.quoteId, body.signedTransaction, body.userPublicKey);
    },
  );

  // POST /api/transactions/swap { quoteId, signature, wallet } -> record + confirm
  app.post(
    '/api/transactions/swap',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
    const body = swapSubmitBody.parse(req.body);
    const stored = quoteStore.getSwap(body.quoteId);
    if (!stored) {
      throw badRequest('QUOTE_EXPIRED', 'Quote not found or expired. Request a fresh quote.', {
        quoteId: body.quoteId,
      });
    }
    if (!SIGNATURE_RE.test(body.signature)) {
      throw badRequest('VALIDATION_ERROR', 'Signature is not a valid Solana transaction signature.');
    }
    if (stored.signature && stored.signature !== body.signature) {
      throw badRequest('VALIDATION_ERROR', 'That is not the signature broadcast for this quote.');
    }

    const tx = await createTransaction({
      type: 'swap',
      status: 'submitted',
      sourceNetwork: 'Solana',
      destinationNetwork: 'Solana',
      sourceAsset: stored.sellSymbol,
      destinationAsset: stored.buySymbol,
      sourceAmount: stored.sellAmountDisplay,
      destinationAmount: stored.receiveAmountDisplay,
      sourceWallet: body.wallet,
      destinationWallet: stored.taker ?? body.wallet,
      providerReference: stored.jupiterRequestId ?? undefined,
      sourceTxHash: null,
      destinationTxHash: null,
      ccipMessageId: null,
      signature: body.signature,
      errorCode: null,
      errorMessage: null,
    });

    // Confirm in the background; the GET endpoint reports the final status.
    void confirmSignature(body.signature, 60_000)
      .then((result) => {
        void updateTransaction(tx.id, {
          status: result === 'confirmed' ? 'confirmed' : result === 'failed' ? 'failed' : 'expired',
        }).catch(() => undefined);
      })
      .catch(() => {
        void updateTransaction(tx.id, { status: 'expired' }).catch(() => undefined);
      });

    return { id: tx.id, signature: body.signature, status: 'submitted', type: 'swap' };
  });

  // GET /api/transactions?wallet=...&limit=20 — the caller's own ledger only.
  app.get('/api/transactions', async (req) => {
    const q = transactionsQuery.parse(req.query);
    return { transactions: await listTransactions(q.limit, q.wallet) };
  });

  // GET /api/transactions/:id?wallet=... — status for the caller's own swap.
  app.get('/api/transactions/:id', async (req) => {
    const params = req.params as { id: string };
    const q = transactionsQuery.pick({ wallet: true }).parse(req.query);
    const tx = await getTransaction(params.id, q.wallet);
    if (!tx) throw notFound('NOT_FOUND', `Transaction ${params.id} not found.`);
    // A row stuck in "submitted" (restart, killed worker) gets reconciled here
    // instead of waiting for a confirmation loop that no longer exists.
    if (tx.status === 'submitted' && tx.signature) {
      const result = await confirmSignature(tx.signature, 0);
      if (result === 'confirmed' || result === 'failed') {
        return {
          transaction: (await updateTransaction(tx.id, {
            status: result,
          }, q.wallet)) ?? tx,
        };
      }
    }
    return { transaction: tx };
  });
}
