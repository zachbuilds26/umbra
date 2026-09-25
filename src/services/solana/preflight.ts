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

export async function estimateSolRequirement(args: {
  owner: string;
  mints: string[];
}): Promise<SolRequirement | null> {
  const unique = args.mints.filter((mint) => mint !== NATIVE_MINT);
  if (unique.length === 0) return null;
  const owner = new PublicKey(args.owner);

  const available = await withRpcDeadline('preflight getBalance', RPC_DEADLINE_MS, () =>
    getConnection().getBalance(owner),
  ).catch(() => null);
  if (available === null) return null;

  const conn = getConnection();
  let legacyRent = 0;
  let token2022Rent = 0;
  const missing: string[] = [];
  let resolvedAny = false;

  for (const mint of unique) {
    let parsed: PublicKey;
    try {
      parsed = new PublicKey(mint);
    } catch {
      continue;
    }
    const kind = await tokenProgramKind(parsed);
    if (!kind) continue;
    resolvedAny = true;
    if (await ownsTokenAccount(owner, parsed, kind)) continue;
    missing.push(mint);
    if (kind === 'legacy') {
      if (!legacyRent) {
        legacyRent = await conn.getMinimumBalanceForRentExemption(LEGACY_ACCOUNT_BYTES).catch(() => 0);
      }
    } else if (!token2022Rent) {
      token2022Rent = await conn.getMinimumBalanceForRentExemption(TOKEN_2022_ACCOUNT_BYTES).catch(() => 0);
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

function withUsd(lamports: number, solUsdPrice: string | null): string {
  const sol = new Decimal(lamports).div(new Decimal(10).pow(9));
  if (!solUsdPrice) return `${sol.toFixed(6)} SOL`;
  let usd: string;
  try {
    usd = sol.mul(new Decimal(solUsdPrice)).toFixed(2);
  } catch {
    return `${sol.toFixed(6)} SOL`;
  }
  return `${sol.toFixed(6)} SOL ($${usd})`;
}

export function describeSolShortfall(
  requirement: SolRequirement,
  opts: { buySymbol?: string | null; solUsdPrice?: string | null } = {},
): string {
  const price = opts.solUsdPrice ?? null;
  const accounts = requirement.missingMints.length;
  const dest = opts.buySymbol ? ` to receive ${opts.buySymbol}` : '';
  const opening =
    accounts === 0
      ? 'no new accounts'
      : `${accounts} new token account${accounts === 1 ? '' : 's'}${dest}`;
  const target = withUsd(requirement.requiredLamports, price);
  const held = withUsd(requirement.availableLamports, price);
  if (requirement.shortfallLamports <= 0) {
    return `This route needs ${opening}. Keeping ${target} in SOL covers it, and this wallet holds ${held}.`;
  }
  return `This route needs ${opening}. We recommend keeping ${target} in SOL for the account rent, network fee and routing margin, and this wallet holds only ${held} — add about ${withUsd(requirement.shortfallLamports, price)} before swapping.`;
}
