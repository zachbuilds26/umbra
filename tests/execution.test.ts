import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { quoteStore } from '../src/services/quotes.store.js';
import { broadcastSignedSwap, computePriceImpactBps } from '../src/services/jupiter/quote.service.js';
import { createTransaction, updateTransaction, getTransaction } from '../src/db/transactions.store.js';
import type { StoredSwapQuote } from '../src/services/quotes.store.js';

const WALLET_A = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const WALLET_B = 'HkvpFqa3WngHoQcfLttAX4am7Ng8vezF6EEGRSbMsRj9';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ANTHROPIC = 'Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw';
const BLOCKHASH = '11111111111111111111111111111111';

function unsignedTxB64(recipient: PublicKey, lamports: number, owner = new PublicKey(WALLET_A)): string {
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: BLOCKHASH,
    instructions: [SystemProgram.transfer({ fromPubkey: owner, toPubkey: recipient, lamports })],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}

function signAll(txB64: string, signers: Keypair[]): string {
  const vtx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
  vtx.sign(signers);
  return Buffer.from(vtx.serialize()).toString('base64');
}

function putQuote(overrides: Partial<StoredSwapQuote> = {}): string {
  const quoteId = `test_quote_${Math.random().toString(36).slice(2)}`;
  quoteStore.putSwap({
    quoteId,
    sellSymbol: 'USDC',
    buySymbol: 'ANTHROPIC',
    sellAmountDisplay: '10',
    inputMint: USDC,
    outputMint: ANTHROPIC,
    amountBaseUnits: '10000000',
    taker: WALLET_A,
    slippageBps: 50,
    jupiterRequestId: 'req-1',
    transaction: unsignedTxB64(new PublicKey(ANTHROPIC), 1),
    receiveAmountDisplay: '0.0095',
    outBaseUnits: '9500000',
    routeVenue: 'metis',
    priceImpactPct: null,
    signature: null,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  });
  return quoteId;
}

describe('quote ownership cannot change hands', () => {
  it('claims an unbound quote for exactly one wallet', () => {
    const quoteId = putQuote({ taker: null });
    assert.equal(quoteStore.claimSwapTaker(quoteId, WALLET_A), 'claimed');
    assert.equal(quoteStore.claimSwapTaker(quoteId, WALLET_B), 'taken');
    assert.equal(quoteStore.claimSwapTaker(quoteId, WALLET_A), 'owned');
  });

  it('refuses to bind a transaction to a wallet that does not own the quote', () => {
    const quoteId = putQuote({ taker: WALLET_A });
    const tx = unsignedTxB64(new PublicKey(ANTHROPIC), 2, new PublicKey(WALLET_A));
    assert.equal(quoteStore.bindSwapTransaction(quoteId, WALLET_B, { transaction: tx }), undefined);
    assert.notEqual(quoteStore.bindSwapTransaction(quoteId, WALLET_A, { transaction: tx }), undefined);
  });
});

