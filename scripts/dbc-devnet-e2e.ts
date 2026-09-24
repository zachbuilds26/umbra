/**
 * DBC devnet end-to-end: launch an equity-tuned bonding-curve pool and trade it,
 * on devnet, for free.
 *
 * Mirrors exactly what a mainnet launch does through the Umbra API:
 *   1. fund a throwaway payer (devnet faucet)
 *   2. create a 6-decimal quote token (mainnet uses real USDC; devnet has none)
 *   3. create the DBC config from an Umbra equity preset   -> POST /api/dbc/config/transaction
 *   4. create the base mint + the bonding-curve pool       -> POST /api/dbc/pool/transaction
 *   5. read the live pool                                  -> GET  /api/dbc/pools
 *   6. quote a buy                                         -> GET  /api/dbc/quote
 *   7. execute that buy on the curve                       -> POST /api/dbc/transaction
 *
 * Every transaction goes through the same Umbra builders the API uses, and the
 * payer is a local throwaway key — this is a test harness, not product code.
 * Those builders share the app's Solana connection, so SOLANA_RPC_URL must be
 * the devnet URL for this run (nothing is ever sent to mainnet).
 *
 * Run (PowerShell):
 *   $env:SOLANA_RPC_URL="https://api.devnet.solana.com"
 *   npx tsx scripts/dbc-devnet-e2e.ts
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccount,
  createMint,
  getAssociatedTokenAddressSync,
  getMint,
  mintTo,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  buildDbcCreateConfigTransaction,
  buildDbcCreatePoolTransaction,
  buildDbcSwapTransaction,
  getDbcPoolByMint,
  getDbcQuote,
} from '../src/services/meteora/dbc.service.js';
import { EQUITY_PRESETS } from '../src/services/meteora/dbc-presets.js';

const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const PRESET = process.env.DBC_PRESET ?? 'equity-discovery';
const BUY_AMOUNT = process.env.DBC_BUY_AMOUNT ?? '10';
// Optional pre-funded devnet key (base58 secret). The public faucet is
// rate-limited per IP, so funding once at https://faucet.solana.com and
// exporting the key is the reliable path.
const PREFUNDED_KEY = process.env.DEVNET_PAYER_KEY ?? '';
// Builds and prints every transaction it can without sending anything. Pool and
// swap steps need a live on-chain config, so dry-run stops after the config tx —
// enough to prove the whole preset -> instruction path on a devnet connection.
const DRY_RUN = process.argv.includes('--dry-run');
const connection = new Connection(RPC, 'confirmed');
const log = (...args: unknown[]) => console.log('[dbc-devnet]', ...args);

function bs58decode(value: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const bytes: number[] = [0];
  for (const ch of value) {
    const value = ALPHABET.indexOf(ch);
    if (value === -1) throw new Error('DEVNET_PAYER_KEY is not valid base58.');
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return Uint8Array.from(bytes.reverse());
}

// This harness must never touch real money: it signs real transactions, so a
// mainnet RPC here would spend the user's SOL. Hard stop, not a warning.
if (/mainnet-beta|api\.mainnet|helius-rpc\.com\/?(\?|$)/i.test(RPC) && !/devnet/i.test(RPC)) {
  throw new Error(`Refusing to run: SOLANA_RPC_URL is not a devnet endpoint (${RPC}).`);
}

function decode(txB64: string): Transaction {
  return Transaction.from(Buffer.from(txB64, 'base64'));
}

async function send(tx: Transaction, signers: Keypair[], label: string): Promise<string> {
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  log(`${label}: ${sig}`);
  const res = await connection.confirmTransaction(sig, 'confirmed');
  if (res.value.err) throw new Error(`${label} failed on devnet: ${JSON.stringify(res.value.err)}`);
  log(`${label}: confirmed`);
  return sig;
}

async function airdrop(pubkey: PublicKey, sol: number): Promise<void> {
  // The public faucet is flaky (429s, dry taps). Retry briefly, then tell the
  // user exactly what to do instead of failing with raw JSON-RPC text.
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
      const res = await connection.confirmTransaction(sig, 'confirmed');
      if (res.value.err) throw new Error(JSON.stringify(res.value.err));
      log(`airdropped ${sol} devnet SOL to ${pubkey.toBase58()}`);
      return;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
    }
  }
  throw new Error(
    `Devnet faucet unavailable (${last.slice(0, 120)}).\n` +
      `Fund this address once, free, at https://faucet.solana.com and re-run with:\n` +
      `  $env:DEVNET_PAYER_KEY="<base58 secret key>"\n` +
      `Address: ${pubkey.toBase58()}`,
  );
}

/** 6-decimal quote token, minted to the payer so the pool can be traded. */
async function createQuoteToken(payer: Keypair): Promise<PublicKey> {
  const mint = await createMint(connection, payer, payer.publicKey, null, 6, undefined, TOKEN_PROGRAM_ID);
  const ata = getAssociatedTokenAddressSync(mint, payer.publicKey, true, TOKEN_PROGRAM_ID);
  await send(
    new Transaction().add(
      createAssociatedTokenAccount(connection, payer, ata, payer.publicKey, mint, TOKEN_PROGRAM_ID),
    ),
    [payer],
    'quote token account',
  );
  await send(new Transaction().add(mintTo(connection, payer, ata, payer.publicKey, mint, 1_000_000 * 10 ** 6, [], TOKEN_PROGRAM_ID)), [payer], 'mint quote tokens');
  const info = await getMint(connection, mint, 'confirmed');
  log(`quote token ${mint.toBase58()} (decimals ${info.decimals})`);
  return mint;
}

