-- Minimal transaction ledger (plan §26). Apply when DATABASE_URL is configured.
-- Never stores private keys, seeds, or secrets.
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('swap', 'bridge')),
  status TEXT NOT NULL,
  source_network TEXT,
  destination_network TEXT,
  source_asset TEXT,
  destination_asset TEXT,
  source_amount TEXT,
  destination_amount TEXT,
  source_wallet TEXT,
  destination_wallet TEXT,
  provider_reference TEXT,
  source_tx_hash TEXT,
  destination_tx_hash TEXT,
  ccip_message_id TEXT,
  signature TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions (status);
CREATE INDEX IF NOT EXISTS idx_transactions_source_tx ON transactions (source_tx_hash);
