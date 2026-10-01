import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  signBinanceRequest,
  encodeQuery,
  binanceTimestamp,
  mapBinanceCode,
  isBinanceEnabled,
} from '../src/services/binance/client.js';

// Signer + mapper tests. No network: the secret never leaves the module, and
// a disabled leg (no key in .env) reports itself instead of throwing.
describe('binance client', () => {
  it('signs timestamp + METHOD + requestPath + body with no separators', () => {
    const sig = signBinanceRequest({
      secret: 'test-secret',
      timestamp: '2026-05-11T10:08:57.715Z',
      method: 'GET',
      requestPath: '/build/api/v1/dex/market/price?chainId=1',
      body: '',
    });
    assert.equal(sig, 'LEMEaQD6g+PDGTQJ1G0egQ0GYCOEDZqrtKNowDv9lYc=');
  });

  it('changes the signature when the /build prefix is dropped', () => {
    const good = signBinanceRequest({
      secret: 'test-secret',
      timestamp: '2026-05-11T10:08:57.715Z',
      method: 'GET',
      requestPath: '/build/api/v1/dex/market/price?chainId=1',
      body: '',
    });
    const bad = signBinanceRequest({
      secret: 'test-secret',
      timestamp: '2026-05-11T10:08:57.715Z',
      method: 'GET',
      requestPath: '/api/v1/dex/market/price?chainId=1',
      body: '',
    });
    assert.notEqual(good, bad);
  });

  it('encodes query params with %20 (never +) in stable key order', () => {
    assert.equal(
      encodeQuery({ binanceChainId: '56', keyword: 'NVDA Corp' }),
      'binanceChainId=56&keyword=NVDA%20Corp',
    );
    assert.equal(encodeQuery({ a: undefined, b: 'x' }), 'b=x');
  });

  it('emits ISO 8601 UTC with milliseconds', () => {
    assert.match(binanceTimestamp(new Date('2026-05-11T10:08:57.715Z')), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('maps provider codes to our error contract', () => {
    assert.equal(mapBinanceCode(40102).code, 'PROVIDER_ERROR');
    assert.equal(mapBinanceCode(40102).statusCode, 503);
    assert.equal(mapBinanceCode(42900).code, 'RATE_LIMITED');
    assert.equal(mapBinanceCode(40401).code, 'QUOTE_EXPIRED');
    assert.equal(mapBinanceCode(40367).code, 'SWAP_UNAVAILABLE');
    assert.equal(mapBinanceCode(40369).code, 'SWAP_UNAVAILABLE');
    assert.equal(mapBinanceCode(40374).code, 'INSUFFICIENT_LIQUIDITY');
    assert.equal(mapBinanceCode(40001).code, 'VALIDATION_ERROR');
    assert.equal(mapBinanceCode(99999).code, 'PROVIDER_ERROR');
  });

  it('reports the BSC leg as a boolean, never the key itself', () => {
    assert.equal(typeof isBinanceEnabled(), 'boolean');
  });
});

describe('bsc simulate parser', () => {
  it('parses SUCCESS / FAILED envelopes tolerantly', async () => {
    const { parseSimResult } = await import('../src/services/binance/trading.service.js');
    assert.deepEqual(parseSimResult({ status: 'SUCCESS' }), { ok: true, failReason: null });
    assert.deepEqual(parseSimResult({ status: 'FAILED', failReason: 'execution reverted: nope' }), {
      ok: false,
      failReason: 'execution reverted: nope',
    });
    assert.deepEqual(parseSimResult({ status: 'FAILED' }), { ok: false, failReason: null });
    assert.deepEqual(parseSimResult({}), { ok: false, failReason: null });
    assert.deepEqual(parseSimResult(null), { ok: false, failReason: null });
  });

  it('converts display amounts to base units without float', async () => {
    const { toBaseUnits, fromBaseUnits } = await import('../src/services/binance/trading.service.js');
    assert.equal(toBaseUnits('5', 18), '5000000000000000000');
    assert.equal(toBaseUnits('0.07', 18), '70000000000000000');
    assert.equal(fromBaseUnits('14135177854857122', 18), '0.014135177854857122');
    assert.throws(() => toBaseUnits('abc', 18));
    assert.throws(() => toBaseUnits('0', 18));
  });
});