/** 8-decimal base token standing in for a newly tokenized stock. */
async function createBaseMint(payer: Keypair): Promise<PublicKey> {
  const mint = await createMint(
    connection, payer, payer.publicKey, null, 8, undefined, TOKEN_PROGRAM_ID,
  );
  const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const info = await getMint(connection, mint, 'confirmed');
  log(`base mint ${mint.toBase58()} (decimals ${info.decimals}, rent-exempt ${(rent / LAMPORTS_PER_SOL).toFixed(9)} SOL)`);
  return mint;
}

async function main(): Promise<void> {
  const preset = EQUITY_PRESETS.find((p) => p.id === PRESET);
  if (!preset) throw new Error(`Unknown preset ${PRESET}. Known: ${EQUITY_PRESETS.map((p) => p.id).join(', ')}`);
  log(`preset: ${preset.name} (${preset.id}) — rpc ${RPC}`);

  const payer = PREFUNDED_KEY ? Keypair.fromSecretKey(bs58decode(PREFUNDED_KEY)) : Keypair.generate();
  const config = Keypair.generate();
  log(`payer    ${payer.publicKey.toBase58()}`);
  log(`config   ${config.publicKey.toBase58()}`);

  if (DRY_RUN) {
    // A throwaway quote mint address: dry-run only builds instructions, and
    // createConfig does not read chain state.
    const quoteMint = Keypair.generate().publicKey;
    const built = await buildDbcCreateConfigTransaction(
      PRESET,
      config.publicKey.toBase58(),
      payer.publicKey.toBase58(),
      payer.publicKey.toBase58(),
      payer.publicKey.toBase58(),
      quoteMint.toBase58(),
    );
    const tx = decode(built.transaction);
    log(`dry run: createConfig built — ${tx.instructions.length} instruction(s), ${tx.compileMessage().header.numRequiredSignatures} signature(s)`);
    log(`dry run: config ${built.config}, quote mint ${built.quoteMint}`);
    log('dry run: nothing was sent. Drop --dry-run with a funded devnet key to execute.');
    return;
  }

  if (PREFUNDED_KEY) {
    const lamports = await connection.getBalance(payer.publicKey, 'confirmed');
    log(`using your funded devnet key (balance ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
  } else {
    await airdrop(payer.publicKey, 2);
  }
  const quoteMint = await createQuoteToken(payer);
  const baseMint = await createBaseMint(payer);

  // 1) config (the launch rules) — same call the API makes.
  const cfg = await buildDbcCreateConfigTransaction(
    PRESET,
    config.publicKey.toBase58(),
    payer.publicKey.toBase58(),
    payer.publicKey.toBase58(),
    payer.publicKey.toBase58(),
    quoteMint.toBase58(),
  );
  await send(decode(cfg.transaction), [payer, config], 'createConfig');

  // 2) pool (the curve itself) — same call the API makes.
  const pool = await buildDbcCreatePoolTransaction(
    cfg.config,
    baseMint.toBase58(),
    'Umbra Devnet Equity',
    'UMDEQ',
    'https://umbra.example/equity.json',
    payer.publicKey.toBase58(),
  );
  await send(decode(pool.transaction), [payer], 'createPool');

  // 3) live pool state through the same reader the API uses.
  const state = await getDbcPoolByMint(baseMint.toBase58());
  if (!state) throw new Error('pool was created but getDbcPoolByMint returned null');
  log(`pool     ${state.pool}`);
  log(`reserves base=${state.baseReserve} quote=${state.quoteReserve}`);
  log(`curve progress ${(state.curveProgress * 100).toFixed(2)}% of ${state.migrationQuoteThreshold} quote base units`);
  log(`decimals base=${state.baseDecimals} quote=${state.quoteDecimals}`);

  // 4) quote + execute a buy on the curve.
  const q = await getDbcQuote(state.pool, 'buy', BUY_AMOUNT, 100);
  log(`quote    ${q.amountInDisplay} -> ${q.amountOutDisplay} (min ${q.minimumOut}, fee ${q.tradingFee})`);
  const swap = await buildDbcSwapTransaction(state.pool, 'buy', BUY_AMOUNT, payer.publicKey.toBase58(), 100);
  await send(decode(swap.transaction), [payer], 'buy');

  const after = await getDbcPoolByMint(baseMint.toBase58());
  log(`after buy: baseReserve=${after?.baseReserve} quoteReserve=${after?.quoteReserve} progress=${((after?.curveProgress ?? 0) * 100).toFixed(2)}%`);
  log('DEVNET E2E OK — config, pool, read, quote and trade all confirmed.');
}

void main().catch((err: unknown) => {
  console.error('[dbc-devnet] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
