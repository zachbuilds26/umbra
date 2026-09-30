import { createHmac } from 'node:crypto';
import { Resolver, lookup as defaultLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { env } from '../../config/env.js';
import { HttpError, badRequest, sanitizeProviderMessage } from '../../utils/errors.js';

// Binance Web3 API signed client (BSC tokenized-stocks leg).
//
// Auth: every request carries X-OC-APIKEY + X-OC-TIMESTAMP (ISO 8601, ms) +
// X-OC-SIGN (Base64 HMAC-SHA256 over `timestamp + METHOD + requestPath + body`,
// where requestPath INCLUDES the `/build` prefix and the raw query string).
// Docs: https://web3.binance.com/en/dev-docs/authentication
//
// The secret never leaves this module. Nothing here is importable by the
// frontend: the browser only ever talks to our own /api/bsc/* routes.

export const BSC_CHAIN_ID = '56';

// Optional DNS override. Node's fetch (undici) resolves through the OS
// (getaddrinfo), which ignores dns.setServers — so when the override is set
// we resolve via a dedicated Resolver and hand the address to node:https
// through a custom `lookup`. Without the override, default OS resolution.
const dnsOverride = env.BINANCE_DNS_SERVERS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const dnsResolver = dnsOverride.length > 0 ? new Resolver() : null;
if (dnsResolver) dnsResolver.setServers(dnsOverride);

type LookupCb = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;

function binanceLookup(hostname: string, options: unknown, callback: LookupCb): void {
  // Node ≥20 enables autoSelectFamily by default: the socket layer then calls
  // lookup with `all: true` and expects an array of {address, family}. Answer
  // that shape too, or every connect dies with "Invalid IP address".
  const wantAll = typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
  const done = (address: string, family: number): void => {
    if (wantAll) {
      (callback as unknown as (err: null, addresses: { address: string; family: number }[]) => void)(null, [
        { address, family },
      ]);
    } else {
      callback(null, address, family);
    }
  };
  const fail = (err: NodeJS.ErrnoException): void => {
    if (wantAll) {
      (callback as unknown as (err: NodeJS.ErrnoException) => void)(err);
    } else {
      callback(err, '', 4);
    }
  };
  if (!dnsResolver) {
    defaultLookup(hostname, (err, address, family) => {
      if (err) fail(err);
      else done(address, family);
    });
    return;
  }
  dnsResolver.resolve4(hostname, (err4, v4) => {
    const first4 = Array.isArray(v4) ? v4[0] : undefined;
    if (!err4 && typeof first4 === 'string' && first4.length > 0) {
      done(first4, 4);
      return;
    }
    dnsResolver.resolve6(hostname, (err6, v6) => {
      const first6 = Array.isArray(v6) ? v6[0] : undefined;
      if (!err6 && typeof first6 === 'string' && first6.length > 0) done(first6, 6);
      else fail((err4 ?? err6) as NodeJS.ErrnoException);
    });
  });
}

interface BinanceTransport {
  status: number;
  text: string;
}

/** Minimal node:https GET/POST with timeout + override-aware DNS. */
function binanceFetch(url: string, args: { method: 'GET' | 'POST'; headers: Record<string, string>; body: string; timeoutMs: number }): Promise<BinanceTransport> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: args.method, headers: args.headers, lookup: binanceLookup, timeout: args.timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (args.method === 'POST') req.write(args.body);
    req.end();
  });
}

export function isBinanceEnabled(): boolean {
  return env.BINANCE_API_KEY.length > 0 && env.BINANCE_API_SECRET.length > 0;
}

/** Current UTC time in the exact ISO 8601 ms format the gateway validates. */
export function binanceTimestamp(now: Date = new Date()): string {
  return now.toISOString();
}

/**
 * Pure signer (exported for tests). `requestPath` must be the exact wire path
 * INCLUDING the `/build` prefix plus the raw (still percent-encoded) query
 * string; `body` is the raw POST JSON string, or '' for GET.
 */
export function signBinanceRequest(args: {
  secret: string;
  timestamp: string;
  method: 'GET' | 'POST';
  requestPath: string;
  body: string;
}): string {
  const prehash = args.timestamp + args.method + args.requestPath + args.body;
  return createHmac('sha256', args.secret).update(prehash, 'utf8').digest('base64');
}

/** Encode query params exactly as they will appear on the wire (%20, not +). */
export function encodeQuery(params: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.join('&');
}

interface BinanceEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T;
  [key: string]: unknown;
}

function baseUrl(): string {
  return env.BINANCE_BASE_URL.replace(/\/$/, '');
}

