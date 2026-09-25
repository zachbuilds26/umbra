import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toSnapshot, tokensEnabled } from '../src/services/tokens/market.js';

const MINT = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';

describe('tokens snapshot mapping', () => {
  it('maps a full market row without inventing anything', () => {
    const snap = toSnapshot(MINT, {
      address: MINT,
      hasMarket: true,
      token: {
        address: MINT,
        symbol: 'NVDAx',
        name: 'NVIDIA',
        decimals: 8,
        liquidity: 6860418.427359796,
        volume24hUSD: 16745287.959559813,
        price: 226.02932539041777,
        priceChange24hPercent: 1.2426637079594354,
        marketCap: 34081623.9299805,
      },
    });
    assert.equal(snap?.mint, MINT);
    assert.equal(snap?.symbol, 'NVDAx');
    assert.equal(snap?.priceUsd, 226.02932539041777);
    assert.equal(snap?.change24hPct, 1.24);
    assert.equal(snap?.liquidityUsd, 6860418.427359796);
    assert.equal(snap?.marketCapUsd, 34081623.9299805);
    assert.equal(snap?.hasMarket, true);
  });

  it('marks marketless rows so callers fall back instead of printing junk', () => {
    const snap = toSnapshot('PreANxuX', { address: 'PreANxuX', hasMarket: false });
    assert.equal(snap?.hasMarket, false);
    assert.equal(snap?.priceUsd, null);
    assert.equal(snap?.change24hPct, null);
  });

  it('refuses zero/negative prices and malformed rows', () => {
    assert.equal(toSnapshot(MINT, null), null);
    assert.equal(toSnapshot(MINT, 'nope'), null);
    assert.equal(
      toSnapshot(MINT, { address: MINT, hasMarket: true, token: { price: 0 } })?.priceUsd,
      null,
    );
    assert.equal(
      toSnapshot(MINT, { address: MINT, hasMarket: true, token: { price: -5 } })?.priceUsd,
      null,
    );
  });

  it('stays disabled without a key so tests never touch the network', () => {
    assert.equal(tokensEnabled(), false);
  });
});
