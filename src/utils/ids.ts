import { randomUUID } from 'node:crypto';

export function newQuoteId(prefix: 'umbra_q' | 'umbra_bq' = 'umbra_q'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function newTxId(): string {
  return `tx_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function newRequestId(): string {
  return `umbra_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}
