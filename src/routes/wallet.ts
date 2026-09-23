import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getWalletBalances } from '../services/solana/balances.js';
import { isValidSolanaAddress } from '../utils/addresses.js';
import { badRequest } from '../utils/errors.js';

export async function walletRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/wallet/:address/balances — Umbra-token balances with display amounts.
  // Powers the swap box balance readout + MAX button. Read-only RPC, no keys.
  app.get('/api/wallet/:address/balances', async (req) => {
    const params = z.object({ address: z.string().min(1).max(48) }).parse(req.params);
    if (!isValidSolanaAddress(params.address)) {
      throw badRequest('INVALID_ADDRESS', 'Wallet address is not a valid Solana address.');
    }
    const balances = await getWalletBalances(params.address);
    return { address: params.address, balances };
  });
}
