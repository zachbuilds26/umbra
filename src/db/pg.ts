import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { env } from '../config/env.js';

// Postgres client for Render (free Postgres). Local dev keeps the in-memory
// ledger: every store checks isPg() and falls back when DATABASE_URL is unset,
// so `npm run dev` needs no database at all.

export function isPg(): boolean {
  return env.DATABASE_URL.trim().length > 0;
}

let pool: Pool | null = null;
let migrateOnce: Promise<void> | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const local = env.DATABASE_URL.includes('localhost') || env.DATABASE_URL.includes('127.0.0.1');
  pool = new Pool({
    connectionString: env.DATABASE_URL,
    ssl: local ? undefined : { rejectUnauthorized: false },
    max: 5,
  });
  pool.on('error', () => {
    // Idle-client errors are logged by callers; the pool replaces the client.
  });
  return pool;
}

function schemaPath(): string {
  // Works from tsx (repo root) and from dist/ (compiled output).
  const candidates = [
    join(process.cwd(), 'src', 'db', 'schema.sql'),
    join(process.cwd(), 'dist', 'db', 'schema.sql'),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      // try next
    }
  }
  throw new Error('schema.sql not found (looked in src/db and dist/db)');
}

/** Apply schema.sql once per boot. Call from server startup; logs, never throws. */
export async function migrate(): Promise<void> {
  if (!isPg()) return;
  if (!migrateOnce) {
    migrateOnce = (async () => {
      const sql = readFileSync(schemaPath(), 'utf-8');
      await getPool().query(sql);
      await getPool().query(
        'CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions (created_at DESC)',
      );
    })().catch((err: unknown) => {
      migrateOnce = null;
      throw err;
    });
  }
  return migrateOnce;
}

export async function pgQuery<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await getPool().query(text, params as unknown[]);
  return res.rows as T[];
}
