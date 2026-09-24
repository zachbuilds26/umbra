import type { UmbraTransaction, SwapTxStatus, BridgeTxStatus } from '../domain/models.js';
import { newTxId } from '../utils/ids.js';
import { isPg, pgQuery } from './pg.js';

// Transaction ledger (plan §26). Postgres when DATABASE_URL is set (Render),
// in-memory otherwise (local dev needs no database). Never stores keys/seeds.
//
// Ownership: every record carries the wallet it belongs to. Reads through the
// HTTP API are scoped to that wallet, so one visitor can never enumerate or
// read another visitor's amounts, signatures, or statuses.

const mem = new Map<string, UmbraTransaction>();
const MAX_MEMORY_ROWS = 1_000;

function now(): string {
  return new Date().toISOString();
}

type TxRow = Record<string, unknown>;

/** Postgres hands back Date objects for TIMESTAMPTZ; the API contract is ISO 8601. */
function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const raw = value === null || value === undefined ? '' : String(value);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return new Date(0).toISOString();
  return parsed.toISOString();
}

function str(v: unknown): string | undefined {
  return v === null || v === undefined ? undefined : String(v);
}
function nul(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

const SWAP_STATUSES: ReadonlySet<string> = new Set(['pending', 'submitted', 'confirmed', 'failed', 'expired']);
const BRIDGE_STATUSES: ReadonlySet<string> = new Set([
  'source_pending', 'source_confirmed', 'ccip_in_flight',
  'destination_pending', 'completed', 'failed',
]);

function normalizeStatus(type: string, value: unknown): SwapTxStatus | BridgeTxStatus {
  const raw = String(value ?? '');
  const allowed = type === 'bridge' ? BRIDGE_STATUSES : SWAP_STATUSES;
  if (allowed.has(raw)) return raw as SwapTxStatus | BridgeTxStatus;
  return type === 'bridge' ? 'source_pending' : 'pending';
}

/**
 * Legal status moves. Terminal states are final: a late confirmation callback or
 * a retry must never drag a finished transaction backwards, and an unfinished
 * one must never be declared finished by a weaker signal (a provider timeout is
 * not proof of failure).
 */
const SWAP_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  pending: new Set(['submitted', 'failed', 'expired']),
  submitted: new Set(['confirmed', 'failed', 'expired']),
  confirmed: new Set(),
  failed: new Set(),
  expired: new Set(),
};
const BRIDGE_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  source_pending: new Set(['source_confirmed', 'failed']),
  source_confirmed: new Set(['ccip_in_flight', 'failed']),
  ccip_in_flight: new Set(['destination_pending', 'completed', 'failed']),
  destination_pending: new Set(['completed', 'failed']),
  completed: new Set(),
  failed: new Set(),
};

function canTransition(type: string, from: string, to: string): boolean {
  if (from === to) return true;
  const table = type === 'bridge' ? BRIDGE_TRANSITIONS : SWAP_TRANSITIONS;
  return table[from]?.has(to) ?? false;
}