describe('broadcast only accepts this quote\'s own transaction', () => {
  it('rejects a correctly signed transaction that swaps something else', async () => {
    // A different message (pays a different destination) signed by the very
    // wallet the quote belongs to. This is the transaction-relay abuse the
    // message comparison exists to stop.
    const quoteId = putQuote();
    const kp = Keypair.generate();
    const foreign = signAll(unsignedTxB64(new PublicKey(WALLET_B), 5_000_000, kp.publicKey), [kp]);
    quoteStore.putSwap({
      ...(quoteStore.getSwap(quoteId) as StoredSwapQuote),
      taker: kp.publicKey.toBase58(),
    });
    await assert.rejects(
      () => broadcastSignedSwap(quoteId, { signedTransaction: foreign }, kp.publicKey.toBase58()),
      /does not match the transaction for this quote/,
    );
  });

  it('rejects a partially signed transaction', async () => {
    const kp = Keypair.generate();
    // Same message as the quote's own transaction, but nobody signed it.
    const unsigned = unsignedTxB64(new PublicKey(ANTHROPIC), 1, kp.publicKey);
    const quoteId = putQuote({ taker: kp.publicKey.toBase58(), transaction: unsigned });
    await assert.rejects(
      () => broadcastSignedSwap(quoteId, { signedTransaction: unsigned }, kp.publicKey.toBase58()),
      /not fully signed/,
    );
  });

  it('rejects a signature recorded against a quote bound to another wallet', async () => {
    const quoteId = putQuote({ taker: WALLET_A });
    const kp = Keypair.generate();
    await assert.rejects(
      () => broadcastSignedSwap(quoteId, { signature: 'A'.repeat(88) }, WALLET_B),
      /different wallet/,
    );
  });

  it('rejects a quote that has no transaction yet', async () => {
    const kp = Keypair.generate();
    const quoteId = putQuote({ taker: kp.publicKey.toBase58(), transaction: null });
    await assert.rejects(
      () => broadcastSignedSwap(
        quoteId,
        { signedTransaction: unsignedTxB64(new PublicKey(ANTHROPIC), 1, kp.publicKey) },
        kp.publicKey.toBase58(),
      ),
      /no transaction to sign/,
    );
  });

  it('requires either signed bytes or a signature, never neither or both', async () => {
    const kp = Keypair.generate();
    const quoteId = putQuote({ taker: kp.publicKey.toBase58() });
    await assert.rejects(
      () => broadcastSignedSwap(quoteId, {}, kp.publicKey.toBase58()),
      /either the signed transaction or its signature/,
    );
    await assert.rejects(
      () => broadcastSignedSwap(
        quoteId,
        { signedTransaction: unsignedTxB64(new PublicKey(ANTHROPIC), 1, kp.publicKey), signature: 'A'.repeat(88) },
        kp.publicKey.toBase58(),
      ),
      /either the signed transaction or its signature/,
    );
  });

  it('refuses a self-broadcast signature that is not on chain', async () => {
    // The wallet claims it already broadcast. Until that transaction is visible
    // on Solana there is nothing to verify against the quote.
    const kp = Keypair.generate();
    const quoteId = putQuote({ taker: kp.publicKey.toBase58() });
    await assert.rejects(
      () => broadcastSignedSwap(quoteId, { signature: '4'.repeat(88) }, kp.publicKey.toBase58()),
      /not visible on Solana|not the transaction for this quote/,
    );
  });
});

