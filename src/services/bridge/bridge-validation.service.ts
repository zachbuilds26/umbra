import Decimal from '../../utils/decimal.js';
import {
  getBridgesToSolana,
  getSourceTokenAddress,
  getSolanaMintForAsset,
} from './bridge-config.service.js';
import { isValidBridgeWallet, isValidSolanaAddress } from '../../utils/addresses.js';
import { badRequest } from '../../utils/errors.js';

// Plan §19: validate everything server-side before any bridge transaction.
export interface ValidatedBridgeRequest {
  sourceNetwork: string;
  asset: string;
  amount: string;
  destinationAddress: string;
  sourceTokenAddress: string;
  sourceDecimals: number;
  solanaMint: string;
  bridgeAddress: string;
}

export async function validateBridgeQuoteRequest(params: {
  sourceNetwork: string;
  asset: string;
  amount: string;
  destinationNetwork: string;
  destinationAddress: string;
}): Promise<ValidatedBridgeRequest> {
  const { sourceNetwork, asset, amount, destinationNetwork, destinationAddress } = params;

  // Umbra MVP is Solana-destination only (plan §19). Enforced, not suggested.
  if (destinationNetwork !== 'Solana') {
    throw badRequest('UNSUPPORTED_BRIDGE_ROUTE', 'Umbra only bridges to Solana.', {
      destinationNetwork,
    });
  }
  // NB: Decimal('0').isPositive() is true (+0 sign) — gt(0) is the correct zero guard.
  // Garbage amounts must be a 400, never an unhandled Decimal throw (500).
  let amountOk = false;
  try {
    amountOk = new Decimal(amount).gt(0);
  } catch {
    amountOk = false;
  }
  if (!amountOk) {
    throw badRequest('VALIDATION_ERROR', 'Amount must be greater than zero.');
  }
  if (!isValidSolanaAddress(destinationAddress)) {
    throw badRequest('INVALID_ADDRESS', 'destinationAddress is not a valid Solana address.');
  }

  const bridges = await getBridgesToSolana();
  const bridge = bridges.find((b) => b.network.toLowerCase() === sourceNetwork.toLowerCase());
  if (!bridge) {
    const supported = bridges.map((b) => b.network);
    throw badRequest('UNSUPPORTED_BRIDGE_ROUTE', `Source network ${sourceNetwork} is not supported to Solana.`, {
      supportedSources: supported,
    });
  }
  const product = (bridge.products ?? []).find((p) => p.symbol.toUpperCase() === asset.toUpperCase());
  if (!product) {
    throw badRequest('UNSUPPORTED_BRIDGE_ROUTE', `Asset ${asset} cannot currently be bridged from ${sourceNetwork} to Solana.`, {
      sourceNetwork,
      asset,
    });
  }

  const [source, dest] = await Promise.all([
    getSourceTokenAddress(sourceNetwork, asset),
    getSolanaMintForAsset(asset),
  ]);
  if (!source) throw badRequest('UNSUPPORTED_BRIDGE_ROUTE', `No verified source token for ${asset} on ${sourceNetwork}.`);
  if (!dest) throw badRequest('UNSUPPORTED_BRIDGE_ROUTE', `No verified Solana mint for ${asset}.`);

  return {
    sourceNetwork: bridge.network,
    asset: product.symbol,
    amount,
    destinationAddress,
    sourceTokenAddress: source.address,
    sourceDecimals: source.decimals,
    solanaMint: dest.address,
    bridgeAddress: bridge.address,
  };
}

export function validateBridgeWallets(sourceNetwork: string, sourceWalletAddress: string, destinationSolanaAddress: string): void {
  if (!isValidBridgeWallet(sourceNetwork, sourceWalletAddress)) {
    throw badRequest('INVALID_ADDRESS', `sourceWalletAddress is not valid for ${sourceNetwork}.`);
  }
  if (!isValidSolanaAddress(destinationSolanaAddress)) {
    throw badRequest('INVALID_ADDRESS', 'destinationSolanaAddress is not a valid Solana address.');
  }
}
