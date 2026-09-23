import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeUnavailableSources } from '../src/services/bridge/bridge-config.service.js';
import type { XstocksBridgeRaw } from '../src/services/xstocks/client.js';

const entry = (network: string, toSolana: boolean): XstocksBridgeRaw => ({
  address: '0x9ec0e4a4c411493773e01e2abf4d42395788846b',
  network,
  managedBy: 'ChainlinkCCIP',
  destinationNetworks: toSolana ? ['Ethereum', 'Solana'] : ['Ethereum', 'Arbitrum'],
  sourceNetworks: toSolana ? ['Ethereum', 'Solana'] : ['Ethereum', 'Arbitrum'],
  products: [],
});

describe('bridge source coverage', () => {
  it('lists mesh chains missing Solana as unavailable (never as routes)', () => {
    const all = [entry('Ethereum', true), entry('Mantle', false), entry('Solana', false)];
    const toSolana = [entry('Ethereum', true)];
    const unavailable = computeUnavailableSources(all, toSolana);
    assert.deepEqual(unavailable.map((u) => u.network), ['Mantle']);
    assert.match(unavailable[0]?.reason ?? '', /does not currently enable/);
  });

  it('never lists Solana itself as a source', () => {
    const unavailable = computeUnavailableSources([entry('Solana', false)], []);
    assert.deepEqual(unavailable, []);
  });

  it('is empty when every mesh chain can send to Solana', () => {
    const all = [entry('Ethereum', true), entry('Mantle', true)];
    assert.deepEqual(computeUnavailableSources(all, all), []);
  });

  it('dedupes repeated entries', () => {
    const unavailable = computeUnavailableSources([entry('Mantle', false), entry('Mantle', false)], []);
    assert.equal(unavailable.length, 1);
  });
});
