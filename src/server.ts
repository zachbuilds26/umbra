import { env } from './config/env.js';
import { buildApp } from './app.js';
import { migrate, disablePg, closePool } from './db/pg.js';
import { startSampler } from './services/prices/history.js';

async function main(): Promise<void> {
  const app = await buildApp();
  // Postgres ledger when DATABASE_URL is set (Render); warns and continues on
  // memory otherwise. A failed migrate must not kill boot (quotes still serve)
  // but must genuinely disable Postgres, or every ledger call hits a dead pool.
  await migrate().catch((err: unknown) => {
    disablePg(err instanceof Error ? err.message : String(err));
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
  // Render redeploys and free-tier evictions send SIGTERM: drain in-flight
  // requests and close the pool instead of dropping sockets mid-request.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void (async () => {
        await app.close();
        await closePool();
        process.exit(0);
      })().catch(() => process.exit(1));
    });
  }
  // Self-prime on boot (fire-and-forget): fill directory + tape caches so the
  // first visitor after a sleep/wake or deploy doesn't pay the full cold cost
  // (xStocks stalls + Jupiter pacing). Never throws, never blocks listen.
  void (async () => {
    try {
      const base = `http://127.0.0.1:${env.PORT}`;
      const assets: { assets?: Array<{ symbol: string }> } = await fetch(`${base}/api/assets`).then((r) =>
        r.ok ? (r.json() as Promise<{ assets?: Array<{ symbol: string }> }>) : {},
      ).catch(() => ({}));
      void assets;
      await fetch(
        `${base}/api/assets/ticker?symbols=NVDAx,AAPLx,TSLAx,MSFTx,AMZNx,GOOGLx,METAx,SPYx,QQQx,TSMx,AVGOx,AMDx,PLTRx,COINx,HOODx,MSTRx,GLDx,SPACEX,OPENAI,ANTHROPIC,NEURALINK,ANDURIL,KALSHI,POLYMARKET,FIGUREAI`,
      ).catch(() => undefined);
    } catch {
      // caches warm on first visitor instead
    }
  })();
}

void main().catch((err: unknown) => {
  // buildApp() throws before `app` exists (handled listen errors already
  // exit(1) inside main); without this the boot rejection is unhandled and
  // the process hangs/crashes with no diagnostic on Render.
  console.error('fatal boot error', err);
  process.exit(1);
});
