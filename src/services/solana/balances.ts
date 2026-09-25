import Decimal from '../../utils/decimal.js';
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


// Mint directory: mint -> { symbol, kind }. Rebuilt every 10 min (new listings flow in).
const dirCache = new TtlCache<Map<string, { symbol: string; kind: 'stable' | 'xstock' | 'pre' }>>(10 * 60 * 1000);

async function getMintDirectory(): Promise<{
  dir: Map<string, { symbol: string; kind: 'stable' | 'xstock' | 'pre' }>;
  complete: boolean;
}> {
  const cached = dirCache.get('dir');
  if (cached) return { dir: cached, complete: true };
  // One cached bridge-config call yields every xStock Solana mint — no per-asset fan-out.
  const dir = new Map<string, { symbol: string; kind: 'stable' | 'xstock' | 'pre' }>();
  dir.set(SOLANA_USDC_MINT, { symbol: 'USDC', kind: 'stable' });
  dir.set(SOLANA_USDT_MINT, { symbol: 'USDT', kind: 'stable' });
  // A partial directory is never cached, and its incompleteness is reported to
  // the caller. Silently dropping the xStock leg would make every xStock holding
  // look like a zero balance; hard-failing instead would take the whole wallet
  // view down whenever this provider stalls, which it does.
  const [bridges, pre] = await Promise.all([
    Promise.race([
      getBridgesToSolana().catch(() => [] as Awaited<ReturnType<typeof getBridgesToSolana>>),
      new Promise<Awaited<ReturnType<typeof getBridgesToSolana>>>((resolve) => setTimeout(() => resolve([]), 4_000)),
    ]),
    Promise.race([
      listPrestocks().catch(() => [] as Awaited<ReturnType<typeof listPrestocks>>),
      new Promise<Awaited<ReturnType<typeof listPrestocks>>>((resolve) => setTimeout(() => resolve([]), 4_000)),
    ]),
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
  const complete = bridges.length > 0 && pre.length > 0;
  // Only a complete directory is worth caching; a partial one would keep
  // reporting missing assets for the whole TTL.
  if (complete) dirCache.set('dir', dir);
  return { dir, complete };
}

export interface WalletBalance {
  symbol: string;
  /** Verified mint, or null for native SOL which has no token account. */
  mint: string | null;
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

interface RawTokenRow {
  mint: string | undefined;
  amount: string | undefined;
  decimals: number | undefined;
}

/**
 * Collapse the token accounts the chain returns into one row per mint.
 *
 * A wallet can legitimately hold several token accounts for the same mint. The
 * UI reads the first row matching the symbol, so returning both accounts made
 * one of them look like the whole holding — a live example showed 204 USDC
 * instead of the real 3044 USDC. Amounts are summed as BigInt, so no precision
 * is lost, and malformed rows are dropped instead of poisoning the total.
 */
export function aggregateByMint(rows: RawTokenRow[]): Array<{ mint: string; amount: string; decimals: number }> {
  const byMint = new Map<string, { mint: string; amount: bigint; decimals: number }>();
  for (const r of rows) {
    const mint = r.mint;
    const amountRaw = r.amount;
    const decimals = r.decimals;
    if (!mint || amountRaw === undefined || decimals === undefined) continue;
    // Provider amounts must be exact non-negative integers; anything else is
    // malformed input, not a balance.
    if (!/^\d+$/.test(amountRaw)) continue;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) continue;
    const existing = byMint.get(mint);
    const amount = BigInt(amountRaw);
    if (existing) {
      if (existing.decimals !== decimals) continue; // conflicting metadata: skip
      existing.amount += amount;
    } else {
      byMint.set(mint, { mint, amount, decimals });
    }
  }
  return [...byMint.values()].map((e) => ({
    mint: e.mint,
    amount: e.amount.toString(),
    decimals: e.decimals,
  }));
}

/**
 * GET /api/wallet/:address/balances — every known Umbra token the wallet holds.
 * xStocks use display amounts (raw × live multiplier); stables/pre-IPO are plain.
 * Unknown mints (random memecoins) are skipped — this is a stock shop, not an explorer.
 */
export async function getWalletBalances(ownerAddress: string): Promise<{ balances: WalletBalance[]; partial: boolean }> {
  if (!isValidSolanaAddress(ownerAddress)) {
    throw badRequest('INVALID_ADDRESS', 'ownerAddress is not a valid Solana address.');
  }
  const conn = getConnection();
  const owner = new PublicKey(ownerAddress);
  const { dir, complete: directoryComplete } = await getMintDirectory();

  let spl, t22;
  try {
    [spl, t22] = await Promise.all([
      // Hard deadline per call: a stalled RPC must not hold the wallet route.
      Promise.race([
        conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('rpc timeout')), 12_000)),
      ]),
      Promise.race([
        conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('rpc timeout')), 12_000)),
      ]),
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
  // Native SOL is not an SPL token, so it never appears in the account lists —
  // read it directly or the balance line would claim you hold none.
  let nativeSol: WalletBalance | null = null;
  let solUnknown = false;
  try {
    // Bounded like every other RPC call here: without a deadline one stalled
    // provider holds the whole wallet request open indefinitely.
    const lamports = await Promise.race([
      conn.getBalance(owner, 'confirmed'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('rpc timeout')), 8_000)),
    ]);
    if (lamports > 0) {
      nativeSol = {
        symbol: 'SOL',
        // Native SOL has no token account, so it genuinely has no mint.
        mint: null,
        raw: String(lamports),
        display: new Decimal(lamports).div(new Decimal(10).pow(9)).toString(),
        decimals: 9,
      };
    }
  } catch {
    // RPC hiccup: omit SOL rather than claim a zero balance, and mark the
    // response partial so the UI shows "unknown", not "0.00".
    solUnknown = true;
  }
  // Multipliers resolve in parallel but bounded: a wallet holding many xStocks
  // otherwise fans out one unreliable upstream call per holding at once. Keyed by
  // mint and de-duplicated, so several accounts of one stock cost one lookup.
  const xstockMints = [...new Set(rows.map((r) => r.mint as string))]
    .filter((mint) => dir.get(mint)?.kind === 'xstock');
  const multByMint = new Map<string, string>();
  for (let start = 0; start < xstockMints.length; start += 6) {
    const slice = xstockMints.slice(start, start + 6);
    const resolved = await Promise.all(
      slice.map((mint) => getMultiplier(dir.get(mint)?.symbol ?? '', 'Solana').catch(() => null)),
    );
    slice.forEach((mint, k) => {
      const value = resolved[k];
      if (value) multByMint.set(mint, value);
    });
  }
  const rowsByMint = aggregateByMint(rows);
  const out: WalletBalance[] = [];
  // A holding we could not price is a holding we could not check, which is just
  // as "unknown" as a directory we could not load. Both must surface as partial,
  // or the client reads the missing row as a confirmed zero.
  let unresolved = false;
  rowsByMint.forEach((r) => {
    const entry = dir.get(r.mint);
    if (!entry) return;
    if (r.amount === '0') return;
    let display: string;
    try {
      if (entry.kind === 'xstock') {
        // An xStock without its live multiplier cannot be converted to display
        // units. Showing the raw amount would overstate the holding by orders of
        // magnitude, so omit it instead of guessing.
        if (!multByMint.has(r.mint)) {
          unresolved = true;
          return;
        }
        display = toDisplayBalance(entry.kind, r.amount, r.decimals, multByMint.get(r.mint) ?? null);
      } else {
        display = toDisplayBalance(entry.kind, r.amount, r.decimals, null);
      }
    } catch {
      unresolved = true;
      return; // unconvertible holding: skip rather than print NaN
    }
    out.push({
      symbol: entry.symbol,
      mint: r.mint,
      raw: r.amount,
      display,
      decimals: r.decimals,
    });
  });
  if (nativeSol) out.push(nativeSol);
  out.sort((a, b) => a.symbol.localeCompare(b.symbol));
  // `partial` tells the client that assets may be missing from this list, so an
  // absent row means "unknown", not "you hold none".
  return { balances: out, partial: !directoryComplete || unresolved || solUnknown };
}
