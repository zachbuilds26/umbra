import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseZeroExQuote, getZeroExQuote, getZeroExUsdPrice } from '../src/services/zeroex/client.js';

// Pure parser tests + disabled-leg behavior (no key in .env => null, never throws).
describe('zeroex client', () => {
  it('parses snake_case quote fields', () => {
    const q = parseZeroExQuote({ amount_out: '158650000', min_amount_out: '157000000' });
    assert.equal(q?.amountOutBaseUnits, '158650000');
    assert.equal(q?.minAmountOutBaseUnits, '157000000');
  });

  it('parses camelCase quote fields', () => {
    const q = parseZeroExQuote({ amountOut: 1034460000 });
    assert.equal(q?.amountOutBaseUnits, '1034460000');
    assert.equal(q?.minAmountOutBaseUnits, null);
  });

  it('rejects empty / missing amounts', () => {
    assert.equal(parseZeroExQuote({}), null);
    assert.equal(parseZeroExQuote({ amount_out: '' }), null);
    assert.equal(parseZeroExQuote(null), null);
    assert.equal(parseZeroExQuote('nope'), null);
  });

  it('disabled leg returns null without network (no key configured)', async () => {
    // .env carries no ZEROEX_API_KEY in this workspace — the leg must be inert.
    const q = await getZeroExQuote({
      tokenIn: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      tokenOut: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      amountInBaseUnits: '1000000',
    });
    assert.equal(q, null);
    const p = await getZeroExUsdPrice('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6);
    assert.equal(p, null);
  });
});
