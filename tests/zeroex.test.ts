import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseZeroExQuote, getZeroExQuote } from '../src/services/zeroex/client.js';

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

  it('rejects a malformed or unsafe amount instead of rounding it', async () => {
    // These are asserted through the same guard the real call uses. The client
    // refuses before any network access, so the test is deterministic even when
    // a key is configured in the environment.
    assert.equal(await getZeroExQuote({ tokenIn: 'a', tokenOut: 'b', amountInBaseUnits: 'NaN' }), null);
    assert.equal(await getZeroExQuote({ tokenIn: 'a', tokenOut: 'b', amountInBaseUnits: '1.5' }), null);
    assert.equal(await getZeroExQuote({ tokenIn: 'a', tokenOut: 'b', amountInBaseUnits: '0' }), null);
    assert.equal(await getZeroExQuote({ tokenIn: 'a', tokenOut: 'b', amountInBaseUnits: '-1' }), null);
    // Above 2^53-1 a JSON number cannot represent the u64 exactly.
    assert.equal(
      await getZeroExQuote({ tokenIn: 'a', tokenOut: 'b', amountInBaseUnits: '9007199254740993' }),
      null,
    );
  });
});
