import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import compress from '@fastify/compress';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { HttpError, apiError } from './utils/errors.js';
import { newRequestId } from './utils/ids.js';
import { healthRoutes } from './routes/health.js';
import { assetRoutes } from './routes/assets.js';
import { swapRoutes } from './routes/swaps.js';
import { bridgeRoutes } from './routes/bridges.js';
import { walletRoutes } from './routes/wallet.js';
import { dbcRoutes } from './routes/dbc.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.isProd ? 'info' : 'debug',
    },
    // Behind Render's proxy (and any CDN), the socket IP is the proxy's.
    // Without this, req.ip is identical for every visitor and the per-IP
    // rate-limit bucket is shared globally — one page load can 429 everyone.
    trustProxy: true,
    requestIdHeader: 'x-request-id',
    genReqId: () => newRequestId(),
  });

  await app.register(cors, {
    origin: env.corsOrigins.length > 0 ? env.corsOrigins : false,
  });

  // gzip/deflate for everything textual (442KB lucide, index.html, JSON).
  // Big first-paint win on mobile data; images already compressed.
  await app.register(compress, { global: true });

  // Global generous limit; stricter per-route limits are set on the
  // quote/transaction routes themselves (plan §29).
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
    // NOTE: the plugin THROWS the builder's return value into the error
    // handler, so it must carry a statusCode. A plain apiError() object has
    // none and fell through to 500 INTERNAL (measured: limit exhaustion
    // returned 500s, never 429s). HttpError maps to a proper 429 + shape.
    errorResponseBuilder: () => new HttpError(429, 'RATE_LIMITED', 'Too many requests. Slow down and retry.'),
  });

  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id;
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send(apiError(err.code, err.message, err.details));
    }
    if (err instanceof ZodError) {
      return reply
        .status(400)
        .send(apiError('VALIDATION_ERROR', 'Invalid request.', { issues: err.issues.slice(0, 8) }));
    }
    if (typeof err === 'object' && err !== null && 'statusCode' in err && 'validation' in err) {
      return reply.status(400).send(apiError('VALIDATION_ERROR', 'Invalid request.'));
    }
    req.log.error({ err, requestId }, 'unhandled error');
    return reply.status(500).send(apiError('INTERNAL', 'Something went wrong.'));
  });

  // Uniform 404 envelope (default Fastify shape leaks the path and breaks the
  // client's {error:{code}} contract).
  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send(apiError('NOT_FOUND', `Route ${req.method}:${req.url} not found.`));
  });

  // Observability: structured provider-style log line per request (plan §31).
  app.addHook('onResponse', (req, reply, done) => {
    req.log.info(
      {
        requestId: req.id,
        method: req.method,
        url: req.url,
        status: reply.statusCode,
        latencyMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
    done();
  });

  // Per-area limits live on the routes themselves via `config.rateLimit`
  // (plan §29: assets generous, quotes/bridge moderate, transactions strict).
  await app.register(healthRoutes);
  await app.register(assetRoutes);
  await app.register(swapRoutes);
  await app.register(bridgeRoutes);
  await app.register(walletRoutes);
  await app.register(dbcRoutes);

  // Single-service deploy (Render free): the backend serves the frontend
  // bundle so API + app share one origin (no CORS, one sleep schedule).
  // Local dev is untouched (python :3000 still works). API routes above win;
  // static only answers paths no route claimed.
  const frontendDir = join(process.cwd(), 'frontend');
  if (existsSync(join(frontendDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: frontendDir,
      prefix: '/',
      index: ['index.html'],
      // Logos/bundle never change content without a deploy: cache a year.
      // index.html + JSON stay revalidating (default etag behavior).
      setHeaders: (reply, pathName) => {
        if (/\/assets\//.test(pathName)) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });
  }

  // NOTE: GET / serves frontend/index.html via the static plugin above
  // (single-service deploy). API contract lives in README.md.
  return app;
}
