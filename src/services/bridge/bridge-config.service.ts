import { TtlCache } from '../../utils/cache.js';
import { xstocksClient, type XstocksBridgeRaw } from '../xstocks/client.js';
import { serviceUnavailable, HttpError } from '../../utils/errors.js';
import type { UmbraBridgeRoute } from '../../domain/models.js';

// Plan §17 + §1.1: the ONLY source of bridge truth is GET /public/bridges filtered
// to destinationNetwork=Solana. Cached 1–5 min (plan §28). No hardcoded addresses.
const BRIDGE_TTL_MS = 3 * 60 * 1000;
const bridgeCache = new TtlCache<XstocksBridgeRaw[]>(BRIDGE_TTL_MS);
const CACHE_KEY = 'bridges:to:solana';

let lastGood: XstocksBridgeRaw[] | null = null;

export async function getBridgesToSolana(): Promise<XstocksBridgeRaw[]> {
  const cached = bridgeCache.get(CACHE_KEY);
  if (cached) return cached;
  try {
    const res = await xstocksClient.getBridges({ destinationNetwork: 'Solana' });
    if (!res.data) throw new Error(`upstream ${res.status}`);
    // Defensive: enforce destination filter server-side even if upstream ignores it.
    const filtered = res.data.filter((b) => (b.destinationNetworks ?? []).includes('Solana'));
    bridgeCache.set(CACHE_KEY, filtered);
    lastGood = filtered;
    return filtered;
  } catch (err) {
    // Transient upstream blip: serve the last good config rather than failing.
    if (lastGood) return lastGood;
    if (err instanceof HttpError) throw err;
    throw serviceUnavailable(
      'BRIDGE_CONFIG_UNAVAILABLE',
      'Bridge configuration is temporarily unavailable. Please retry shortly.',
    );
  }
}

/** Solana-side CCIP config (router/quoter programs). Comes from the live Solana bridge entry. */
export async function getSolanaBridgeEntry(): Promise<XstocksBridgeRaw | null> {
  const [toSolana, solanaNet] = await Promise.all([
    getBridgesToSolana().catch(() => [] as XstocksBridgeRaw[]),
    xstocksClient.getBridges({ network: 'Solana' }).then(
      (r) => r.data ?? [],
      () => [] as XstocksBridgeRaw[],
    ),
  ]);
  const direct = solanaNet.find((b) => b.network === 'Solana') ?? null;
  if (direct) return direct;
  return toSolana.find((b) => b.chainConfig?.ccipRouterProgram) ?? toSolana[0] ?? null;
}

/** Normalized routes for GET /api/bridge/routes. One route per (source → Solana). */
export async function getBridgeRoutes(): Promise<{
  destination: { network: 'Solana' };
  routes: UmbraBridgeRoute[];
  unavailableSources: Array<{ network: string; reason: string }>;
}> {
  const [bridges, all] = await Promise.all([
    getBridgesToSolana(),
    xstocksClient.getBridges({}).then(
      (r) => r.data ?? [],
      () => [] as XstocksBridgeRaw[],
    ),
  ]);
  const routes: UmbraBridgeRoute[] = bridges.map((b) => ({
    sourceNetwork: b.network,
    destinationNetwork: 'Solana' as const,
    bridgeAddress: b.address,
    supportedAssets: (b.products ?? []).map((p) => p.symbol).sort(),
  }));
  routes.sort((a, b) => a.sourceNetwork.localeCompare(b.sourceNetwork));
  return { destination: { network: 'Solana' }, routes, unavailableSources: computeUnavailableSources(all, bridges) };
}

/**
 * Every chain in the xStocks bridge mesh that cannot currently send to Solana.
 * Pure (unit-testable): mesh networks minus live-confirmed sources minus Solana itself.
 * This is how Umbra "supports all chains" honestly — the moment xStocks enables a
 * new source, it flips from this list into `routes` with zero code changes.
 */
export function computeUnavailableSources(
  allBridges: XstocksBridgeRaw[],
  toSolana: XstocksBridgeRaw[],
): Array<{ network: string; reason: string }> {
  const supported = new Set(toSolana.map((b) => b.network));
  const seen = new Set<string>();
  const out: Array<{ network: string; reason: string }> = [];
  for (const b of allBridges) {
    if (seen.has(b.network) || supported.has(b.network) || b.network === 'Solana') continue;
    seen.add(b.network);
    out.push({
      network: b.network,
      reason: 'The live xStocks bridge configuration does not currently enable this network to Solana.',
    });
  }
  out.sort((a, b) => a.network.localeCompare(b.network));
  return out;
}

export async function isAssetBridgeableToSolana(asset: string): Promise<boolean> {
  const bridges = await getBridgesToSolana();
  const sym = asset.toUpperCase();
  return bridges.some((b) => (b.products ?? []).some((p) => p.symbol.toUpperCase() === sym));
}

/** All symbols bridgeable to Solana (for asset discovery). */
export async function listBridgeAssets(): Promise<string[]> {
  const bridges = await getBridgesToSolana();
  const set = new Set<string>();
  for (const b of bridges) for (const p of b.products ?? []) set.add(p.symbol);
  return [...set].sort();
}

/** Source-chain token address for an asset on a given source network (from live config). */
export async function getSourceTokenAddress(
  sourceNetwork: string,
  asset: string,
): Promise<{ address: string; decimals: number } | null> {
  const bridges = await getBridgesToSolana();
  const bridge = bridges.find((b) => b.network.toLowerCase() === sourceNetwork.toLowerCase());
  const product = bridge?.products?.find((p) => p.symbol.toUpperCase() === asset.toUpperCase());
  const dep = product?.deployments?.find((d) => d.network.toLowerCase() === sourceNetwork.toLowerCase());
  if (!dep?.address) return null;
  return { address: dep.address, decimals: product?.evmDecimals ?? 18 };
}

/** Solana-side mint for a bridgeable asset (from live config). */
export async function getSolanaMintForAsset(asset: string): Promise<{ address: string; decimals: number } | null> {
  const bridges = await getBridgesToSolana();
  for (const b of bridges) {
    const product = (b.products ?? []).find((p) => p.symbol.toUpperCase() === asset.toUpperCase());
    const dep = product?.deployments?.find((d) => d.network === 'Solana');
    if (dep?.address) return { address: dep.address, decimals: product?.svmDecimals ?? 8 };
  }
  return null;
}
