import { sanitizeProviderMessage, HttpError } from './errors.js';

// fetch wrapper with timeout + safe error normalization (plan §30: timeout on all
// external HTTP requests, retry only where safe, sanitize provider errors).
export interface FetchResult<T> {
  ok: boolean;
  status: number;
  data?: T;
}

export async function fetchJson<T>(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<FetchResult<T>> {
  const { timeoutMs = 10_000, ...init } = options;
  const controller = new AbortController();
  // Caller cancellation must survive: a caller signal aborts us too.
  const onCallerAbort = () => controller.abort();
  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Identify ourselves politely; some CDNs challenge UA-less bot traffic.
    const headers = new Headers(init.headers);
    if (!headers.has('user-agent')) headers.set('user-agent', 'Umbra-backend/0.1.0 (Umbra)');
    const res = await fetch(url, { ...init, headers, signal: controller.signal });
    const rawText = await res.text();
    let data: T | undefined;
    try {
      data = rawText ? (JSON.parse(rawText) as T) : undefined;
    } catch {
      data = undefined;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    // The raw transport text (aborted, socket hang up, DNS) is logged for us,
    // never returned: it means nothing to an end user and leaks internals.
    const raw = err instanceof Error ? err.message : String(err);
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[http] ${new URL(url).host} ${init.method ?? 'GET'} failed: ${sanitizeProviderMessage(raw)}`);
    }
    throw new HttpError(502, 'PROVIDER_ERROR', 'Our data provider did not respond.');
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/** GET/HEAD with up to `retries` retries on network errors / 5xx / 429. Never retries
 * anything with side effects, whatever the caller passes. */
export async function fetchJsonWithRetry<T>(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
  retries = 1,
): Promise<FetchResult<T>> {
  if (!Number.isInteger(retries) || retries < 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'retries must be a non-negative integer.');
  }
  const method = (options.method ?? 'GET').toUpperCase();
  const attempts = method === 'GET' || method === 'HEAD' ? retries : 0;
  let last: FetchResult<T> | undefined;
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      const res = await fetchJson<T>(url, options);
      if (res.ok || (res.status < 500 && res.status !== 429)) return res;
      last = res;
    } catch (err) {
      if (attempt === attempts) throw err;
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  if (!last) throw new HttpError(502, 'PROVIDER_ERROR', 'Upstream request failed.');
  return last;
}
