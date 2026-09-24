import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recordPrice, changePct, sparkline, getHistory } from '../src/services/prices/history.js';
import { toDisplayBalance } from '../src/services/solana/balances.js';
import { canonicalAssetSymbol, getPrice } from '../src/services/xstocks/assets.service.js';

describe('price history ring', () => {
  it('reports no change until two real observations exist in-window', () => {
    recordPrice('TESTA', '100', 1000);
    // One sample cannot prove a 24h change — it stays blank, not invented 0%.
    assert.equal(changePct('TESTA', 86_400_000, 2000), null);
    recordPrice('TESTA', '110', 2000);
    assert.equal(changePct('TESTA', 86_400_000, 2000), 10);
  });

  it('never uses a point older than the window as the baseline', () => {
    recordPrice('TESTB', '100', 0);
    recordPrice('TESTB', '200', 100_000);
    // 50s window ending at t=100000 contains one point only -> null, not 0.
    assert.equal(changePct('TESTB', 50_000, 100_000), null);
  });

  it('unknown symbols stay null (never seen a price)', () => {
    assert.equal(changePct('NEVER_SEEN_XYZ', 86_400_000, Date.now()), null);
  });

  it('same-price records extend freshness without inventing a point', () => {
    recordPrice('TESTC', '50', 1000);
    recordPrice('TESTC', '50', 2000);
    assert.equal(getHistory('TESTC').length, 1); // one real point, timestamp moved
    assert.equal(getHistory('TESTC')[0]?.t, 2000);
    assert.equal(changePct('TESTC', 86_400_000, 2000), null);
  });

  it('sparkline downsamples but always keeps the last point', () => {
    for (let i = 0; i < 100; i++) recordPrice('TESTD', String(100 + i), i * 1000);
    const sp = sparkline('TESTD', 10);
    assert.equal(sp.length, 10);
    assert.equal(sp[sp.length - 1]?.p, '199');
  });
});

describe('wallet display balances', () => {
  it('applies the multiplier for xStocks only', () => {
    // 5 raw @ 1.1 -> 5.5 display
    assert.equal(toDisplayBalance('xstock', '500000000', 8, '1.1'), '5.5');
    // stables/pre-IPO ignore multiplier
    assert.equal(toDisplayBalance('stable', '5000000', 6, '1.1'), '5');
    assert.equal(toDisplayBalance('pre', '1500000000', 9, null), '1.5');
  });
});

describe('ticker symbol normalization', () => {
  it('keeps pre-IPO ALL-CAPS (SPACEX, not SPACEx)', async () => {
    assert.equal(await canonicalAssetSymbol('spacex'), 'SPACEX');
    assert.equal(await canonicalAssetSymbol('SPACEX'), 'SPACEX');
  });

  it('keeps xStock and stable forms', async () => {
    assert.equal(await canonicalAssetSymbol('nvdaX'), 'NVDAx');
    assert.equal(await canonicalAssetSymbol('usdc'), 'USDC');
  });

  it('prices stables at the $1.00 peg without upstream calls', async () => {
    const usdc = await getPrice('USDC');
    assert.equal(usdc?.value, '1');
    assert.equal(usdc?.currency, 'USD');
  });
});
