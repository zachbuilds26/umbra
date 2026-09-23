import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateBridgeQuoteRequest } from '../src/services/bridge/bridge-validation.service.js';

// Pure rejection paths (no network needed). Live-config paths are covered by
// integration checks against the real public endpoint in CI/demo.

describe('bridge validation (offline rules)', () => {
  it('rejects any destination that is not Solana', async () => {
    await assert.rejects(
      () =>
        validateBridgeQuoteRequest({
          sourceNetwork: 'Ethereum',
          asset: 'NVDAx',
          amount: '1.5',
          destinationNetwork: 'Arbitrum',
          destinationAddress: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
        }),
      (err: Error) => /only bridges to Solana/.test(err.message),
    );
  });

  it('rejects zero amounts without touching the network', async () => {
    await assert.rejects(
      () =>
        validateBridgeQuoteRequest({
          sourceNetwork: 'Ethereum',
          asset: 'NVDAx',
          amount: '0',
          destinationNetwork: 'Solana',
          destinationAddress: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
        }),
      (err: Error) => /greater than zero/.test(err.message),
    );
  });

  it('rejects invalid Solana destination addresses', async () => {
    await assert.rejects(
      () =>
        validateBridgeQuoteRequest({
          sourceNetwork: 'Ethereum',
          asset: 'NVDAx',
          amount: '1.5',
          destinationNetwork: 'Solana',
          destinationAddress: '0x1234',
        }),
      (err: Error) => /not a valid Solana address/.test(err.message),
    );
  });
});
