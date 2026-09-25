import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recordPrice, changePct, sparkline } from '../src/services/prices/history.js';
import { aggregateByMint, toDisplayBalance } from '../src/services/solana/balances.js';
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

  it('same-price records extend freshness without moving the event time', () => {
    recordPrice('TESTC', '50', 1000);
    recordPrice('TESTC', '50', 2000);
    assert.equal(sparkline('TESTC').length, 1); // one real price, not two
    // The event time must stay at the first observation. Sliding it forward with
    // every poll is what made a move that happened seconds ago report as a 24h
    // change; freshness is tracked separately.
    assert.equal(sparkline('TESTC')[0]?.t, 1000);
    assert.equal(changePct('TESTC', 86_400_000, 2000), null);
  });

  it('measures 24h change from the oldest observation inside the window', () => {
    // 100 observed a day ago, unchanged ever since, then 110 now: +10% against
    // the oldest point still inside the 24h window.
    recordPrice('TESTE', '100', 0);
    recordPrice('TESTE', '100', 60_000);
    recordPrice('TESTE', '100', 86_400_000);
    recordPrice('TESTE', '110', 86_401_000);
    assert.equal(changePct('TESTE', 86_400_000, 86_401_000), 10);
  });

  it('drops symbols nothing has refreshed, so the map cannot grow forever', () => {
    recordPrice('TESTG', '10', 0);
    // Two hours later the ring is older than the symbol TTL.
    recordPrice('TESTH', '20', 7_200_000);
    assert.equal(changePct('TESTG', 86_400_000, 7_200_000), null);
  });

  it('ignores observations dated in the future', () => {
    // Only the second point is inside the observable past; the future one must
    // not be used as the newest price, which would report a +400% swing that
    // has not happened.
    recordPrice('TESTI', '100', 1_000);
    recordPrice('TESTI', '500', 2_000_000);
    assert.equal(changePct('TESTI', 86_400_000, 1_000_000), null);
  });

  it('reports no change for two prices seen at the same instant', () => {
    recordPrice('TESTJ', '100', 5_000);
    recordPrice('TESTJ', '110', 5_000);
    // Same timestamp: no elapsed time, so no change can be measured.
    assert.equal(changePct('TESTJ', 86_400_000, 10_000), null);
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

describe('token accounts are summed per mint', () => {
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  it('adds several accounts of the same mint into one row', () => {
    // Two USDC accounts: 204.6133 + 2839.940216. Returning both made the UI show
    // only the first, reporting a fifth of the real holding.
    const merged = aggregateByMint([
      { mint: USDC, amount: '204613300', decimals: 6 },
      { mint: USDC, amount: '2839940216', decimals: 6 },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.amount, '3044553516');
    assert.equal(toDisplayBalance('stable', merged[0]!.amount, 6, null), '3044.553516');
  });

  it('sums exactly, without float rounding, at large balances', () => {
    const merged = aggregateByMint([
      { mint: USDC, amount: '9007199254740993', decimals: 6 },
      { mint: USDC, amount: '1', decimals: 6 },
    ]);
    assert.equal(merged[0]?.amount, '9007199254740994');
  });

  it('keeps different mints separate', () => {
    const merged = aggregateByMint([
      { mint: USDC, amount: '1', decimals: 6 },
      { mint: 'XsDoVfqeBu', amount: '2', decimals: 8 },
    ]);
    assert.equal(merged.length, 2);
  });

  it('drops malformed rows rather than folding them into a total', () => {
    const merged = aggregateByMint([
      { mint: USDC, amount: '1000000', decimals: 6 },
      { mint: USDC, amount: 'NaN', decimals: 6 },
      { mint: USDC, amount: '-5', decimals: 6 },
      { mint: USDC, amount: '5', decimals: 1.5 },
      { mint: undefined, amount: '5', decimals: 6 },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.amount, '1000000');
  });
});

describe('ticker symbol normalization', () => {
  // These resolve against the live pre-IPO directory, so they are the only
  // network-dependent tests in the suite. When the provider is unreachable the
  // test SKIPS with a reason rather than failing on someone else's outage — and
  // it still asserts exactly when the directory is available, so it can never
  // pass without checking anything.
  const directoryAvailable = async (): Promise<boolean> => {
    const { getPrestocksSymbols } = await import('../src/services/prestocks/assets.js');
    const symbols = await getPrestocksSymbols().catch(() => new Set<string>());
    return symbols.size > 0;
  };

  it('keeps pre-IPO ALL-CAPS (SPACEX, not SPACEx)', async (t) => {
    if (!(await directoryAvailable())) {
      t.skip('pre-IPO directory unavailable (upstream)');
      return;
    }
    assert.equal(await canonicalAssetSymbol('spacex'), 'SPACEX');
    assert.equal(await canonicalAssetSymbol('SPACEX'), 'SPACEX');
  });

  it('keeps xStock and stable forms', async (t) => {
    if (!(await directoryAvailable())) {
      t.skip('pre-IPO directory unavailable (upstream)');
      return;
    }
    assert.equal(await canonicalAssetSymbol('nvdaX'), 'NVDAx');
    assert.equal(await canonicalAssetSymbol('usdc'), 'USDC');
  });

  it('prices stables at the $1.00 peg without upstream calls', async () => {
    const usdc = await getPrice('USDC');
    assert.equal(usdc?.value, '1');
    assert.equal(usdc?.currency, 'USD');
  });
});
