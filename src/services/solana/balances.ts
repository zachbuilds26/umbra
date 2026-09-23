import Decimal from 'decimal.js';
import { PublicKey } from '@solana/web3.js';
import { getConnection } from './connection.js';
import { getMultiplier, SOLANA_USDC_MINT, SOLANA_USDT_MINT } from '../xstocks/assets.service.js';
import { listPrestocks } from '../prestocks/assets.js';
import { getBridgesToSolana } from '../bridge/bridge-config.service.js';
import { TtlCache } from '../../utils/cache.js';
import { displayFromRaw } from './multiplier.js';
import { HttpError } from '../../utils/errors.js';
import { badRequest } from '../../utils/errors.js';
import { isValidSolanaAddress } from '../../utils/addresses.js';

Decimal.set({ precision: 40 });

// Mint directory: mint -> { symbol, kind }. Rebuilt every 10 min (new listings flow in).
const dirCache = new TtlCache<Map<string, { symbol: string; kind: 'stable' | 'xstock' | 'pre' }>>(10 * 60 * 1000);

async function getMintDirectory(): Promise<Map<string, { symbol: string; kind: 'stable' | 'xstock' | 'pre' }>> {
  const cached = dirCache.get('dir');
  if (cached) return cached;
  // One cached bridge-config call yields every xStock Solana mint — no per-asset fan-out.
  const dir = new Map<string, { symbol: string; kind: 'stable' | 'xstock' | 'pre' }>();
  dir.set(SOLANA_USDC_MINT, { symbol: 'USDC', kind: 'stable' });
  dir.set(SOLANA_USDT_MINT, { symbol: 'USDT', kind: 'stable' });
  const [bridges, pre] = await Promise.all([
    getBridgesToSolana().catch(() => []),
    listPrestocks().catch(() => []),
  ]);
  for (const b of bridges) {
    for (const p of b.products ?? []) {
      const dep = p.deployments?.find((d) => d.network === 'Solana');
      if (dep?.address && !dir.has(dep.address)) dir.set(dep.address, { symbol: p.symbol, kind: 'xstock' });
    }
  }
  for (const p of pre) {
    if (p.contract_address && !dir.has(p.contract_address)) {
      dir.set(p.contract_address, { symbol: p.symbol.toUpperCase(), kind: 'pre' });
    }
  }
  dirCache.set('dir', dir);
  return dir;
}

export interface WalletBalance {
  symbol: string;
  mint: string;
  /** Raw on-chain base units (what transactions use). */
  raw: string;
  /** Human display amount (multiplier applied for xStocks). */
  display: string;
  decimals: number;
}

export function toDisplayBalance(kind: 'stable' | 'xstock' | 'pre', rawBaseUnits: string, decimals: number, multiplier: string | null): string {
  const raw = new Decimal(rawBaseUnits).div(new Decimal(10).pow(decimals));
  if (kind === 'xstock' && multiplier) return displayFromRaw(raw.toString(), multiplier);
  return raw.toString();
}

/**
 * GET /api/wallet/:address/balances — every known Umbra token the wallet holds.
 * xStocks use display amounts (raw × live multiplier); stables/pre-IPO are plain.
 * Unknown mints (random memecoins) are skipped — this is a stock shop, not an explorer.
 */
export async function getWalletBalances(ownerAddress: string): Promise<WalletBalance[]> {
  if (!isValidSolanaAddress(ownerAddress)) {
    throw badRequest('INVALID_ADDRESS', 'ownerAddress is not a valid Solana address.');
  }
  const conn = getConnection();
  const owner = new PublicKey(ownerAddress);
  const dir = await getMintDirectory();

  let spl, t22;
  try {
    [spl, t22] = await Promise.all([
      conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }),
      conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') }),
    ]);
  } catch (err) {
    throw new HttpError(
      502,
      'RPC_ERROR',
      'Solana RPC is temporarily unreachable. Retry shortly (a dedicated RPC URL removes these blips).',
    );
  }

  const rows = [...spl.value, ...t22.value]
    .map(({ account }) => {
      const info = account.data.parsed?.info;
      return {
        mint: info?.mint as string | undefined,
        amount: info?.tokenAmount?.amount as string | undefined,
        decimals: info?.tokenAmount?.decimals as number | undefined,
      };
    })
    .filter((r) => r.mint && r.amount !== undefined && r.decimals !== undefined && dir.has(r.mint as string));
  // Multipliers resolve in parallel (was sequential: N holdings x up-to-6s stalls).
  const mults = await Promise.all(
    rows.map((r) => {
      const entry = dir.get(r.mint as string);
      if (entry?.kind !== 'xstock') return Promise.resolve(null);
      return getMultiplier(entry.symbol, 'Solana').catch(() => null);
    }),
  );
  const out: WalletBalance[] = [];
  rows.forEach((r, i) => {
    const entry = dir.get(r.mint as string);
    if (!entry) return;
    let raw: Decimal;
    try {
      raw = new Decimal(r.amount as string);
    } catch {
      return; // malformed RPC amount — skip, never 500 the whole wallet
    }
    if (raw.isZero()) return;
    out.push({
      symbol: entry.symbol,
      mint: r.mint as string,
      raw: r.amount as string,
      display: toDisplayBalance(entry.kind, r.amount as string, r.decimals as number, mults[i] ?? null),
      decimals: r.decimals as number,
    });
  });
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return out;
}
