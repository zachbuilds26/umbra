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
    // Fastify's own client errors (malformed JSON, unsupported media type,
    // body over the limit) arrive with only a statusCode. Without this they
    // became 500s, hiding a bad request from the user as a server fault.
    if (typeof err === 'object' && err !== null && 'statusCode' in err && typeof err.statusCode === 'number') {
      const status = err.statusCode;
      if (status === 413) {
        return reply.status(413).send(apiError('VALIDATION_ERROR', 'Request body is too large.'));
      }
      if (status === 415) {
        return reply.status(415).send(apiError('VALIDATION_ERROR', 'Unsupported content type.'));
      }
      if (status >= 400 && status < 500) {
        return reply.status(status).send(apiError('VALIDATION_ERROR', 'Invalid request.'));
      }
    }
    req.log.error({ err, requestId }, 'unhandled error');
    return reply.status(500).send(apiError('INTERNAL', 'Something went wrong.'));
  });

  // Baseline hardening. The app must keep loading its inline scripts and the
  // ESM CDN, so CSP stays permissive on script/style; the rest costs nothing.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (env.isProd) reply.header('Strict-Transport-Security', 'max-age=31536000');
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
      // Never publish dotfiles: a .env or editor backup dropped in frontend/
      // is downloadable by URL regardless of .gitignore.
      dotfiles: 'deny',
      // Asset filenames are stable, not fingerprinted, so a year-long
      // immutable cache would pin visitors to last deploy's logo/script.
      // One day is a real win and still revalidates on every deploy after.
      setHeaders: (reply, pathName) => {
        const normalized = pathName.replace(/\\/g, '/');
        if (normalized.includes('/assets/')) {
          reply.header('Cache-Control', 'public, max-age=86400');
        } else {
          reply.header('Cache-Control', 'public, max-age=0, must-revalidate');
        }
      },
    });
  }

  // NOTE: GET / serves frontend/index.html via the static plugin above
  // (single-service deploy). API contract lives in README.md.
  return app;
}
