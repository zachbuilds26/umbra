import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { humanPrice, spreadBps } from '../src/services/pyth/fair-price.service.js';

describe('pyth price math', () => {
  it('converts mantissa×10^exponent exactly', () => {
    // Docs example: 6140993501000 × 10^-8 = 61409.93501
    assert.equal(humanPrice('6140993501000', -8), '61409.93501');
  });

  it('handles Pro equity exponents (TSLA 36312507 × 10^-5)', () => {
    assert.equal(humanPrice('36312507', -5), '363.12507');
  });

  it('handles positive exponents without float drift', () => {
    assert.equal(humanPrice('219', 2), '21900');
  });

  it('spread math: 219.43 vs 219.205 ≈ +10.26bps', () => {
    const bps = spreadBps('219.43', '219.205');
    assert.ok(bps !== null && bps > 10 && bps < 11, String(bps));
  });

  it('spread returns null on zero base or garbage', () => {
    assert.equal(spreadBps('1', '0'), null);
    assert.equal(spreadBps('abc', '1'), null);
  });
});
