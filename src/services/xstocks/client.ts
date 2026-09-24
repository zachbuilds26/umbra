import { env } from '../../config/env.js';
import { fetchJsonWithRetry } from '../../utils/http.js';

// Raw xStocks shapes (subset we use). Verified live 2026-09-18:
// - GET /public/assets/{symbol} -> { id, name, symbol, underlying: {symbol,isn,...}|null, deployments: [{address, network, ...}] }
// - GET /public/assets -> NOT a list endpoint in v2 (use per-symbol). We discover via bridge products.
// - GET /public/assets/{symbol}/price-data -> { quote: number }
// - GET /public/assets/{symbol}/multiplier?network=Solana -> { currentMultiplier, newMultiplier, activationDateTime, reason }
// - GET /public/bridges?destinationNetwork=Solana -> [{ address, network, chainId, managedBy, destinationNetworks, sourceNetworks, products: [{symbol, svmDecimals, evmDecimals, deployments}], chainConfig }]

export interface XstocksDeployment {
  address: string;
  network: string;
  chainId?: number;
}

export interface XstocksAssetRaw {
  id: string;
  name: string;
  symbol: string;
  logo?: string;
  underlying?: { symbol?: string; isin?: string; currency?: string } | null;
  underlyingSymbol?: string;
  deployments?: XstocksDeployment[];
}

export interface XstocksBridgeProduct {
  symbol: string;
  svmDecimals?: number;
  evmDecimals?: number;
  deployments?: XstocksDeployment[];
}

export interface XstocksBridgeRaw {
  address: string;
  network: string;
  chainId?: number;
  managedBy?: string;
  destinationNetworks?: string[];
  sourceNetworks?: string[];
  products?: XstocksBridgeProduct[];
  chainConfig?: Record<string, string>;
}

export class XstocksClient {
  readonly baseUrl: string;
  constructor(baseUrl: string = env.XSTOCKS_API_BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  // Display paths fail fast (6s, no retry): when Cloudflare blackholes us a retry
  // just doubles the stall. Route-level last-good caches cover the blips.
  async getAsset(symbol: string): Promise<{ data?: XstocksAssetRaw }> {
    const url = `${this.baseUrl}/public/assets/${encodeURIComponent(symbol)}`;
    const res = await fetchJsonWithRetry<XstocksAssetRaw>(url, { timeoutMs: 6000 }, 0);
    return { data: res.ok ? res.data : undefined };
  }

  async getPrice(symbol: string): Promise<{ quote?: number }> {
    const url = `${this.baseUrl}/public/assets/${encodeURIComponent(symbol)}/price-data`;
    const res = await fetchJsonWithRetry<{ quote: number }>(url, { timeoutMs: 6000 }, 0);
    return { quote: res.ok ? res.data?.quote : undefined };
  }

  async getMultiplier(symbol: string, network: string): Promise<{ currentMultiplier?: number }> {
    const url = `${this.baseUrl}/public/assets/${encodeURIComponent(symbol)}/multiplier?network=${encodeURIComponent(network)}`;
    const res = await fetchJsonWithRetry<{ currentMultiplier: number }>(url, { timeoutMs: 6000 }, 0);
    return { currentMultiplier: res.ok ? res.data?.currentMultiplier : undefined };
  }

  async getBridges(params: {
    destinationNetwork?: string;
    sourceNetwork?: string;
    network?: string;
  } = {}): Promise<{ status: number; data?: XstocksBridgeRaw[] }> {
    const qs = new URLSearchParams();
    if (params.destinationNetwork) qs.set('destinationNetwork', params.destinationNetwork);
    if (params.sourceNetwork) qs.set('sourceNetwork', params.sourceNetwork);
    if (params.network) qs.set('network', params.network);
    const url = `${this.baseUrl}/public/bridges${qs.size ? `?${qs}` : ''}`;
    const res = await fetchJsonWithRetry<XstocksBridgeRaw[]>(url, { timeoutMs: 15_000 }, 1);
    return { status: res.status, data: res.ok ? res.data : undefined };
  }
}

export const xstocksClient = new XstocksClient();
