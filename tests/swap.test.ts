import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSwapQuote, assertStockStablePair } from '../src/services/jupiter/quote.service.js';
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
      /tokenized stock and a stable/,
    );
  });

  it('rejects SOL (out of MVP scope)', async () => {
    await assert.rejects(() => buildSwapQuote({ sell: 'SOL', buy: 'NVDAx', amount: '1' }), /not part of the Umbra swap MVP/);
  });

  it('rejects malformed taker addresses', async () => {
    await assert.rejects(
      () => buildSwapQuote({ sell: 'USDC', buy: 'NVDAx', amount: '10', userPublicKey: 'nope' }),
      /not a valid Solana address/,
    );
  });

  it('rejects stock-to-stock pairs (stock↔stable only)', async () => {
    await assert.rejects(
      () => buildSwapQuote({ sell: 'NVDAx', buy: 'AAPLx', amount: '1' }),
      /only supported between a tokenized stock and a stable/,
    );
  });

  it('rejects stable-to-stable pairs', async () => {
    await assert.rejects(
      () => buildSwapQuote({ sell: 'USDC', buy: 'USDT', amount: '10' }),
      /only supported between a tokenized stock and a stable/,
    );
  });
});

describe('stock↔stable pair rules', () => {
  const PRE = new Set(['SPACEX', 'OPENAI', 'ANTHROPIC', 'KALSHI', 'NEURALINK', 'ANDURIL', 'FIGUREAI', 'POLYMARKET']);

  it('accepts both directions with canonical symbols', () => {
    assert.deepEqual(assertStockStablePair('USDC', 'NVDAx'), { stock: 'NVDAx', stable: 'USDC' });
    assert.deepEqual(assertStockStablePair('NVDAx', 'usdt'), { stock: 'NVDAx', stable: 'USDT' });
  });

  it('accepts pre-IPO stocks against stables either way', () => {
    assert.deepEqual(assertStockStablePair('USDC', 'SPACEX', PRE), { stock: 'SPACEX', stable: 'USDC' });
    assert.deepEqual(assertStockStablePair('openai', 'USDT', PRE), { stock: 'OPENAI', stable: 'USDT' });
  });

  it('rejects listed-stock to pre-IPO pairs (both are stocks)', async () => {
    await assert.rejects(
      () => buildSwapQuote({ sell: 'NVDAx', buy: 'SPACEX', amount: '1' }),
      /only supported between a tokenized stock and a stable/,
    );
  });

  it('canonicalizes stables case-insensitively', () => {
    assert.equal(canonicalSymbol('usdt'), 'USDT');
    assert.equal(canonicalSymbol('UsDc'), 'USDC');
    assert.equal(canonicalSymbol('nvdaX'), 'NVDAx');
  });
});
