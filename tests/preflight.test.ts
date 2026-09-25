import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectRouteMints,
  computeSolRequirement,
  describeSolShortfall,
  lamportsToSol,
} from '../src/services/solana/preflight.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const WSOL = 'So11111111111111111111111111111111111111112';
const TSLAX = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const NATIVE = '11111111111111111111111111111111';

describe('route mint collection', () => {
  it('collects every distinct mint a multi-hop route passes through', () => {
    const mints = collectRouteMints([
      { swapInfo: { inputMint: USDC, outputMint: JUP, label: 'a' } },
      { swapInfo: { inputMint: JUP, outputMint: WSOL, label: 'b' } },
      { swapInfo: { inputMint: WSOL, outputMint: TSLAX, label: 'c' } },
    ]);
    assert.deepEqual(mints, [USDC, JUP, WSOL, TSLAX]);
  });

  it('never counts native SOL, which needs no token account', () => {
    const mints = collectRouteMints([
      { swapInfo: { inputMint: USDC, outputMint: NATIVE, label: 'a' } },
    ]);
    assert.deepEqual(mints, [USDC]);
  });

  it('dedupes a mint used on both sides of several hops', () => {
    const mints = collectRouteMints([
      { swapInfo: { inputMint: USDC, outputMint: TSLAX } },
      { swapInfo: { inputMint: USDC, outputMint: TSLAX } },
    ]);
    assert.deepEqual(mints, [USDC, TSLAX]);
  });

  it('returns nothing for a missing or malformed route', () => {
    assert.deepEqual(collectRouteMints(undefined), []);
    assert.deepEqual(collectRouteMints(null), []);
    assert.deepEqual(collectRouteMints('nope'), []);
    assert.deepEqual(collectRouteMints([{ swapInfo: null }]), []);
  });
});

describe('SOL requirement for opening token accounts', () => {
  it('charges rent for the accounts the wallet does not own', () => {
    const req = computeSolRequirement({
      routeMintCount: 2,
      missingMints: [TSLAX],
      legacyRent: 1_488_440,
      token2022Rent: 1_666_240,
      availableLamports: 10_000_000,
    });
    assert.equal(req.requiredLamports, 1_488_440 + 1_666_240 + 10_000 + 2_000_000);
    assert.equal(req.shortfallLamports, 0);
  });

  it('reports a shortfall when the wallet cannot cover rent plus margin', () => {
    const req = computeSolRequirement({
      routeMintCount: 4,
      missingMints: [JUP, WSOL, TSLAX],
      legacyRent: 1_488_440,
      token2022Rent: 1_666_240,
      availableLamports: 1_954_407,
    });
    assert.equal(req.missingMints.length, 3);
    assert.ok(req.shortfallLamports > 0, 'a tight wallet must be told to top up');
  });

  it('adds rent per missing account on a multi-hop route', () => {
    const one = computeSolRequirement({
      routeMintCount: 2, missingMints: [TSLAX], legacyRent: 1_488_440, token2022Rent: 0, availableLamports: 0,
    });
    const three = computeSolRequirement({
      routeMintCount: 4,
      missingMints: [JUP, WSOL, TSLAX],
      legacyRent: 1_488_440 * 2,
      token2022Rent: 1_666_240,
      availableLamports: 0,
    });
    assert.ok(three.requiredLamports > one.requiredLamports);
  });

  it('never reports a negative shortfall', () => {
    const req = computeSolRequirement({
      routeMintCount: 1, missingMints: [], legacyRent: 0, token2022Rent: 0, availableLamports: 50_000_000,
    });
    assert.equal(req.shortfallLamports, 0);
  });
});

describe('the message the trader actually reads', () => {
  it('names the shortfall, the balance and the amount to add', () => {
    const req = computeSolRequirement({
      routeMintCount: 2, missingMints: [TSLAX], legacyRent: 0, token2022Rent: 1_666_240, availableLamports: 1_954_407,
    });
    const msg = describeSolShortfall(req, { buySymbol: 'TSLAx', solUsdPrice: '114.84' });
    assert.match(msg, /TSLAx/, 'must name what the swap is for');
    assert.match(msg, /add about/i, 'must tell the trader what to do');
    assert.match(msg, /\$/, 'must give a dollar figure when a price is known');
    assert.match(msg, /SOL/);
  });

  it('does not accuse a wallet that already holds enough', () => {
    const req = computeSolRequirement({
      routeMintCount: 1, missingMints: [], legacyRent: 0, token2022Rent: 0, availableLamports: 50_000_000,
    });
    const msg = describeSolShortfall(req, { buySymbol: 'TSLAx' });
    assert.doesNotMatch(msg, /add about/i);
    assert.match(msg, /covers it|no new accounts/i);
  });

  it('stays readable when no SOL price is available, without inventing one', () => {
    const req = computeSolRequirement({
      routeMintCount: 2, missingMints: [TSLAX], legacyRent: 0, token2022Rent: 1_666_240, availableLamports: 0,
    });
    const msg = describeSolShortfall(req, { buySymbol: 'TSLAx', solUsdPrice: null });
    assert.doesNotMatch(msg, /\$/, 'must not fabricate a dollar price');
    assert.match(msg, /SOL/);
  });

  it('converts lamports to SOL without float drift', () => {
    assert.equal(lamportsToSol(1_954_407), '0.001954');
    assert.equal(lamportsToSol(0), '0.000000');
    assert.equal(lamportsToSol(1_000_000_000), '1.000000');
  });
});
