import { Connection } from '@solana/web3.js';
import { env } from '../../config/env.js';

// Single shared RPC connection (plan Phase 3).
let connection: Connection | null = null;

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(env.SOLANA_RPC_URL, env.SOLANA_COMMITMENT);
  }
  return connection;
}

export async function confirmSignature(signature: string, timeoutMs = 60_000): Promise<'confirmed' | 'failed' | 'expired'> {
  const conn = getConnection();
  try {
    const parsed = await conn.getSignatureStatus(signature, { searchTransactionHistory: true });
    const status = parsed.value;
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return status.err ? 'failed' : 'confirmed';
    }
  } catch {
    // fall through to polling
  }
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const parsed = await conn.getSignatureStatus(signature, { searchTransactionHistory: true });
      const status = parsed.value;
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        return status.err ? 'failed' : 'confirmed';
      }
    } catch {
      // keep polling
    }
  }
  return 'expired';
}
