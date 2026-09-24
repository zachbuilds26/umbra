# Umbra Backend

One-place backend to **bring tokenized stocks to Solana and trade them there**:

- **Swap** listed xStocks *and* PreStocks pre-IPO stocks ↔ USDC/USDT on Solana via the
  current Jupiter Swap API V2 (`/order`). Stock↔stable only: one side must be a
  supported stable, the other a supported stock (xStock or PreStocks).
- **Bridge** supported xStocks from EVM source chains **to Solana only**, driven exclusively by the xStocks public bridge config (`GET /public/bridges?destinationNetwork=Solana`, Chainlink CCIP).

The frontend only ever sees clean domain objects (`asset`, `quote`, `route`, `transaction`, status). Provider shapes never leak past the service layer. Users sign their own transactions — the backend never touches private keys.

## Stack

Node 20+ · TypeScript · Fastify · Zod · `@solana/web3.js` · `decimal.js` (exact money math) · `tsx` for dev/test.

## Setup

```bash
cp .env.example .env   # Windows: copy .env.example .env
npm install
npm run dev            # watch mode on :3002
```

Key env vars:

| Var | Purpose |
| --- | ------- |
| `SOLANA_RPC_URL` | Solana RPC (default mainnet-beta) |
| `JUPITER_API_KEY` | Jupiter Developer Platform key. Empty = keyless 0.5 RPS dev mode |
| `JUPITER_PRICE_URL` | Jupiter Price V3 (default `https://api.jup.ag/price/v3`) |
| `ZEROEX_API_KEY` / `PYTH_API_KEY` / `FINNHUB_API_KEY` | Optional legs; empty = that leg disabled |
| `XSTOCKS_API_BASE_URL` | `https://api.xstocks.fi/api/v2` |
| `DATABASE_URL` | Render Postgres string. Set = persisted ledger (auto-migrated); unset = in-memory |
| `PORT` | Listen port (Render injects its own) |
| `CORS_ORIGINS` | Comma-separated frontend origins |

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health`, `/health/providers` | Liveness + xStocks/Jupiter/Solana checks |
| GET | `/api/assets` | USDC + all Solana xStocks (live discovery) |
| GET | `/api/assets/:symbol` | Enriched asset (price + multiplier) |
| GET | `/api/assets/:symbol/price` | USD reference price (display only) |
| GET | `/api/assets/:symbol/fair-price` | Pyth equity + xStock legs, reference, token-vs-equity spread (needs `PYTH_API_KEY`) |
| GET | `/api/assets/ticker?symbols=NVDAx,…` | One-call tape prices + 24h change (max 50) |
| GET | `/api/assets/:symbol/summary` | Hover-card bundle: asset, change, sparkline, fair spreads, flags |
| GET | `/api/wallet/:address/balances` | Umbra-token balances, display amounts (powers MAX) |
| GET | `/api/swap/quote?sell=USDC&buy=NVDAx&amount=500[&userPublicKey=…][&slippageBps=50]` | Executable quote, provider-neutral route |
| POST | `/api/swap/transaction` `{quoteId, userPublicKey}` | Unsigned base64 tx for the wallet to sign |
| POST | `/api/swap/broadcast` `{quoteId, userPublicKey, signedTransaction}` | Broadcast the wallet-signed swap (a signed-but-unsent tx can never confirm) |
| POST | `/api/transactions/swap` `{quoteId, signature, wallet}` | Record + confirm, normalized status |
| GET | `/api/transactions?limit=20&wallet=…` | That wallet's transactions (Activity tab) |
| GET | `/api/transactions/:id?wallet=…` | Swap status (`submitted → confirmed/failed/expired`) |
| GET | `/api/bridge/routes` | Sources → Solana only, from live config |
| POST | `/api/bridge/quote` `{sourceNetwork, asset, amount, destinationNetwork:"Solana", destinationAddress}` | Validated 1:1 intent (fees/times `null` unless the config provides them) |
| POST | `/api/bridge/transaction` `{bridgeQuoteId, sourceWalletAddress, destinationSolanaAddress}` | Verified bridge contract + token data + `trackingId` |
| GET | `/api/bridge/transactions/:id?wallet=…` | Bridge status (`source_pending → source_confirmed → ccip_in_flight → …`) |
| POST | `/api/bridge/transactions/:id/source` `{sourceTxHash, ccipMessageId?, wallet}` | Record source confirmation (owning wallet only) |
| GET | `/api/dbc/presets` | Equity launch presets with real curve economics |
| GET | `/api/dbc/pools?baseMint=…` | DBC pool state, or `pool:null` for unlaunched names |
| GET | `/api/dbc/quote?pool=…&side=buy\|sell&amount=…&slippageBps=50` | Live curve quote (max 5% slippage) |
| POST | `/api/dbc/transaction` `{pool, side, amount, userPublicKey, slippageBps}` | Unsigned exact-in swap against a pool |

Errors always look like `{ "error": { "code": "UNSUPPORTED_BRIDGE_ROUTE", "message": "…", "details": {} } }`. Secrets are never logged or returned.

## Non-negotiables (enforced in code)

1. **No invented bridge addresses** — `bridge-config.service.ts` fetches + caches (3 min TTL) the public config; every route/quote revalidates against it.
2. **No authenticated xStocks flows** — public endpoints only (`/public/assets*`, `/public/bridges`).
3. **Jupiter is infrastructure** — quotes normalize to `{sell, receive, rate, route:[{symbol},{symbol}]}`; venue names never appear.
4. **No custody** — unsigned txs out, wallet signatures in. The backend only relays a transaction the connected wallet signed (it verifies the signer matches the quote's wallet); no `execute-any-contract` endpoint exists.
5. **Exact money math** — `decimal.js` everywhere; `display = raw × multiplier` on Solana Token-2022 xStocks. `Decimal('0').isPositive()` is `true`, so zero-guards use `.gt(0)`.
6. **xStocks symbols are case-sensitive** (`NVDAx` ≠ `NVDAX`) — `canonicalSymbol()` normalizes to `BASE + 'x'`.

## Demo (small amounts, supported routes)

```bash
# Health
curl localhost:3002/health/providers
# Assets + price
curl localhost:3002/api/assets/NVDAx
# Swap quote USDC -> NVDAx, then NVDAx -> USDC
curl "localhost:3002/api/swap/quote?sell=USDC&buy=NVDAx&amount=500"
# Bridge discovery + quote Ethereum NVDAx -> Solana
curl localhost:3002/api/bridge/routes
curl -X POST localhost:3002/api/bridge/quote -H "Content-Type: application/json" \
  -d '{"sourceNetwork":"Ethereum","asset":"NVDAx","amount":"1.5","destinationNetwork":"Solana","destinationAddress":"<SOLANA_PUBKEY>"}'
```

## Meteora DBC — devnet end-to-end (free)

Launches a real bonding-curve pool **and trades it**, on devnet, for zero SOL. Same builders the API uses (`createConfig` → `createPool` → pool read → quote → buy), so it proves the mainnet path without funding anything.

```bash
# 1) build + inspect the createConfig instruction, sends nothing
$env:SOLANA_RPC_URL="https://api.devnet.solana.com"
npx tsx scripts/dbc-devnet-e2e.ts --dry-run

# 2) run it for real (needs a funded devnet key; the public faucet is IP-limited)
#    fund once, free: https://faucet.solana.com
$env:DEVNET_PAYER_KEY="<base58 secret key>"
npx tsx scripts/dbc-devnet-e2e.ts
```

The script hard-refuses to run against a mainnet RPC. Devnet has no canonical USDC, so it creates its own 6-decimal quote token and mints it to the payer; on mainnet the same code uses real USDC. Launch cost on mainnet is ~0.005 SOL (mostly rent), optional — nothing in the API requires a pool to exist.

## Tests

```bash
npm test        # node:test — multiplier math, validation, bridge/swap rejection paths
npm run typecheck
```

`src/db/schema.sql` holds the Postgres ledger for when the in-memory store needs persistence.
