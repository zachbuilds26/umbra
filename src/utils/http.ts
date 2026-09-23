import { sanitizeProviderMessage, HttpError } from './errors.js';

// fetch wrapper with timeout + safe error normalization (plan §30: timeout on all
// external HTTP requests, retry only where safe, sanitize provider errors).
export interface FetchResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  rawText: string;
  latencyMs: number;
}

export async function fetchJson<T>(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<FetchResult<T>> {
  const { timeoutMs = 10_000, ...init } = options;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Identify ourselves politely; some CDNs challenge UA-less bot traffic.
    const headers = new Headers(init.headers);
    if (!headers.has('user-agent')) headers.set('user-agent', 'Umbra-backend/0.1.0 (Stocklana-hackathon)');
    const res = await fetch(url, { ...init, headers, signal: controller.signal });
    const rawText = await res.text();
    let data: T | undefined;
    try {
      data = rawText ? (JSON.parse(rawText) as T) : undefined;
    } catch {
      data = undefined;
    }
    return { ok: res.ok, status: res.status, data, rawText: rawText.slice(0, 4000), latencyMs: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Throw typed 502s so routes return PROVIDER_ERROR, never INTERNAL (plan §27).
    throw new HttpError(502, 'PROVIDER_ERROR', sanitizeProviderMessage(`Upstream request failed: ${message}`));
  } finally {
    clearTimeout(timer);
  }
}

/** GET with up to `retries` retries on network errors / 5xx / 429. Never retries POSTs. */
export async function fetchJsonWithRetry<T>(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
  retries = 1,
): Promise<FetchResult<T>> {
  let last: FetchResult<T> | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchJson<T>(url, options);
      if (res.ok || (res.status < 500 && res.status !== 429)) return res;
      last = res;
    } catch (err) {
      if (attempt === retries) throw err;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return last!;
}
