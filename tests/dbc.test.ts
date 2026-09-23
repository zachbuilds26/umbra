import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import {
  DBC_KEEPER_THRESHOLD_BASE_UNITS,
  DBC_QUOTE_MINT,
  EQUITY_PRESETS,
  assembleEquityCurve,
  buildEquityConfig,
  describePreset,
  getEquityPreset,
} from '../src/services/meteora/dbc-presets.js';
import { SOLANA_USDC_MINT } from '../src/services/xstocks/assets.service.js';

// Pure curve-math tests: no RPC, no network. The SDK's own
// validateConfigParameters is the oracle — a preset that passes it here is
// safe to send to createConfig on any network.
describe('dbc presets', () => {
  it('exposes three equity presets quoted in USDC', () => {
    assert.equal(EQUITY_PRESETS.length, 3);
    assert.equal(DBC_QUOTE_MINT, SOLANA_USDC_MINT);
    for (const p of EQUITY_PRESETS) {
      assert.ok(getEquityPreset(p.id), p.id);
    }
    assert.equal(getEquityPreset('meme-coin'), null);
  });

  it('every preset builds and passes SDK validation', () => {
    const receiver = Keypair.generate().publicKey.toBase58();
    for (const p of EQUITY_PRESETS) {
      const { config } = buildEquityConfig(p.id, receiver);
      // Curve + threshold survive the round trip as real numbers.
      const c = config as unknown as { curve: unknown[]; migrationQuoteThreshold: { toString: () => string } };
      assert.ok(c.curve.length >= 2, `${p.id}: two-segment curve`);
      assert.ok(Number(c.migrationQuoteThreshold.toString()) > 0, `${p.id}: threshold`);
    }
  });

  it('unknown preset throws a clear error', () => {
    const receiver = Keypair.generate().publicKey.toBase58();
    assert.throws(() => buildEquityConfig('nope', receiver), /Unknown DBC preset/);
    assert.equal(describePreset('nope'), null);
  });

  it('describePreset reports honest economics with keeper-compatible thresholds', () => {
    for (const p of EQUITY_PRESETS) {
      const d = describePreset(p.id);
      assert.ok(d, p.id);
      assert.ok(d?.startPriceUsd && Number(d.startPriceUsd) > 0, `${p.id}: start price`);
      assert.ok(d?.migrationThresholdUsdc && Number(d.migrationThresholdUsdc) > 0, `${p.id}: threshold`);
      // Keeper auto-migration needs >= 750 USDC for USDC-quoted pools.
      assert.equal(d?.keeperAutoMigrate, true, `${p.id}: keeper-eligible`);
      assert.ok(
        Number(d?.migrationThresholdUsdc) * 1e6 >= DBC_KEEPER_THRESHOLD_BASE_UNITS,
        `${p.id}: threshold floor`,
      );
    }
  });

  it('assembleEquityCurve stays receiver-free (no invented validation claims)', () => {
    const { config } = assembleEquityCurve('equity-discovery');
    const c = config as unknown as Record<string, unknown>;
    assert.equal(c.leftoverReceiver, undefined);
  });
});
