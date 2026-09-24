// Consistent API error shape per plan §27. Never leak provider secrets or keys.
export type ErrorCode =
  | 'INVALID_ADDRESS'
  | 'UNSUPPORTED_ASSET'
  | 'UNSUPPORTED_NETWORK'
  | 'UNSUPPORTED_BRIDGE_ROUTE'
  | 'BRIDGE_CONFIG_UNAVAILABLE'
  | 'FEATURE_UNAVAILABLE'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_UNAVAILABLE'
  | 'NO_ROUTE'
  | 'SWAP_UNAVAILABLE'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'INSUFFICIENT_BALANCE'
  | 'TRANSACTION_EXPIRED'
  | 'TRANSACTION_FAILED'
  | 'RPC_ERROR'
  | 'PROVIDER_ERROR'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'INTERNAL';

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function apiError(code: ErrorCode, message: string, details?: Record<string, unknown>): ApiErrorBody {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(statusCode: number, code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
  new HttpError(400, code, message, details);
export const notFound = (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
  new HttpError(404, code, message, details);
export const upstream = (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
  new HttpError(502, code, message, details);
export const serviceUnavailable = (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
  new HttpError(503, code, message, details);

/** Strip anything that looks like a secret before logging / returning provider errors. */
export function sanitizeProviderMessage(msg: string): string {
  return msg
    .replace(/x-api-key[^,}\s]*/gi, 'x-api-key=[redacted]')
    // JSON-quoted form too: {"apiKey":"secret"} leaked past the bare regex.
    .replace(
      /((?:x-)?api[_-]?key|access[_-]?token|authorization|secret|password)\s*["']?\s*[:=]\s*["']?[^"',}\s]+/gi,
      '$1=[redacted]',
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/g, '$1[redacted]')
    .slice(0, 500);
}
