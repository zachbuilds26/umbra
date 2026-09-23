import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  displayFromRaw,
  rawFromDisplay,
  displayToBaseUnits,
  baseUnitsToDisplay,
} from '../src/services/solana/multiplier.js';

// Plan §10: normal, dividend, split, reverse-split, fractional, rounding boundaries.
// Never floats — exact decimal arithmetic only.

describe('multiplier math', () => {
  it('identity at 1.0', () => {
    assert.equal(displayFromRaw('10', '1'), '10');
    assert.equal(rawFromDisplay('10', '1'), '10');
  });

  it('dividend multiplier increases display value', () => {
    // Apple-style dividend: 1.0 -> 1.1
    assert.equal(displayFromRaw('1', '1.1'), '1.1');
    assert.equal(displayFromRaw('10', '1.1'), '11');
  });

  it('stock split scales up (1.1 -> 4.4 on 4-for-1)', () => {
    assert.equal(displayFromRaw('1', '4.4'), '4.4');
  });

  it('reverse split scales down (4.4 -> 2.2)', () => {
    assert.equal(displayFromRaw('1', '2.2'), '2.2');
  });

  it('transfer math: send display 5.5 @ 1.1 -> raw 5', () => {
    assert.equal(rawFromDisplay('5.5', '1.1'), '5');
  });

  it('buy after event: 1 AAPL @ 1.1 -> raw 0.90909… (ROUND_DOWN truncates)', () => {
    const raw = rawFromDisplay('1', '1.1');
    assert.ok(raw.startsWith('0.9090909090'), raw);
    // Truncation means the round-trip lands a hair under 1 — bounded by 1e-12, never over.
    const back = Number(displayFromRaw(raw, '1.1'));
    assert.ok(back <= 1 && 1 - back < 1e-12, String(back));
  });

  it('fractional holdings keep precision', () => {
    assert.equal(displayFromRaw('0.00000001', '1.001701196801074'), '1.001701196801074e-8');
  });

  it('live NVDAx multiplier converts display to 8dp base units', () => {
    // 2.71 NVDAx display @ live-ish multiplier -> integer base units
    const base = displayToBaseUnits('2.71', '1.001701196801074', 8);
    assert.match(base, /^\d+$/);
    const back = baseUnitsToDisplay(base, '1.001701196801074', 8);
    // Floor rounding: back <= original, within 1 base unit of value
    assert.ok(Number(back) <= 2.71 && Number(back) > 2.709999, back);
  });

  it('rejects zero/negative multipliers and non-numeric input', () => {
    assert.throws(() => displayFromRaw('1', '0'));
    assert.throws(() => rawFromDisplay('1', '-1.5'));
    assert.throws(() => displayFromRaw('abc', '1.1'));
  });
});
