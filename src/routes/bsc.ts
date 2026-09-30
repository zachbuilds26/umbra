import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getBscPlatforms, getBscTokens, searchBscTokens, getBscPrices } from '../services/binance/rwa.service.js';
import {
  resolveBscToken,
  getBscQuote,
  buildBscSwap,
  getBscApprove,
  getBscTxStatus,
  simulateBscTx,
  toBaseUnits,
  fromBaseUnits,
} from '../services/binance/trading.service.js';
import { badRequest } from '../utils/errors.js';

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

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

  const pairQuery = z.object({
    sell: z.string().min(1).max(16),
    buy: z.string().min(1).max(16),
    amount: z.string().min(1).max(32),
    wallet: z.string().regex(WALLET_RE, 'Invalid wallet address.').optional(),
    slippage: z.coerce.number().min(0).max(50).default(0.5),
  });

  // GET /api/bsc/quote?sell=USDC&buy=NVDAx&amount=500[&wallet=0x..][&slippage=0.5]
  app.get(
    '/api/bsc/quote',
    { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } },
    async (req) => {
      const q = pairQuery.parse(req.query);
      if (q.sell.toUpperCase() === q.buy.toUpperCase()) {
        throw badRequest('VALIDATION_ERROR', 'Choose a different token.');
      }
      const [sell, buy] = await Promise.all([resolveBscToken(q.sell), resolveBscToken(q.buy)]);
      // xStocks quote RFQ-side and demand a receiver wallet; stables and
      // bStocks quote wallet-free. Fail with the connect line, not a param error.
      if (!q.wallet && (sell.kind === 'xstock' || buy.kind === 'xstock')) {
        throw badRequest('VALIDATION_ERROR', 'Connect a wallet first.');
      }
      const quote = await getBscQuote({
        sell,
        buy,
        amountBaseUnits: toBaseUnits(q.amount, sell.decimals),
        wallet: q.wallet,
      });
      return {
        sell: sell.symbol,
        buy: buy.symbol,
        sellAmount: q.amount,
        sellTokenAddress: sell.address,
        sellDecimals: sell.decimals,
        buyTokenAddress: buy.address,
        buyDecimals: quote.buyDecimals,
        buyAmount: fromBaseUnits(quote.buyAmountBaseUnits, quote.buyDecimals),
        buyAmountBaseUnits: quote.buyAmountBaseUnits,
        vendor: quote.vendorName,
        executionMode: quote.executionMode,
        priceImpactPercent: quote.priceImpactPercent,
        approveTarget: quote.approveTarget,
        // Provider quoteIds live ~30s; the build step re-quotes, so this id is
        // informational — the frontend never sends it back.
        expiresIn: 30,
      };
    },
  );

  // GET /api/bsc/swap-build?sell=USDC&buy=NVDAx&amount=500&wallet=0x..[&slippage=0.5]
  // Re-quotes fresh inside the 30s window, then builds the unsigned EVM tx the
  // wallet signs via eth_sendTransaction. Nothing is broadcast here.
  app.get(
    '/api/bsc/swap-build',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const q = pairQuery.parse(req.query);
      if (!q.wallet) throw badRequest('VALIDATION_ERROR', 'Connect a wallet first.');
      if (q.sell.toUpperCase() === q.buy.toUpperCase()) {
        throw badRequest('VALIDATION_ERROR', 'Choose a different token.');
      }
      const [sell, buy] = await Promise.all([resolveBscToken(q.sell), resolveBscToken(q.buy)]);
      const quote = await getBscQuote({
        sell,
        buy,
        amountBaseUnits: toBaseUnits(q.amount, sell.decimals),
        wallet: q.wallet,
      });
      const tx = await buildBscSwap({
        quote,
        sell,
        buy,
        wallet: q.wallet,
        slippagePercent: String(q.slippage),
      });
      return {
        sell: sell.symbol,
        buy: buy.symbol,
        tx,
        minReceiveAmount: tx.minReceiveAmount,
        minReceiveDisplay: fromBaseUnits(tx.minReceiveAmount, quote.buyDecimals),
      };
    },
  );

  // GET /api/bsc/approve?sell=USDC&amount=500 -> spender + calldata for the
  // ERC-20 approve tx. The wallet sends it only when allowance is short.
  app.get(
    '/api/bsc/approve',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const q = z.object({ sell: z.string().min(1).max(16), amount: z.string().min(1).max(32) }).parse(req.query);
      const token = await resolveBscToken(q.sell);
      return {
        token: token.symbol,
        tokenAddress: token.address,
        ...(await getBscApprove({ token, amountBaseUnits: toBaseUnits(q.amount, token.decimals) })),
      };
    },
  );

  // GET /api/bsc/status?txHash=0x.. -> pending | success | fail | unknown
  app.get(
    '/api/bsc/status',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const q = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Invalid transaction hash.') }).parse(req.query);
      return getBscTxStatus(q.txHash);
    },
  );

  // POST /api/bsc/simulate { tx: { from, to, data, value } } -> dry-run.
  // Call with the EXACT tx the wallet is about to send, after any approval.
  // A FAILED prediction means the swap would revert: do not send it.
  app.post(
    '/api/bsc/simulate',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const body = z
        .object({
          tx: z.object({
            from: z.string().regex(WALLET_RE, 'Invalid wallet address.'),
            to: z.string().regex(WALLET_RE, 'Invalid address.'),
            data: z.string().regex(/^0x[0-9a-fA-F]*$/, 'Invalid calldata.').max(16384),
            value: z.string().regex(/^\d{1,78}$/, 'Invalid value.'),
          }),
        })
        .parse(req.body);
      const result = await simulateBscTx(body.tx);
      if (!result.ok) {
        throw badRequest('TRANSACTION_FAILED', 'Simulation failed — try again.');
      }
      return { ok: true };
    },
  );
}
