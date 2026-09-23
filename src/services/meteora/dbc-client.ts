import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import type { Commitment } from '@solana/web3.js';
import { getConnection } from '../solana/connection.js';

// Single shared DBC client. The dynamic_bonding_curve program ID is identical
// on mainnet and devnet (dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN), so the
// active network follows SOLANA_RPC_URL — no extra config, no custody: the
// client only reads state and builds transactions, it never holds keys.
let client: DynamicBondingCurveClient | null = null;

export function getDbcClient(): DynamicBondingCurveClient {
  if (!client) {
    const commitment = (process.env.SOLANA_COMMITMENT ?? 'confirmed') as Commitment;
    client = DynamicBondingCurveClient.create(getConnection(), commitment);
  }
  return client;
}
