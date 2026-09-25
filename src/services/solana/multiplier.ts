import DecimalJs from 'decimal.js';
import type { Decimal as DecimalInstance } from 'decimal.js';
import Decimal from '../../utils/decimal.js';

// Mandatory multiplier math (plan §10). Exact decimal arithmetic only — never floats.
// Solana xStocks are Token-2022 Scaled-UI: displayed = raw × multiplier.
//
// Rounding is specified per operation rather than set globally: the Decimal
// singleton is shared process-wide, and a global `set()` changed how every other
// Decimal user (spreads, price history) rounded depending on import order.
const FLOOR = DecimalJs.ROUND_FLOOR;
/** An SPL token amount is a u64; conversions must stay inside it. */
const U64_MAX = '18446744073709551615';

function assertFinite(value: DecimalInstance, what: string): void {
  if (!value.isFinite()) throw new Error(`${what} is not a finite number`);
}

function assertDecimals(decimals: number): void {
  // Token decimals are a small non-negative integer. A fractional or absurd
  // exponent produced values like "Infinity" from perfectly finite inputs.
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`invalid token decimals: ${decimals}`);
  }
}

export function displayFromRaw(rawAmount: string, multiplier: string): string {
  const raw = new Decimal(rawAmount);
  const mult = new Decimal(multiplier);
  assertFinite(raw, 'raw amount');
  assertFinite(mult, 'multiplier');
  if (raw.isNegative() || mult.lte(0)) throw new Error('invalid multiplier input');
  const out = raw.mul(mult);
  assertFinite(out, 'display amount');
  return out.toString();
}

export function rawFromDisplay(displayAmount: string, multiplier: string): string {
  const disp = new Decimal(displayAmount);
  const mult = new Decimal(multiplier);
  assertFinite(disp, 'display amount');
  assertFinite(mult, 'multiplier');
  if (disp.isNegative() || mult.lte(0)) throw new Error('invalid multiplier input');
  const out = disp.div(mult);
  assertFinite(out, 'raw amount');
  return out.toString();
}

/** Convert a human display amount to base units (raw chain units), given token decimals. */
export function displayToBaseUnits(displayAmount: string, multiplier: string, decimals: number): string {
  assertDecimals(decimals);
  const raw = new Decimal(rawFromDisplay(displayAmount, multiplier));
  const base = raw.mul(new Decimal(10).pow(decimals)).toDecimalPlaces(0, FLOOR);
  assertFinite(base, 'base units');
  if (base.isNegative()) throw new Error('negative base units');
  if (base.gt(U64_MAX)) throw new Error('amount exceeds the maximum a token balance can hold');
  return base.toFixed(0);
}

/** Convert base units to human display amount. */
export function baseUnitsToDisplay(baseUnits: string, multiplier: string, decimals: number): string {
  assertDecimals(decimals);
  const base = new Decimal(baseUnits);
  assertFinite(base, 'base units');
  if (base.isNegative()) throw new Error('negative base units');
  const raw = base.div(new Decimal(10).pow(decimals));
  return displayFromRaw(raw.toString(), multiplier);
}
