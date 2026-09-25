import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSwapQuote,
  assertStockStablePair,
  classifyJupiterFailure,
  displayToAtomicUnits,
  normalizeQuote,
} from '../src/services/jupiter/quote.service.js';
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
      /tokenized stock and USDC or USDT/,
    );
  });

  it('rejects base-to-base pairs (SOL into USDC)', async () => {
    await assert.rejects(
      () => buildSwapQuote({ sell: 'SOL', buy: 'USDC', amount: '1' }),
      /tokenized stock and USDC or USDT/,
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
      /only supported between a tokenized stock and USDC or USDT/,
    );
  });

  it('rejects stable-to-stable pairs', async () => {
    await assert.rejects(
      () => buildSwapQuote({ sell: 'USDC', buy: 'USDT', amount: '10' }),
      /only supported between a tokenized stock and USDC or USDT/,
    );
  });

  it('rejects SOL against a stock (Jupiter routes SOL through wrapped SOL)', async () => {
    await assert.rejects(
      () => buildSwapQuote({ sell: 'SOL', buy: 'NVDAx', amount: '0.5' }),
      /only supported between a tokenized stock and USDC or USDT/,
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

  it('rejects base-to-base pairs (SOL↔USDC)', () => {
    assert.throws(
      () => assertStockStablePair('SOL', 'USDC'),
      /only supported between a tokenized stock and USDC or USDT/,
    );
  });

  it('rejects SOL against a stock', () => {
    assert.throws(
      () => assertStockStablePair('SOL', 'NVDAx'),
      /only supported between a tokenized stock and USDC or USDT/,
    );
  });

  it('rejects listed-stock to pre-IPO pairs (both are stocks)', async () => {
    await assert.rejects(
      () => buildSwapQuote({ sell: 'NVDAx', buy: 'SPACEX', amount: '1' }),
      /only supported between a tokenized stock and USDC or USDT/,
    );
  });

  it('canonicalizes stables case-insensitively', () => {
    assert.equal(canonicalSymbol('usdt'), 'USDT');
    assert.equal(canonicalSymbol('UsDc'), 'USDC');
    assert.equal(canonicalSymbol('nvdaX'), 'NVDAx');
  });
});

describe('routing failure classification', () => {
  it('reads "Insufficient funds" as a wallet balance problem, never thin liquidity', () => {
    // This is the exact payload Jupiter returns when the taker cannot cover the
    // swap. Reporting it as thin liquidity told users to shrink an amount that
    // was never the problem.
    const r = classifyJupiterFailure({
      status: 200,
      errorCode: 1,
      errorMessage: 'Insufficient funds',
      hasTaker: true,
    });
    assert.equal(r.code, 'INSUFFICIENT_BALANCE');
    assert.notEqual(r.code, 'INSUFFICIENT_LIQUIDITY');
    assert.match(r.message, /insufficient funds/i);
    assert.match(r.message, /SOL/, 'must name the fee currency the wallet is short of');
  });

  it('reads an HTTP 400 as no executable route, not thin liquidity', () => {
    const r = classifyJupiterFailure({ status: 400, hasTaker: true });
    assert.equal(r.code, 'NO_ROUTE');
    assert.match(r.message, /No executable route/i);
  });

  it('only says thin liquidity when the router actually says so', () => {
    const r = classifyJupiterFailure({
      status: 200,
      errorMessage: 'Insufficient liquidity in pool',
      hasTaker: true,
    });
    assert.equal(r.code, 'INSUFFICIENT_LIQUIDITY');
  });

  it('keeps named route failures truthful', () => {
    const r = classifyJupiterFailure({
      status: 200,
      errorMessage: 'Could not find any route between the tokens',
      hasTaker: true,
    });
    assert.equal(r.code, 'NO_ROUTE');
  });

  it('falls back to a provider error without inventing a reason', () => {
    const r = classifyJupiterFailure({ status: 500, hasTaker: true });
    assert.equal(r.code, 'SWAP_UNAVAILABLE');
    assert.equal(r.reason, 'upstream http 500');
  });
});

describe('atomic unit conversion', () => {  it('converts USDC (6dp) exactly, including values a float would truncate', () => {
    assert.equal(displayToAtomicUnits('0.01', 6), '10000');
    assert.equal(displayToAtomicUnits('1', 6), '1000000');
    // Math.floor(1.005 * 1e6) === 1004999 in binary floating point.
    assert.equal(displayToAtomicUnits('1.005', 6), '1005000');
    assert.equal(displayToAtomicUnits('0.07', 6), '70000');
  });

  it('converts ANTHROPIC-style 9dp tokens exactly', () => {
    assert.equal(displayToAtomicUnits('0.0001', 9), '100000');
    assert.equal(displayToAtomicUnits('1.005', 9), '1005000000');
  });

  it('never invents atomic units below one token unit', () => {
    assert.equal(displayToAtomicUnits('0.0000001', 6), '0');
    assert.equal(displayToAtomicUnits('0.000000001', 9), '1');
  });
});

describe('blocked quotes still show the price', () => {
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const NVDAX_MINT = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
  const base = {
    quoteId: 'umbra_q_test',
    sellSide: { symbol: 'USDC', mint: USDC_MINT, decimals: 6 },
    buySide: { symbol: 'NVDAx', mint: NVDAX_MINT, decimals: 8 },
    amount: '0.07',
    receiveDisplay: '0.0003',
    usdValue: '0.07',
    minimumReceived: '0.00029',
    expiresAt: new Date().toISOString(),
    networkFee: { currency: 'SOL' as const, amount: '0.00001', estimated: true },
    platformFeeBps: null,
    routeVenue: 'whirlpool',
  };

  it('carries the block reason with the full pricing', () => {
    const q = normalizeQuote({
      ...base,
      blockReason: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient funds — add about 0.001722 SOL ($0.20) to swap.' },
    });
    assert.deepEqual(q.blockReason, {
      code: 'INSUFFICIENT_BALANCE',
      message: 'Insufficient funds — add about 0.001722 SOL ($0.20) to swap.',
    });
    assert.equal(q.receive.amount, '0.0003');
    assert.equal(q.transaction, null);
  });

  it('leaves the block reason null on executable quotes', () => {
    const q = normalizeQuote({ ...base });
    assert.equal(q.blockReason, null);
  });
});


