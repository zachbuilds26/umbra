import { z } from 'zod';
import { isValidSolanaAddress } from '../utils/addresses.js';

// A length check alone accepted any 32–48 character string ("aaaa…"), which then
// reached SQL, logs, and upstream URLs. The route boundary now requires a real,
// on-curve base58 Solana address.
export const solanaAddress = z
  .string()
  .min(32)
  .max(48)
  .refine(isValidSolanaAddress, { message: 'must be a valid Solana address' });

export const transactionId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be a transaction id');

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

export const swapBroadcastBody = z
  .object({
    quoteId: z.string().min(1).max(64),
    userPublicKey: solanaAddress,
    // Either the signed bytes to relay, or the signature of a transaction the
    // wallet already broadcast itself. Exactly one is required.
    signedTransaction: z.string().min(80).max(20_000).optional(),
    signature: z.string().min(80).max(96).optional(),
  })
  .refine((v) => Boolean(v.signedTransaction) !== Boolean(v.signature), {
    message: 'Provide either signedTransaction or signature, not both.',
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
