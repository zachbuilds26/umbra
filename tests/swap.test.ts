import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { buildSwapQuote, assertStockStablePair, withNativeSol } from '../src/services/jupiter/quote.service.js';
import { canonicalSymbol } from '../src/services/xstocks/assets.service.js';

// Offline rejection paths. Live quote paths (USDC↔NVDAx) run against the real
// Jupiter API in demo (Phase 8), not in unit tests.

describe('swap validation (offline rules)', () => {
  it('rejects same-asset swaps', async () => {
    await assert.rejects(() => buildSwapQuote({ sell: 'USDC', buy: 'USDC', amount: '10' }), /must differ/);
  });

  it('rejects non-positive amounts', async () => {
    await assert.rejects(() => buildSwapQuote({ sell: 'USDC', buy: 'NVDAx', amount: '0' }), /greater than zero/);
  });

  it('rejects unsupported assets before any provider call', async () => {
    await assert.rejects(
      () => buildSwapQuote({ sell: 'DOGE', buy: 'NVDAx', amount: '10' }),
      /tokenized stock and USDC, USDT or SOL/,
    );
  });

  it('rejects base-to-base pairs (SOL into USDC)', async () => {
    await assert.rejects(
      () => buildSwapQuote({ sell: 'SOL', buy: 'USDC', amount: '1' }),
      /tokenized stock and USDC, USDT or SOL/,
    );
  });

  it('rejects malformed taker addresses', async () => {
    await assert.rejects(
      () => buildSwapQuote({ sell: 'USDC', buy: 'NVDAx', amount: '10', userPublicKey: 'nope' }),
      /not a valid Solana address/,
    );
  });

  it('rejects stock-to-stock pairs (one stock, one base asset)', async () => {
    await assert.rejects(
      () => buildSwapQuote({ sell: 'NVDAx', buy: 'AAPLx', amount: '1' }),
      /only supported between a tokenized stock and USDC, USDT or SOL/,
    );
  });

  it('rejects stable-to-stable pairs', async () => {
    await assert.rejects(
      () => buildSwapQuote({ sell: 'USDC', buy: 'USDT', amount: '10' }),
      /only supported between a tokenized stock and USDC, USDT or SOL/,
    );
  });
});

describe('stock↔base pair rules', () => {
  const PRE = new Set(['SPACEX', 'OPENAI', 'ANTHROPIC', 'KALSHI', 'NEURALINK', 'ANDURIL', 'FIGUREAI', 'POLYMARKET']);

  it('accepts both directions with canonical symbols', () => {
    assert.deepEqual(assertStockStablePair('USDC', 'NVDAx'), { stock: 'NVDAx', stable: 'USDC' });
    assert.deepEqual(assertStockStablePair('NVDAx', 'usdt'), { stock: 'NVDAx', stable: 'USDT' });
  });

  it('accepts pre-IPO stocks against stables either way', () => {
    assert.deepEqual(assertStockStablePair('USDC', 'SPACEX', PRE), { stock: 'SPACEX', stable: 'USDC' });
    assert.deepEqual(assertStockStablePair('openai', 'USDT', PRE), { stock: 'OPENAI', stable: 'USDT' });
  });

  it('accepts SOL against a stock in both directions', () => {
    assert.deepEqual(assertStockStablePair('SOL', 'NVDAx'), { stock: 'NVDAx', stable: 'SOL' });
    assert.deepEqual(assertStockStablePair('AAPLx', 'sol'), { stock: 'AAPLx', stable: 'SOL' });
    assert.deepEqual(assertStockStablePair('SOL', 'OPENAI', PRE), { stock: 'OPENAI', stable: 'SOL' });
  });

  it('rejects base-to-base pairs (SOL↔USDC)', () => {
    assert.throws(
      () => assertStockStablePair('SOL', 'USDC'),
      /only supported between a tokenized stock and USDC, USDT or SOL/,
    );
  });

  it('rejects listed-stock to pre-IPO pairs (both are stocks)', async () => {
    await assert.rejects(
      () => buildSwapQuote({ sell: 'NVDAx', buy: 'SPACEX', amount: '1' }),
      /only supported between a tokenized stock and USDC, USDT or SOL/,
    );
  });

  it('canonicalizes stables case-insensitively', () => {
    assert.equal(canonicalSymbol('usdt'), 'USDT');
    assert.equal(canonicalSymbol('UsDc'), 'USDC');
    assert.equal(canonicalSymbol('nvdaX'), 'NVDAx');
  });
});

