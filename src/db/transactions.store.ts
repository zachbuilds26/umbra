import type { UmbraTransaction, SwapTxStatus, BridgeTxStatus } from '../domain/models.js';
import { newTxId } from '../utils/ids.js';
import { isPg, pgQuery } from './pg.js';

// Transaction ledger (plan §26). Postgres when DATABASE_URL is set (Render),
// in-memory otherwise (local dev needs no database). Never stores keys/seeds.

const mem = new Map<string, UmbraTransaction>();

function now(): string {
  return new Date().toISOString();
}

type TxRow = Record<string, string | null>;

function rowToTx(r: TxRow): UmbraTransaction {
  const str = (v: string | null | undefined): string | undefined =>
    v === null || v === undefined ? undefined : String(v);
  const nul = (v: string | null | undefined): string | null =>
    v === null || v === undefined ? null : String(v);
  return {
    id: String(r.id),
    type: r.type === 'bridge' ? 'bridge' : 'swap',
    status: String(r.status) as UmbraTransaction['status'],
    sourceNetwork: str(r.source_network),
    destinationNetwork: str(r.destination_network),
    sourceAsset: str(r.source_asset),
    destinationAsset: str(r.destination_asset),
    sourceAmount: str(r.source_amount),
    destinationAmount: nul(r.destination_amount),
    sourceWallet: str(r.source_wallet),
    destinationWallet: str(r.destination_wallet),
    providerReference: nul(r.provider_reference),
    sourceTxHash: nul(r.source_tx_hash),
    destinationTxHash: nul(r.destination_tx_hash),
    ccipMessageId: nul(r.ccip_message_id),
    signature: nul(r.signature),
    errorCode: nul(r.error_code),
    errorMessage: nul(r.error_message),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

const COLUMNS = [
  'id', 'type', 'status', 'source_network', 'destination_network', 'source_asset',
  'destination_asset', 'source_amount', 'destination_amount', 'source_wallet',
  'destination_wallet', 'provider_reference', 'source_tx_hash', 'destination_tx_hash',
  'ccip_message_id', 'signature', 'error_code', 'error_message', 'created_at', 'updated_at',
].join(', ');

const PATCH_COLS: Record<string, string> = {
  status: 'status',
  destinationTxHash: 'destination_tx_hash',
  destinationAmount: 'destination_amount',
  ccipMessageId: 'ccip_message_id',
  errorCode: 'error_code',
  errorMessage: 'error_message',
  sourceTxHash: 'source_tx_hash',
  providerReference: 'provider_reference',
};

export async function createTransaction(
  input: Omit<UmbraTransaction, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<UmbraTransaction> {
  const tx: UmbraTransaction = {
    ...input,
    id: newTxId(),
    createdAt: now(),
    updatedAt: now(),
  };
  if (!isPg()) {
    mem.set(tx.id, tx);
    return tx;
  }
  await pgQuery(
    `INSERT INTO transactions (${COLUMNS}) VALUES
     ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      tx.id, tx.type, tx.status, tx.sourceNetwork ?? null, tx.destinationNetwork ?? null,
      tx.sourceAsset ?? null, tx.destinationAsset ?? null, tx.sourceAmount ?? null,
      tx.destinationAmount ?? null, tx.sourceWallet ?? null, tx.destinationWallet ?? null,
      tx.providerReference ?? null, tx.sourceTxHash ?? null, tx.destinationTxHash ?? null,
      tx.ccipMessageId ?? null, tx.signature ?? null, tx.errorCode ?? null,
      tx.errorMessage ?? null, tx.createdAt, tx.updatedAt,
    ],
  );
  return tx;
}

export async function getTransaction(id: string): Promise<UmbraTransaction | undefined> {
  if (!isPg()) return mem.get(id);
  const rows = await pgQuery<TxRow>('SELECT * FROM transactions WHERE id = $1', [id]);
  const row = rows[0];
  return row ? rowToTx(row) : undefined;
}

export async function updateTransaction(
  id: string,
  patch: Partial<Pick<UmbraTransaction, 'status' | 'destinationTxHash' | 'destinationAmount' | 'ccipMessageId' | 'errorCode' | 'errorMessage' | 'sourceTxHash' | 'providerReference'>>,
): Promise<UmbraTransaction | undefined> {
  if (!isPg()) {
    const existing = mem.get(id);
    if (!existing) return undefined;
    const updated: UmbraTransaction = {
      ...existing,
      ...patch,
      status: (patch.status ?? existing.status) as UmbraTransaction['status'],
      updatedAt: now(),
    };
    mem.set(id, updated);
    return updated;
  }
  const sets: string[] = ['updated_at = now()'];
  const vals: unknown[] = [];
  for (const [key, col] of Object.entries(PATCH_COLS)) {
    const v = (patch as Record<string, unknown>)[key];
    if (v !== undefined) {
      vals.push((v as string | null) ?? null);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (sets.length === 1) {
    return getTransaction(id);
  }
  vals.push(id);
  const rows = await pgQuery<TxRow>(
    `UPDATE transactions SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
    vals,
  );
  const row = rows[0];
  return row ? rowToTx(row) : undefined;
}

export async function listTransactions(limit = 50): Promise<UmbraTransaction[]> {
  if (!isPg()) {
    return [...mem.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }
  const rows = await pgQuery<TxRow>(
    'SELECT * FROM transactions ORDER BY created_at DESC LIMIT $1',
    [Math.min(Math.max(limit, 1), 50)],
  );
  return rows.map(rowToTx);
}

export type { SwapTxStatus, BridgeTxStatus };
