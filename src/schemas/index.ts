import { z } from 'zod';

export const solanaAddress = z.string().min(32).max(48);
export const symbolSchema = z.string().min(1).max(16);
export const positiveDecimal = z
  .string()
  .max(40, 'amount is too long')
  .regex(/^(?!0+(\.0+)?$)\d+(\.\d+)?$/, 'must be a positive decimal')
  .refine((v) => {
    const parts = v.split('.');
    const whole = parts[0] ?? '';
    const fraction = parts[1] ?? '';
    return whole.replace(/^0+/, '').length <= 12 && fraction.length <= 9;
  }, 'amount is too large or too precise');

// 5% ceiling: 10000 bps made minimumReceived zero (no slippage protection at all).
const slippageBpsSchema = z.coerce.number().int().min(0).max(500).default(50);

export const swapQuoteQuery = z.object({
  // Domain-level (preferred): ?sell=USDC&buy=NVDAx&amount=500&userPublicKey=...
  sell: symbolSchema.optional(),
  buy: symbolSchema.optional(),
  amount: positiveDecimal.optional(),
  userPublicKey: solanaAddress.optional(),
  slippageBps: slippageBpsSchema,
});

export const swapTransactionBody = z.object({
  quoteId: z.string().min(1).max(64),
  userPublicKey: solanaAddress,
});

export const swapBroadcastBody = z.object({
  quoteId: z.string().min(1).max(64),
  userPublicKey: solanaAddress,
  signedTransaction: z.string().min(80).max(20_000),
});

export const swapSubmitBody = z.object({
  quoteId: z.string().min(1).max(64),
  signature: z.string().min(80).max(96),
  wallet: solanaAddress,
});

export const transactionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  wallet: solanaAddress,
});

export const bridgeQuoteBody = z.object({
  sourceNetwork: z.string().min(1).max(32),
  asset: symbolSchema,
  amount: positiveDecimal,
  destinationNetwork: z.string().min(1).max(32),
  destinationAddress: z.string().min(1).max(128),
});

export const bridgeTransactionBody = z.object({
  bridgeQuoteId: z.string().min(1).max(64),
  sourceWalletAddress: z.string().min(1).max(128),
  destinationSolanaAddress: solanaAddress,
});

// Meteora DBC (bonding-curve launches). Same unsigned-tx pattern as swaps:
// the backend builds, the user's wallet signs. Config creation needs a fresh
// Keypair signature too, so the caller generates it and passes the pubkey.
export const dbcQuoteQuery = z.object({
  pool: solanaAddress,
  side: z.enum(['buy', 'sell']),
  amount: positiveDecimal,
  slippageBps: slippageBpsSchema,
});

export const dbcSwapBody = z.object({
  pool: solanaAddress,
  side: z.enum(['buy', 'sell']),
  amount: positiveDecimal,
  userPublicKey: solanaAddress,
  slippageBps: slippageBpsSchema,
});

// A signed DBC swap relayed to the chain: base64 legacy transaction.
export const dbcBroadcastBody = z.object({
  userPublicKey: solanaAddress,
  transaction: z.string().min(80).max(20_000),
});

export const dbcCreateConfigBody = z.object({
  preset: z.string().min(1).max(64),
  config: solanaAddress,
  feeClaimer: solanaAddress,
  leftoverReceiver: solanaAddress,
  payer: solanaAddress,
});

export const dbcCreatePoolBody = z.object({
  config: solanaAddress,
  baseMint: solanaAddress,
  name: z.string().min(1).max(32),
  symbol: z.string().min(1).max(16),
  uri: z.string().url().max(256),
  payer: solanaAddress,
  poolCreator: solanaAddress.optional(),
});