function rowToTx(r: TxRow): UmbraTransaction {
  const type = r.type === 'bridge' ? 'bridge' : 'swap';
  return {
    id: String(r.id),
    type,
    status: normalizeStatus(type, r.status),
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
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
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

function owns(tx: UmbraTransaction, wallet: string): boolean {
  return tx.sourceWallet === wallet || tx.destinationWallet === wallet;
}

function safeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 20;
  return Math.min(50, Math.max(1, Math.trunc(limit)));
}

function trimMemory(): void {
  if (mem.size <= MAX_MEMORY_ROWS) return;
  const byAge = [...mem.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const tx of byAge.slice(0, mem.size - MAX_MEMORY_ROWS)) mem.delete(tx.id);
}

export async function createTransaction(
  input: Omit<UmbraTransaction, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<UmbraTransaction> {
  const owner = input.sourceWallet ?? input.destinationWallet;
  // A swap with no wallet attached could never be shown to, or secured by, its
  // owner — refuse rather than write an orphan row.
  if (!owner) {
    throw new Error('createTransaction requires sourceWallet or destinationWallet');
  }
  const tx: UmbraTransaction = {
    ...input,
    status: normalizeStatus(input.type, input.status),
    id: newTxId(),
    createdAt: now(),
    updatedAt: now(),
  };
  if (!isPg()) {
    // Same signature twice = one ledger row, so a retried POST can't duplicate.
    if (tx.signature) {
      for (const existing of mem.values()) {
        if (existing.signature && existing.signature === tx.signature) return { ...existing };
      }
    }
    mem.set(tx.id, tx);
    trimMemory();
    return { ...tx };
  }
  const rows = await pgQuery<TxRow>(
    `INSERT INTO transactions (${COLUMNS}) VALUES
     ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (signature) WHERE signature IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      tx.id, tx.type, tx.status, tx.sourceNetwork ?? null, tx.destinationNetwork ?? null,
      tx.sourceAsset ?? null, tx.destinationAsset ?? null, tx.sourceAmount ?? null,
      tx.destinationAmount ?? null, tx.sourceWallet ?? null, tx.destinationWallet ?? null,
      tx.providerReference ?? null, tx.sourceTxHash ?? null, tx.destinationTxHash ?? null,
      tx.ccipMessageId ?? null, tx.signature ?? null, tx.errorCode ?? null,
      tx.errorMessage ?? null, tx.createdAt, tx.updatedAt,
    ],
  );
  const inserted = rows[0];
  if (inserted) return rowToTx(inserted);
  const existing = await pgQuery<TxRow>('SELECT * FROM transactions WHERE signature = $1', [tx.signature]);
  return existing[0] ? rowToTx(existing[0]) : tx;
}

export async function getTransaction(id: string, ownerWallet?: string): Promise<UmbraTransaction | undefined> {
  if (!isPg()) {
    const found = mem.get(id);
    if (!found) return undefined;
    if (ownerWallet && !owns(found, ownerWallet)) return undefined;
    return { ...found };
  }
  const rows = ownerWallet
    ? await pgQuery<TxRow>(
        'SELECT * FROM transactions WHERE id = $1 AND (source_wallet = $2 OR destination_wallet = $2)',
        [id, ownerWallet],
      )
    : await pgQuery<TxRow>('SELECT * FROM transactions WHERE id = $1', [id]);
  const row = rows[0];
  return row ? rowToTx(row) : undefined;
}

export async function updateTransaction(
  id: string,
  patch: Partial<Pick<UmbraTransaction, 'status' | 'destinationTxHash' | 'destinationAmount' | 'ccipMessageId' | 'errorCode' | 'errorMessage' | 'sourceTxHash' | 'providerReference'>>,
  ownerWallet?: string,
): Promise<UmbraTransaction | undefined> {
  const current = await getTransaction(id, ownerWallet);
  if (!current) return undefined;
  // Reject an illegal move before touching storage: a late confirmation callback
  // must not overwrite a finished transaction, and a retry must not resurrect one.
  if (patch.status !== undefined) {
    const next = normalizeStatus(current.type, patch.status);
    if (!canTransition(current.type, current.status, next)) {
      return current;
    }
  }
  if (!isPg()) {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const updated: UmbraTransaction = {
      ...current,
      ...defined,
      status: patch.status === undefined
        ? current.status
        : normalizeStatus(current.type, patch.status),
      updatedAt: now(),
    };
    mem.set(id, updated);
    return { ...updated };
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, col] of Object.entries(PATCH_COLS)) {
    const v = (patch as Record<string, unknown>)[key];
    if (v !== undefined) {
      vals.push((v as string | null) ?? null);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (sets.length === 0) return current;
  sets.push('updated_at = now()');
  // Placeholders are numbered in the same order the values are appended, so the
  // owner filter is added before the id. Numbering the id first compared the id
  // column against the wallet value.
  const filters: string[] = [];
  if (ownerWallet) {
    vals.push(ownerWallet);
    filters.push(`(source_wallet = $${vals.length} OR destination_wallet = $${vals.length})`);
  }
  // Compare-and-set on the status we just read, so a concurrent writer that
  // moved the row first makes this update a no-op instead of a lost update.
  vals.push(current.status);
  filters.push(`status = $${vals.length}`);
  vals.push(id);
  filters.push(`id = $${vals.length}`);
  const rows = await pgQuery<TxRow>(
    `UPDATE transactions SET ${sets.join(', ')} WHERE ${filters.join(' AND ')} RETURNING *`,
    vals,
  );
  const row = rows[0];
  if (row) return rowToTx(row);
  // Someone else changed it first: report their state, never overwrite it.
  return getTransaction(id, ownerWallet);
}

export async function listTransactions(limit = 20, ownerWallet?: string): Promise<UmbraTransaction[]> {
  const capped = safeLimit(limit);
  if (!isPg()) {
    return [...mem.values()]
      .filter((tx) => !ownerWallet || owns(tx, ownerWallet))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, capped)
      .map((tx) => ({ ...tx }));
  }
  const rows = ownerWallet
    ? await pgQuery<TxRow>(
        `SELECT * FROM transactions WHERE (source_wallet = $1 OR destination_wallet = $1)
         ORDER BY created_at DESC, id DESC LIMIT $2`,
        [ownerWallet, capped],
      )
    : await pgQuery<TxRow>('SELECT * FROM transactions ORDER BY created_at DESC, id DESC LIMIT $1', [capped]);
  return rows.map(rowToTx);
}

export type { SwapTxStatus, BridgeTxStatus };
