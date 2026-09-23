import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isValidSolanaAddress, isValidEvmAddress, isValidBridgeWallet } from '../src/utils/addresses.js';

describe('address validation', () => {
  it('accepts real Solana mints', () => {
    assert.equal(isValidSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), true); // USDC
    assert.equal(isValidSolanaAddress('Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh'), true); // NVDAx
  });

  it('rejects malformed Solana addresses', () => {
    assert.equal(isValidSolanaAddress(''), false);
    assert.equal(isValidSolanaAddress('not-an-address'), false);
    assert.equal(isValidSolanaAddress('0x1234'), false);
  });

  it('validates EVM addresses strictly', () => {
    assert.equal(isValidEvmAddress('0xc845b2894dbddd03858fd2d643b4ef725fe0849d'), true);
    assert.equal(isValidEvmAddress('0xZZZ'), false);
    assert.equal(isValidEvmAddress('c845b2894dbddd03858fd2d643b4ef725fe0849d'), false);
  });

  it('validates bridge wallets per network', () => {
    assert.equal(
      isValidBridgeWallet('Ethereum', '0xc845b2894dbddd03858fd2d643b4ef725fe0849d'),
      true,
    );
    assert.equal(isValidBridgeWallet('Ethereum', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), false);
    assert.equal(
      isValidBridgeWallet('Solana', 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh'),
      true,
    );
  });
});
