import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getBscPlatforms, getBscTokens, searchBscTokens, getBscPrices } from '../services/binance/rwa.service.js';
import { badRequest } from '../utils/errors.js';

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// BSC tokenized-stocks leg (Binance Web3 API: RWA Data). Read-only market
// data; the secret never leaves the backend — the browser only sees these
// shaped responses, never provider payloads or credentials.
export async function bscRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/bsc/platforms -> [{ platformId, tickerCount }]
  app.get(
    '/api/bsc/platforms',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async () => ({ platforms: await getBscPlatforms() }),
  );

  // GET /api/bsc/tokens?platform=ondo|bstock&tab=9 (Magnificent 7)
  app.get(
    '/api/bsc/tokens',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const q = z
        .object({
          platform: z.enum(['ondo', 'bstock']).optional(),
          tab: z.coerce.number().int().min(1).max(13).optional(),
        })
        .parse(req.query);
      return { tokens: await getBscTokens({ platformId: q.platform, tabId: q.tab }) };
    },
  );

  // GET /api/bsc/search?keyword=NVDA
  app.get(
    '/api/bsc/search',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const q = z.object({ keyword: z.string().min(1).max(64) }).parse(req.query);
      return { tokens: await searchBscTokens(q.keyword) };
    },
  );

  // GET /api/bsc/prices?addresses=0x..,0x.. (max 100) -> on-chain vs reference
  app.get(
    '/api/bsc/prices',
    { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } },
    async (req) => {
      const q = z.object({ addresses: z.string().min(1).max(4300) }).parse(req.query);
      const addresses = q.addresses.split(',').map((a) => a.trim()).filter(Boolean);
      if (addresses.length === 0 || addresses.length > 100) {
        throw badRequest('VALIDATION_ERROR', 'Pass 1 to 100 comma-separated token addresses.');
      }
      for (const address of addresses) {
        if (!ETH_ADDRESS_RE.test(address)) {
          throw badRequest('VALIDATION_ERROR', 'One address is not a valid BSC token address.');
        }
      }
      return { prices: await getBscPrices(addresses) };
    },
  );
}