describe('jupiterz routes land through /execute, not our RPC', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubExecute(reply: unknown, status = 200): void {
    globalThis.fetch = (async () => ({
      status,
      ok: status >= 200 && status < 300,
      text: async () => JSON.stringify(reply),
    })) as typeof fetch;
  }

  // A message with two required signers (taker + market maker), like a real
  // JupiterZ order. The wallet can only ever fill the first slot.
  function jupiterzUnsigned(payer: PublicKey, marketMaker: PublicKey): string {
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: BLOCKHASH,
      instructions: [
        new TransactionInstruction({
          keys: [{ pubkey: marketMaker, isSigner: true, isWritable: false }],
          programId: SystemProgram.programId,
          data: Buffer.alloc(0),
        }),
      ],
    }).compileToV0Message();
    assert.equal(message.header.numRequiredSignatures, 2);
    return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
  }

  it('accepts the taker signature alone and lands via /execute', async () => {
    const payer = Keypair.generate();
    const unsigned = jupiterzUnsigned(payer.publicKey, Keypair.generate().publicKey);
    const vtx = VersionedTransaction.deserialize(Buffer.from(unsigned, 'base64'));
    vtx.sign([payer]);
    const expectedSig = bs58.encode(Buffer.from(vtx.signatures[0] as Uint8Array));
    stubExecute({ status: 'Success', signature: expectedSig, code: 0 });
    const quoteId = putQuote({
      taker: payer.publicKey.toBase58(),
      transaction: unsigned,
      routeVenue: 'jupiterz',
      jupiterRequestId: 'req-jup',
    });
    const out = await broadcastSignedSwap(
      quoteId,
      { signedTransaction: Buffer.from(vtx.serialize()).toString('base64') },
      payer.publicKey.toBase58(),
    );
    assert.equal(out.signature, expectedSig);
    assert.equal(quoteStore.getSwap(quoteId)?.signature, expectedSig);
  });

  it('still rejects a jupiterz transaction the wallet did not sign', async () => {
    const payer = Keypair.generate();
    const unsigned = jupiterzUnsigned(payer.publicKey, Keypair.generate().publicKey);
    const quoteId = putQuote({
      taker: payer.publicKey.toBase58(),
      transaction: unsigned,
      routeVenue: 'jupiterz',
    });
    await assert.rejects(
      () => broadcastSignedSwap(quoteId, { signedTransaction: unsigned }, payer.publicKey.toBase58()),
      /did not sign/,
    );
  });

  it('reports an /execute failure without filing a signature', async () => {
    const payer = Keypair.generate();
    const unsigned = jupiterzUnsigned(payer.publicKey, Keypair.generate().publicKey);
    const vtx = VersionedTransaction.deserialize(Buffer.from(unsigned, 'base64'));
    vtx.sign([payer]);
    stubExecute({ status: 'Failed', code: -1003, error: 'Transaction not fully signed' });
    const quoteId = putQuote({
      taker: payer.publicKey.toBase58(),
      transaction: unsigned,
      routeVenue: 'jupiterz',
      jupiterRequestId: 'req-jup',
    });
    await assert.rejects(
      () =>
        broadcastSignedSwap(
          quoteId,
          { signedTransaction: Buffer.from(vtx.serialize()).toString('base64') },
          payer.publicKey.toBase58(),
        ),
      /could not land/,
    );
    assert.equal(quoteStore.getSwap(quoteId)?.signature, null);
  });

  it('keeps aggregator routes on our own RPC path', async () => {
    // routeVenue metis with an unsigned tx must fail exactly as before —
    // the jupiterz exception must not leak into the default path.
    const kp = Keypair.generate();
    const unsigned = unsignedTxB64(new PublicKey(ANTHROPIC), 1, kp.publicKey);
    const quoteId = putQuote({ taker: kp.publicKey.toBase58(), transaction: unsigned, routeVenue: 'metis' });
    await assert.rejects(
      () => broadcastSignedSwap(quoteId, { signedTransaction: unsigned }, kp.publicKey.toBase58()),
      /not fully signed/,
    );
  });
});

describe('price impact is reported in real basis points', () => {
  it('reads the current percentage-point field', () => {
    assert.equal(computePriceImpactBps({ priceImpact: 1.5 }), 150);
    assert.equal(computePriceImpactBps({ priceImpact: '0.25' }), 25);
  });

  it('scales the deprecated ratio field correctly', () => {
    // 0.015 as a ratio is 1.5%, which is 150 bps — not 1 or 2.
    assert.equal(computePriceImpactBps({ priceImpactPct: 0.015 }), 150);
    assert.equal(computePriceImpactBps({ priceImpactPct: '-0.0225' }), -225);
  });

  it('agrees with Jupiter on a real order, in both fields', () => {
    // Captured from a live Jupiter /order for USDC -> ANTHROPIC. Jupiter sends
    // the same move twice: once in percentage points, once as a ratio. Both must
    // produce the same basis points, and both are ~1.5% adverse.
    const observed = { priceImpact: -1.5179217825983593, priceImpactPct: -0.015179217825983592 };
    const fromPoints = computePriceImpactBps(observed);
    const fromRatio = computePriceImpactBps({ priceImpactPct: observed.priceImpactPct });
    assert.equal(fromPoints, fromRatio);
    assert.equal(fromPoints, -152);
  });

  it('returns null rather than inventing a number', () => {
    assert.equal(computePriceImpactBps({}), null);
    assert.equal(computePriceImpactBps({ priceImpactPct: null }), null);
    assert.equal(computePriceImpactBps({ priceImpactPct: 'nonsense' }), null);
  });
});

