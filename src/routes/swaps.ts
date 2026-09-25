import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { swapQuoteQuery, swapTransactionBody, swapSubmitBody, swapBroadcastBody, transactionsQuery, transactionId } from '../schemas/index.js';
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

  // POST /api/swap/broadcast { quoteId, userPublicKey, signedTransaction | signature }
  // The wallet signs; we broadcast over our own RPC. A signed-but-unsent swap can
  // never confirm, so this runs before anything is written to the ledger. A
  // wallet that broadcasts internally sends only the signature, which we verify
  // against the quote by fetching the transaction from the chain.
  app.post(
    '/api/swap/broadcast',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const body = swapBroadcastBody.parse(req.body);
      return broadcastSignedSwap(
        body.quoteId,
        { signedTransaction: body.signedTransaction, signature: body.signature },
        body.userPublicKey,
      );
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
    // The ledger row must belong to the wallet the quote was built for, and the
    // signature must be the one this backend actually broadcast. Without both
    // checks any caller could attach an invented signature to a live quote, and
    // one quote could end up with several rows.
    if (!stored.taker) {
      throw badRequest('QUOTE_EXPIRED', 'This quote has no wallet bound to it yet. Request a fresh quote.');
    }
    if (stored.taker !== body.wallet) {
      throw badRequest('VALIDATION_ERROR', 'This quote belongs to a different wallet.');
    }
    if (!stored.signature) {
      throw badRequest(
        'VALIDATION_ERROR',
        'The swap was not submitted by Umbra. Retry the swap so it can be sent and recorded.',
      );
    }
    if (stored.signature !== body.signature) {
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
      sourceWallet: stored.taker,
      destinationWallet: stored.taker,
      providerReference: stored.jupiterRequestId ?? undefined,
      sourceTxHash: null,
      destinationTxHash: null,
      ccipMessageId: null,
      signature: body.signature,
      errorCode: null,
      errorMessage: null,
    });

    // Confirm in the background; the GET endpoint reports the final status. A
    // timeout is not a failure: the row stays `submitted` so a later check can
    // still resolve it, instead of being written off as expired.
    void confirmSignature(body.signature, 60_000)
      .then((result) => {
        if (result === 'indeterminate') return;
        void updateTransaction(tx.id, {
          status: result === 'confirmed' ? 'confirmed' : 'failed',
        }).catch(() => undefined);
      })
      .catch(() => {
        // Never downgrade the row on an internal error.
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
    const params = z.object({ id: transactionId }).parse(req.params);
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
