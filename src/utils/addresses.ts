import { PublicKey } from '@solana/web3.js';

// Solana base58 public key validation (plan §30).
export function isValidSolanaAddress(value: string): boolean {
  try {
    const pk = new PublicKey(value);
    return PublicKey.isOnCurve(pk.toBytes());
  } catch {
    return false;
  }
}

// EVM 0x address validation (plan §30). Checksum not enforced — format only.
export function isValidEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

// TON addresses (base64url-ish, various forms) and Tron (base58 T-prefix) are only
// loosely validated: bridge MVP sources are EVM + Solana, so anything else is rejected
// at route validation with UNSUPPORTED_NETWORK before address format matters.
export function isValidBridgeWallet(network: string, address: string): boolean {
  const n = network.toLowerCase();
  if (n === 'solana') return isValidSolanaAddress(address);
  return isValidEvmAddress(address);
}
