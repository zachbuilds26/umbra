import Decimal from 'decimal.js';
import { newQuoteId } from '../../utils/ids.js';
import { quoteStore } from '../quotes.store.js';
import { getSolanaBridgeEntry } from './bridge-config.service.js';
import { validateBridgeQuoteRequest, validateBridgeWallets } from './bridge-validation.service.js';
import { badRequest } from '../../utils/errors.js';
import type { UmbraBridgeQuote } from '../../domain/models.js';

const BRIDGE_QUOTE_TTL_MS = 5 * 60 * 1000;

/**
 * POST /api/bridge/quote — validated 1:1 bridge intent (same product, new network).
 * Fees/times are returned ONLY when the live config provides them, else null (plan §38).
 */
export async function buildBridgeQuote(params: {
  sourceNetwork: string;
  asset: string;
  amount: string;
  destinationNetwork: string;
  destinationAddress: string;
}): Promise<UmbraBridgeQuote> {
  const v = await validateBridgeQuoteRequest(params);
  const bridgeQuoteId = newQuoteId('umbra_bq');
  const expiresAtMs = Date.now() + BRIDGE_QUOTE_TTL_MS;

  quoteStore.putBridge({
    bridgeQuoteId,
    sourceNetwork: v.sourceNetwork,
    asset: v.asset,
    amount: v.amount,
    destinationAddress: v.destinationAddress,
    sourceTokenAddress: v.sourceTokenAddress,
    sourceDecimals: v.sourceDecimals,
    solanaMint: v.solanaMint,
    bridgeAddress: v.bridgeAddress,
    expiresAt: expiresAtMs,
  });

  return {
    bridgeQuoteId,
    sourceNetwork: v.sourceNetwork,
    destinationNetwork: 'Solana',
    asset: v.asset,
    amount: v.amount,
    // Same product across chains: 1.0 display unit in = 1.0 display unit out (before fees).
    estimatedReceived: v.amount,
    // The public bridge config exposes no fee/time oracle — never invent (plan §38).
    fee: null,
    estimatedTime: null,
    route: [{ network: v.sourceNetwork }, { symbol: v.asset }, { network: 'Solana' }],
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export interface BridgeTransactionPayload {
  bridgeQuoteId: string;
  asset: string;
  amount: string;
  sourceNetwork: string;
  destinationNetwork: 'Solana';
  bridgeContract: string;
  sourceToken: string;
  sourceAmountBaseUnits: string;
  destinationMint: string;
  destinationAddress: string;
  ccipConfig: Record<string, string> | null;
  evmChainId: number | null;
  // Exact unsigned calldata is intentionally NOT fabricated (plan §21). The frontend
  // signs a source-chain CCIP send via the verified bridge contract above using the
  // user's own wallet; `nextStep` tells it exactly what to call.
  unsignedTransaction: null;
  nextStep: string;
}

/**
 * POST /api/bridge/transaction — return everything the source wallet needs to sign.
 * Never holds keys; never invents calldata (plan §21).
 */
export async function buildBridgeTransaction(params: {
  bridgeQuoteId: string;
  sourceWalletAddress: string;
  destinationSolanaAddress: string;
}): Promise<BridgeTransactionPayload> {
  const stored = quoteStore.getBridge(params.bridgeQuoteId);
  if (!stored) {
    throw badRequest('QUOTE_EXPIRED', 'Bridge quote not found or expired. Request a fresh quote.', {
      bridgeQuoteId: params.bridgeQuoteId,
    });
  }
  validateBridgeWallets(stored.sourceNetwork, params.sourceWalletAddress, params.destinationSolanaAddress);

  const solanaEntry = await getSolanaBridgeEntry().catch(() => null);
  const ccipConfig = solanaEntry?.chainConfig ?? null;

  // Source decimals come from the live config (stored on the quote), not a constant.
  let sourceAmountBaseUnits: string;
  try {
    sourceAmountBaseUnits = new Decimal(stored.amount)
      .mul(new Decimal(10).pow(stored.sourceDecimals ?? 18))
      .floor()
      .toFixed(0);
  } catch {
    throw badRequest('VALIDATION_ERROR', 'Bridge amount is not numeric.');
  }
  // Dust that floors to zero base units cannot be bridged: a 400, never a
  // signed zero-amount approval payload.
  if (!/^[1-9]\d*$/.test(sourceAmountBaseUnits)) {
    throw badRequest('VALIDATION_ERROR', 'Bridge amount is too small to represent on-chain. Increase the amount.');
  }

  return {
    bridgeQuoteId: stored.bridgeQuoteId,
    asset: stored.asset,
    amount: stored.amount,
    sourceNetwork: stored.sourceNetwork,
    destinationNetwork: 'Solana',
    bridgeContract: stored.bridgeAddress,
    sourceToken: stored.sourceTokenAddress,
    sourceAmountBaseUnits,
    destinationMint: stored.solanaMint,
    destinationAddress: params.destinationSolanaAddress,
    ccipConfig,
    evmChainId: null, // resolved client-side from the source network; never guessed here
    unsignedTransaction: null,
    nextStep:
      `Using your ${stored.sourceNetwork} wallet (${params.sourceWalletAddress}), approve ${stored.asset} ` +
      `(${stored.sourceTokenAddress}) for the verified Chainlink-CCIP bridge contract ${stored.bridgeAddress}, ` +
      `then call the bridge send function with destination Solana address ${params.destinationSolanaAddress}. ` +
      `Verify the contract address against GET /api/bridge/routes before signing.`,
  };
}
