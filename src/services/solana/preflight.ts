import { PublicKey } from '@solana/web3.js';
import Decimal from '../../utils/decimal.js';
import { getConnection, withRpcDeadline } from './connection.js';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const NATIVE_MINT = '11111111111111111111111111111111';

const TOKEN_PROGRAM_ID = new PublicKey(TOKEN_PROGRAM);
const TOKEN_2022_PROGRAM_ID = new PublicKey(TOKEN_2022_PROGRAM);
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(ASSOCIATED_TOKEN_PROGRAM);

const LEGACY_ACCOUNT_BYTES = 165;
const TOKEN_2022_ACCOUNT_BYTES = 200;
const SIGNATURE_FEE_BUFFER = 10_000;
const ROUTING_BUFFER_LAMPORTS = 2_000_000;
const RPC_DEADLINE_MS = 6_000;

export interface SolRequirement {
  requiredLamports: number;
  availableLamports: number;
  shortfallLamports: number;
  missingMints: string[];
  routeMints: number;
}

export function collectRouteMints(routePlan: unknown): string[] {
  const mints: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== 'string' || value.length === 0 || value === NATIVE_MINT) return;
    if (!mints.includes(value)) mints.push(value);
  };
  if (!Array.isArray(routePlan)) return mints;
  for (const leg of routePlan) {
    const swapInfo = (leg as { swapInfo?: { inputMint?: unknown; outputMint?: unknown } } | null)?.swapInfo;
    add(swapInfo?.inputMint);
    add(swapInfo?.outputMint);
  }
  return mints;
}

async function tokenProgramKind(mint: PublicKey): Promise<'legacy' | '2022' | null> {
  const info = await withRpcDeadline('preflight getAccountInfo(mint)', RPC_DEADLINE_MS, () =>
    getConnection().getAccountInfo(mint),
  ).catch(() => null);
  if (!info) return null;
  const owner = info.owner.toBase58();
  if (owner === TOKEN_PROGRAM) return 'legacy';
  if (owner === TOKEN_2022_PROGRAM) return '2022';
  return null;
}

async function ownsTokenAccount(owner: PublicKey, mint: PublicKey, kind: 'legacy' | '2022'): Promise<boolean> {
  const program = kind === '2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), program.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const info = await withRpcDeadline('preflight getAccountInfo(ata)', RPC_DEADLINE_MS, () =>
    getConnection().getAccountInfo(ata),
  ).catch(() => null);
  return Boolean(info && info.data.length > 0);
}

export function computeSolRequirement(args: {
  routeMintCount: number;
  missingMints: string[];
  legacyRent: number;
  token2022Rent: number;
  availableLamports: number;
}): SolRequirement {
  const required =
    args.legacyRent + args.token2022Rent + SIGNATURE_FEE_BUFFER + ROUTING_BUFFER_LAMPORTS;
  return {
    requiredLamports: required,
    availableLamports: args.availableLamports,
    shortfallLamports: Math.max(0, required - args.availableLamports),
    missingMints: args.missingMints,
    routeMints: args.routeMintCount,
  };
}

export function coversAmount(heldAtomic: unknown, neededAtomic: unknown): boolean {
  try {
    if (typeof heldAtomic !== 'string' || typeof neededAtomic !== 'string') return false;
    if (!/^\d+$/.test(heldAtomic) || !/^\d+$/.test(neededAtomic)) return false;
    return BigInt(heldAtomic) >= BigInt(neededAtomic);
  } catch {
    return false;
  }
}

async function inputBalanceCovers(
  owner: PublicKey,
  inputMint: string,
  inputAmountBaseUnits: string,
): Promise<boolean | null> {
  let mint: PublicKey;
  try {
    mint = new PublicKey(inputMint);
  } catch {
    return null;
  }
  const kind = await tokenProgramKind(mint);
  if (!kind) return null;
  const program = kind === '2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), program.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  let info;
  try {
    info = await withRpcDeadline('preflight getAccountInfo(input)', RPC_DEADLINE_MS, () =>
      getConnection().getAccountInfo(ata),
    );
  } catch {
    return null;
  }
  if (!info) return false;
  if (info.data.length < 72) return null;
  let held: bigint;
  try {
    held = info.data.readBigUInt64LE(64);
  } catch {
    return null;
  }
  return coversAmount(held.toString(), inputAmountBaseUnits);
}

export async function estimateSolRequirement(args: {
  owner: string;
  mints: string[];
  inputMint?: string | null;
  inputAmountBaseUnits?: string | null;
}): Promise<SolRequirement | null> {
  const unique = args.mints.filter((mint) => mint !== NATIVE_MINT);
  if (unique.length === 0) return null;
  const owner = new PublicKey(args.owner);

  if (args.inputMint && args.inputAmountBaseUnits) {
    let covered: boolean | null = null;
    try {
      covered = await inputBalanceCovers(owner, args.inputMint, args.inputAmountBaseUnits);
    } catch {
      covered = null;
    }
    if (covered === false) return null;
  }

  const available = await withRpcDeadline('preflight getBalance', RPC_DEADLINE_MS, () =>
    getConnection().getBalance(owner),
  ).catch(() => null);
  if (available === null) return null;

  const conn = getConnection();
  const checks = await Promise.all(
    unique.map(async (mint) => {
      let parsed: PublicKey;
      try {
        parsed = new PublicKey(mint);
      } catch {
        return null;
      }
      const kind = await tokenProgramKind(parsed);
      if (!kind) return null;
      const owned = await ownsTokenAccount(owner, parsed, kind);
      return { mint, kind, owned };
    }),
  );

  let legacyRent = 0;
  let token2022Rent = 0;
  const missing: string[] = [];
  let resolvedAny = false;
  for (const check of checks) {
    if (!check) continue;
    resolvedAny = true;
    if (check.owned) continue;
    missing.push(check.mint);
    if (check.kind === 'legacy') {
      if (!legacyRent) {
        legacyRent = await withRpcDeadline('preflight rent(legacy)', RPC_DEADLINE_MS, () =>
          conn.getMinimumBalanceForRentExemption(LEGACY_ACCOUNT_BYTES),
        );
      }
    } else if (!token2022Rent) {
      token2022Rent = await withRpcDeadline('preflight rent(2022)', RPC_DEADLINE_MS, () =>
        conn.getMinimumBalanceForRentExemption(TOKEN_2022_ACCOUNT_BYTES),
      );
    }
  }

  if (!resolvedAny) return null;
  return computeSolRequirement({
    routeMintCount: unique.length,
    missingMints: missing,
    legacyRent,
    token2022Rent,
    availableLamports: available,
  });
}

export function lamportsToSol(lamports: number): string {
  return new Decimal(lamports).div(new Decimal(10).pow(9)).toFixed(6);
}

export function describeSolShortfall(
  requirement: SolRequirement,
  opts: { buySymbol?: string | null; solUsdPrice?: string | null } = {},
): string {
  void opts;
  if (requirement.shortfallLamports <= 0) {
    return 'Enough SOL for this swap.';
  }
  const sol = new Decimal(requirement.shortfallLamports).div(new Decimal(10).pow(9));
  const solText = sol.toFixed(6);
  const price = opts.solUsdPrice ?? null;
  if (!price) return `Insufficient funds — add about ${solText} SOL to swap.`;
  let usd: string | null = null;
  try {
    usd = sol.mul(new Decimal(price)).toFixed(2);
  } catch {
    usd = null;
  }
  if (usd === null) return `Insufficient funds — add about ${solText} SOL to swap.`;
  return `Insufficient funds — add about ${solText} SOL ($${usd}) to swap.`;
}
