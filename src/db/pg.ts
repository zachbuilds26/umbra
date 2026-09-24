import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { env } from '../config/env.js';

// Postgres client for Render (free Postgres). Local dev keeps the in-memory
// ledger: every store checks isPg() and falls back when DATABASE_URL is unset,
// so `npm run dev` needs no database at all.

export function isPg(): boolean {
  // Tests must never touch a real database. A developer's .env (or a leaked
  // DATABASE_URL in CI) would otherwise point the suite at production data and
  // make results depend on live rows.
  if (env.isTest) return false;
  return pgEnabled && env.DATABASE_URL.trim().length > 0;
}

let pool: Pool | null = null;
let migrateOnce: Promise<void> | null = null;
let pgEnabled = true;

/** Boot path: a failed migration must actually disable Postgres, otherwise every
 * ledger call keeps hitting a broken pool while the log claims memory. */
export function disablePg(reason: string): void {
  pgEnabled = false;
  console.warn(`[db] postgres disabled: ${reason}`);
}

function getPool(): Pool {
  if (pool) return pool;
  const local = env.DATABASE_URL.includes('localhost') || env.DATABASE_URL.includes('127.0.0.1');
  pool = new Pool({
    connectionString: env.DATABASE_URL,
    // Render's internal Postgres presents a cert the system roots don't chain;
    // the link never leaves Render's private network.
    ssl: local ? undefined : { rejectUnauthorized: false },
    max: 5,
    // Without these, a blackholed database hangs boot and requests forever.
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    idleTimeoutMillis: 10_000,
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
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        // Serialize across deploys/instances: two boots creating the same table
        // concurrently can still collide inside Postgres' catalog.
        await client.query("SELECT pg_advisory_xact_lock(hashtext('umbra:migrate'))");
        await client.query(sql);
        await client.query(
          'CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions (created_at DESC)',
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
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

export async function closePool(): Promise<void> {
  const current = pool;
  pool = null;
  if (current) await current.end();
}
