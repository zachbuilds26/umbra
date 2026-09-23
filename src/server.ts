import { env } from './config/env.js';
import { buildApp } from './app.js';
import { migrate } from './db/pg.js';
import { startSampler } from './services/prices/history.js';

async function main(): Promise<void> {
  const app = await buildApp();
  // Postgres ledger when DATABASE_URL is set (Render); warns and continues on
  // memory otherwise. A failed migrate must not kill boot (quotes still serve).
  await migrate().catch((err: unknown) => {
    app.log.warn({ err }, 'db migrate skipped/failed — using in-memory ledger');
  });
  startSampler(); // tape history ring (harmless background task, never throws)
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`umbra-backend listening on :${env.PORT} (${env.NODE_ENV})`);
  } catch (err) {
    app.log.error(err, 'failed to start');
    process.exit(1);
  }
}

void main().catch((err: unknown) => {
  // buildApp() throws before `app` exists (handled listen errors already
  // exit(1) inside main); without this the boot rejection is unhandled and
  // the process hangs/crashes with no diagnostic on Render.
  console.error('fatal boot error', err);
  process.exit(1);
});