describe('ledger status cannot move backwards', () => {
  // A unique signature per row: the store deliberately de-duplicates by
  // signature so a retried POST cannot create a second row.
  let sigSeq = 0;
  const base = () => ({
    type: 'swap' as const,
    status: 'pending' as const,
    sourceNetwork: 'Solana',
    destinationNetwork: 'Solana',
    sourceAsset: 'USDC',
    destinationAsset: 'ANTHROPIC',
    sourceAmount: '10',
    destinationAmount: '0.0095',
    sourceWallet: WALLET_A,
    destinationWallet: WALLET_A,
    providerReference: 'req-1',
    sourceTxHash: null,
    destinationTxHash: null,
    ccipMessageId: null,
    signature: `sig-${++sigSeq}`,
    errorCode: null,
    errorMessage: null,
  });

  it('refuses to jump straight from pending to confirmed', async () => {
    const tx = await createTransaction(base());
    const after = await updateTransaction(tx.id, { status: 'confirmed' }, WALLET_A);
    assert.equal(after?.status, 'pending');
  });

  it('allows the real path and then freezes the row', async () => {
    const tx = await createTransaction(base());
    await updateTransaction(tx.id, { status: 'submitted' }, WALLET_A);
    const confirmed = await updateTransaction(tx.id, { status: 'confirmed' }, WALLET_A);
    assert.equal(confirmed?.status, 'confirmed');
    const late = await updateTransaction(tx.id, { status: 'failed' }, WALLET_A);
    assert.equal(late?.status, 'confirmed');
  });

  it('keeps bridge rows inside their own transition table', async () => {
    const tx = await createTransaction({
      ...base(),
      type: 'bridge',
      status: 'source_pending',
      sourceAsset: 'USDC',
      destinationAsset: 'USDC',
      signature: null,
    });
    const skipped = await updateTransaction(tx.id, { status: 'completed' }, WALLET_A);
    assert.equal(skipped?.status, 'source_pending');
    const moved = await updateTransaction(tx.id, { status: 'source_confirmed' }, WALLET_A);
    assert.equal(moved?.status, 'source_confirmed');
  });

  it('scopes updates to the owning wallet', async () => {
    const tx = await createTransaction(base());
    // Another wallet cannot move the row...
    const notMine = await updateTransaction(tx.id, { status: 'submitted' }, WALLET_B);
    assert.equal(notMine, undefined);
    assert.equal((await getTransaction(tx.id, WALLET_A))?.status, 'pending');
    // ...and the owner can, with the update landing exactly once.
    const mine = await updateTransaction(tx.id, { status: 'submitted' }, WALLET_A);
    assert.equal(mine?.status, 'submitted');
    assert.equal((await getTransaction(tx.id, WALLET_A))?.status, 'submitted');
  });

  it('does not let a late callback overwrite a finished transaction', async () => {
    // The in-memory path read the row with an await, so two concurrent updates
    // both saw `submitted` and both wrote: a late `failed` could land on top of
    // `confirmed`. Read and write must be synchronous in memory.
    const tx = await createTransaction(base());
    await updateTransaction(tx.id, { status: 'submitted' }, WALLET_A);
    const [confirmed, lateFail] = await Promise.all([
      updateTransaction(tx.id, { status: 'confirmed' }, WALLET_A),
      updateTransaction(tx.id, { status: 'failed' }, WALLET_A),
    ]);
    const final = await getTransaction(tx.id, WALLET_A);
    // Whichever order they landed in, the row must end up terminal and stable —
    // never flip back to a non-terminal state afterwards.
    assert.ok(final?.status === 'confirmed' || final?.status === 'failed');
    const after = await updateTransaction(tx.id, { status: 'submitted' }, WALLET_A);
    assert.equal(after?.status, final?.status);
    void confirmed;
    void lateFail;
  });
});
