import { Connection } from '@solana/web3.js';
import { env } from '../../config/env.js';

// Single shared RPC connection (plan Phase 3).
let connection: Connection | null = null;

/** Every RPC call gets a hard deadline. web3.js 1.x takes no fetch override, so
 * each call is raced against a timer — otherwise a stalled provider holds
 * wallet/balance/confirm requests open indefinitely. */
async function withDeadline<T>(label: string, timeoutMs: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function getConnection(): Connection {
  if (!connection) {
    connection = new Connection(env.SOLANA_RPC_URL, env.SOLANA_COMMITMENT);
  }
  return connection;
}

/**
 * Poll a signature until it reaches a terminal state or the budget runs out.
 *
 * `indeterminate` is deliberately distinct from `expired`: a provider timeout,
 * an RPC error, or a signature the chain has not indexed yet says nothing about
 * whether the transaction landed. Reporting that as "expired" wrote a false
 * failure into the ledger, and a late confirmation could then be discarded as
 * an illegal state change.
 */
export async function confirmSignature(
  signature: string,
  timeoutMs = 60_000,
): Promise<'confirmed' | 'failed' | 'indeterminate'> {
  const conn = getConnection();
  // timeoutMs=0 means "check once, right now" (used when reconciling a row a
  // previous process left in `submitted`) — no polling loop at all.
  const budget = Math.max(timeoutMs, 1);
  const deadline = Date.now() + budget;
  for (;;) {
    try {
      const parsed = await withDeadline('getSignatureStatus', Math.min(10_000, Math.max(budget, 1_000)), () =>
        conn.getSignatureStatus(signature, { searchTransactionHistory: true }),
      );
      const status = parsed.value;
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        return status.err ? 'failed' : 'confirmed';
      }
      if (status?.err) return 'failed';
    } catch {
      // Provider error or deadline: keep polling while budget remains. Running
      // out of budget is not evidence the transaction failed.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 'indeterminate';
    await new Promise((r) => setTimeout(r, Math.min(2_000, remaining)));
  }
}