describe('native SOL wrapping around Jupiter transactions', () => {
  const WALLET = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
  const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
  const WSOL_ATA = getAssociatedTokenAddressSync(WSOL, new PublicKey(WALLET), true);
  const STOCK_MINT = new PublicKey('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh');
  const BLOCKHASH = '11111111111111111111111111111111';

  // A stand-in for one of Jupiter's own swaps: a single token-program
  // instruction, which is what Jupiter's router compiles down to.
  function jupiterTxB64(): string {
    const message = new TransactionMessage({
      payerKey: new PublicKey(WALLET),
      recentBlockhash: BLOCKHASH,
      instructions: [
        new TransactionInstruction({
          keys: [
            { pubkey: WSOL_ATA, isSigner: false, isWritable: true },
            { pubkey: STOCK_MINT, isSigner: false, isWritable: true },
          ],
          programId: TOKEN_PROGRAM_ID,
          data: Buffer.from([1, 2, 3, 4]),
        }),
      ],
    }).compileToV0Message();
    return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
  }

  function fakeConnection(wsolBalance: string, ataExists: boolean): Connection {
    return {
      getAccountInfo: async () => (ataExists ? { data: Buffer.alloc(165) } : null),
      getTokenAccountBalance: async () => {
        if (!ataExists && wsolBalance === '0') throw new Error('Account does not exist');
        return { value: { amount: wsolBalance, decimals: 9, uiAmount: Number(wsolBalance) } };
      },
      getMinimumBalanceForRentExemption: async () => 2_039_280,
      getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }),
    } as unknown as Connection;
  }

  function inspect(txB64: string): { programIds: PublicKey[]; touchesWsol: boolean } {
    const t = Transaction.from(Buffer.from(txB64, 'base64'));
    return {
      programIds: t.instructions.map((ix) => ix.programId),
      touchesWsol: t.instructions.some((ix) => ix.keys.some((k) => k.pubkey.equals(WSOL_ATA))),
    };
  }

  it('wraps native SOL in front of Jupiter when paying with SOL', async () => {
    const out = await withNativeSol(jupiterTxB64(), WALLET, 500_000_000n, true, false, fakeConnection('0', true));
    const ix = inspect(out);
    assert.equal(ix.programIds[0]?.toBase58(), SystemProgram.programId.toBase58());
    assert.equal(ix.programIds[1]?.toBase58(), TOKEN_PROGRAM_ID.toBase58());
    assert.ok(ix.touchesWsol);
  });

  it('creates and initializes the wSOL account when the user has none', async () => {
    const out = await withNativeSol(jupiterTxB64(), WALLET, 500_000_000n, true, false, fakeConnection('0', false));
    const ix = inspect(out);
    // create (System) + initialize (Token) + syncNative (Token) then Jupiter's own.
    assert.equal(ix.programIds[0]?.toBase58(), SystemProgram.programId.toBase58());
    assert.equal(ix.programIds[1]?.toBase58(), TOKEN_PROGRAM_ID.toBase58());
    assert.equal(ix.programIds[2]?.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  });

  it('closes an empty wSOL account so the output arrives as native SOL', async () => {
    const out = await withNativeSol(jupiterTxB64(), WALLET, 2_000_000n, false, true, fakeConnection('0', true));
    const t = Transaction.from(Buffer.from(out, 'base64'));
    assert.ok(t.instructions.some((ix) => ix.keys.some((k) => k.pubkey.equals(WSOL_ATA))));
    // SPL CloseAccount (opcode 9) on the token program, after Jupiter's own work.
    const last = t.instructions[t.instructions.length - 1];
    assert.equal(last?.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58());
    assert.equal(last?.data[0], 9);
  });

  it('returns a transaction that survives a decode and re-encode round trip', async () => {
    for (const wrapIn of [true, false]) {
      const out = await withNativeSol(
        jupiterTxB64(),
        WALLET,
        500_000_000n,
        wrapIn,
        !wrapIn,
        fakeConnection('0', true),
      );
      // Re-wrapping the rebuilt message in VersionedTransaction failed later, at
      // encode time, and took roughly one SOL quote in ten down with it.
      const t = Transaction.from(Buffer.from(out, 'base64'));
      assert.equal(t.feePayer?.toBase58(), WALLET);
      assert.equal(t.recentBlockhash, BLOCKHASH);
      assert.ok(Buffer.from(t.serialize({ requireAllSignatures: false })).length > 0);
    }
  });

  it('never closes a wSOL account that already holds a balance', async () => {
    const out = await withNativeSol(jupiterTxB64(), WALLET, 2_000_000n, false, true, fakeConnection('1500000000', true));
    const t = Transaction.from(Buffer.from(out, 'base64'));
    const closes = t.instructions.some(
      (ix) => ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 9,
    );
    assert.equal(closes, false);
  });
});
