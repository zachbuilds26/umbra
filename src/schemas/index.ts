import { z } from 'zod';

export const solanaAddress = z.string().min(32).max(48);
export const evmAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'invalid EVM address');
export const symbolSchema = z.string().min(1).max(16);
export const positiveDecimal = z.string().regex(/^(?!0+(\.0+)?$)\d+(\.\d+)?$/, 'must be a positive decimal');

export const swapQuoteQuery = z.object({
  // Domain-level (preferred): ?sell=USDC&buy=NVDAx&amount=500&userPublicKey=...
  sell: symbolSchema.optional(),
  buy: symbolSchema.optional(),
  amount: positiveDecimal.optional(),
  userPublicKey: solanaAddress.optional(),
  slippageBps: z.coerce.number().int().min(0).max(10_000).default(50),
});

export const swapTransactionBody = z.object({
  quoteId: z.string().min(1),
  userPublicKey: solanaAddress,
});

export const swapSubmitBody = z.object({
  quoteId: z.string().min(1),
  signature: z.string().min(80).max(96),
});

export const bridgeQuoteBody = z.object({
  sourceNetwork: z.string().min(1),
  asset: symbolSchema,
  amount: positiveDecimal,
  destinationNetwork: z.string().min(1),
  destinationAddress: z.string().min(1),
});

export const bridgeTransactionBody = z.object({
  bridgeQuoteId: z.string().min(1),
  sourceWalletAddress: z.string().min(1),
  destinationSolanaAddress: solanaAddress,
});

// Meteora DBC (bonding-curve launches). Same unsigned-tx pattern as swaps:
// the backend builds, the user's wallet signs. Config creation needs a fresh
// Keypair signature too, so the caller generates it and passes the pubkey.
export const dbcQuoteQuery = z.object({
  pool: solanaAddress,
  side: z.enum(['buy', 'sell']),
  amount: positiveDecimal,
  slippageBps: z.coerce.number().int().min(0).max(10_000).default(50),
});

export const dbcSwapBody = z.object({
  pool: solanaAddress,
  side: z.enum(['buy', 'sell']),
  amount: positiveDecimal,
  userPublicKey: solanaAddress,
  slippageBps: z.coerce.number().int().min(0).max(10_000).default(50),
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
