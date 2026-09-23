import Decimal from 'decimal.js';

// Mandatory multiplier math (plan §10). Exact decimal arithmetic only — never floats.
// Solana xStocks are Token-2022 Scaled-UI: displayed = raw × multiplier.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN });

export function displayFromRaw(rawAmount: string, multiplier: string): string {
  const raw = new Decimal(rawAmount);
  const mult = new Decimal(multiplier);
  if (!raw.isFinite() || !mult.isFinite()) throw new Error('non-numeric multiplier input');
  if (raw.isNegative() || mult.lte(0)) throw new Error('invalid multiplier input');
  return raw.mul(mult).toString();
}

export function rawFromDisplay(displayAmount: string, multiplier: string): string {
  const disp = new Decimal(displayAmount);
  const mult = new Decimal(multiplier);
  if (!disp.isFinite() || !mult.isFinite()) throw new Error('non-numeric multiplier input');
  if (disp.isNegative() || mult.lte(0)) throw new Error('invalid multiplier input');
  return disp.div(mult).toString();
}

/** Convert a human display amount to base units (raw chain units), given token decimals. */
export function displayToBaseUnits(displayAmount: string, multiplier: string, decimals: number): string {
  const raw = new Decimal(rawFromDisplay(displayAmount, multiplier));
  return raw.mul(new Decimal(10).pow(decimals)).floor().toFixed(0);
}

/** Convert base units to human display amount. */
export function baseUnitsToDisplay(baseUnits: string, multiplier: string, decimals: number): string {
  const raw = new Decimal(baseUnits).div(new Decimal(10).pow(decimals));
  return displayFromRaw(raw.toString(), multiplier);
}
