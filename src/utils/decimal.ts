import DecimalJs from 'decimal.js';

/**
 * One configured Decimal for the whole process.
 *
 * decimal.js exposes mutable global settings. Modules were calling
 * `Decimal.set({ precision: 40 })`, and because the effective precision became
 * whichever module loaded last, the same input produced different base units
 * depending on import order — measured as 1000000000000000000 versus
 * 999999999999999999 for the same conversion. A configured clone keeps the
 * precision with the code that needs it and makes the result order-independent.
 *
 * Rounding is never set globally: a floor is required when converting a display
 * amount down to on-chain units, and a half-up default is required elsewhere,
 * so each operation states its own rounding mode.
 */
const Decimal = DecimalJs.clone({ precision: 40 });

export default Decimal;