/** Map a Binance business code to our own error contract (never leak `msg`). */
export function mapBinanceCode(code: number): HttpError {
  switch (code) {
    case 40101: // API key missing / invalid / disabled
    case 40102: // signature mismatch
    case 40104: // key lacks permission
      // Our credentials, our problem: 503, never a user-facing 401.
      return new HttpError(503, 'PROVIDER_ERROR', 'Pricing service unavailable.');
    case 40103: // timestamp expired / replayed
      return new HttpError(503, 'PROVIDER_ERROR', 'Pricing service unavailable.');
    case 42900:
      return new HttpError(429, 'RATE_LIMITED', 'Too many requests. Slow down and retry.');
    case 40001: // PARAM_ERROR
      return badRequest('VALIDATION_ERROR', 'Invalid request.');
    case 40401: // QUOTE_EXPIRED
      return badRequest('QUOTE_EXPIRED', 'Quote expired. Request a fresh quote.');
    case 40462: // SWAP_QUOTE_MISMATCH
      return badRequest('QUOTE_EXPIRED', 'Quote changed. Request a fresh quote.');
    case 40367: // Ondo outside market hours
    case 40369: // BStock outside market hours
      return badRequest('SWAP_UNAVAILABLE', 'Market closed for this token right now.');
    default:
      return new HttpError(502, 'PROVIDER_ERROR', 'Our data provider did not respond.');
  }
}

async function requestBinance<T>(method: 'GET' | 'POST', path: string, params: Record<string, string | undefined>, bodyObj?: unknown): Promise<T> {
  if (!isBinanceEnabled()) {
    throw new HttpError(503, 'FEATURE_UNAVAILABLE', 'BSC leg is not configured.');
  }
  const query = encodeQuery(params);
  // The signed path carries the /build prefix exactly as it goes on the wire.
  const requestPath = `/build${path}${query ? `?${query}` : ''}`;
  const body = method === 'POST' ? JSON.stringify(bodyObj ?? {}) : '';
  const timestamp = binanceTimestamp();
  const sign = signBinanceRequest({
    secret: env.BINANCE_API_SECRET,
    timestamp,
    method,
    requestPath,
    body,
  });
  const url = `${baseUrl()}${path}${query ? `?${query}` : ''}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-OC-APIKEY': env.BINANCE_API_KEY,
    'X-OC-TIMESTAMP': timestamp,
    'X-OC-SIGN': sign,
    'X-OC-RECV-WINDOW': String(env.BINANCE_RECV_WINDOW),
  };
  // GET-only retry on transport failure / 5xx / 429 (house rule: never retry
  // anything with side effects; every call here is a read or a quote).
  let lastStatus = 0;
  for (let attempt = 0; attempt <= 1; attempt++) {
    let res: BinanceTransport;
    try {
      res = await binanceFetch(url, { method, headers, body, timeoutMs: 15_000 });
    } catch (err) {
      if (attempt === 1) {
        if (process.env.NODE_ENV !== 'test') {
          const raw = err instanceof Error ? err.message : String(err);
          console.warn(`[binance] transport failed: ${sanitizeProviderMessage(raw)}`);
        }
        throw new HttpError(502, 'PROVIDER_ERROR', 'Our data provider did not respond.');
      }
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    lastStatus = res.status;
    if ((res.status >= 500 || res.status === 429) && attempt === 0) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    return parseBinanceResponse<T>(res.status, res.text);
  }
  if (lastStatus === 429) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Slow down and retry.');
  throw new HttpError(502, 'PROVIDER_ERROR', 'Our data provider did not respond.');
}

function parseBinanceResponse<T>(status: number, text: string): T {
  let envelope: BinanceEnvelope<T> | undefined;
  if (status >= 200 && status < 300 && text) {
    try {
      envelope = JSON.parse(text) as BinanceEnvelope<T>;
    } catch {
      envelope = undefined;
    }
  }
  if (envelope === undefined) {
    if (status === 429) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Slow down and retry.');
    if (status === 401 || status === 403) {
      throw new HttpError(503, 'PROVIDER_ERROR', 'Pricing service unavailable.');
    }
    throw new HttpError(502, 'PROVIDER_ERROR', 'Our data provider did not respond.');
  }
  const code = typeof envelope.code === 'number' ? envelope.code : 0;
  if (code !== 0) {
    // Log the provider's own words for us; the mapped error is what ships.
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[binance] business error ${code}: ${sanitizeProviderMessage(String(envelope.msg ?? ''))}`);
    }
    throw mapBinanceCode(code);
  }
  return envelope.data as T;
}

export function binanceGet<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  return requestBinance<T>('GET', path, params);
}

export function binancePost<T>(path: string, params: Record<string, string | undefined> = {}, bodyObj?: unknown): Promise<T> {
  return requestBinance<T>('POST', path, params, bodyObj);
}
