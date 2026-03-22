CREATE TABLE IF NOT EXISTS payout_fee_entries (
  id SERIAL PRIMARY KEY,
  payout_id TEXT NOT NULL,
  entry_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  gross_amount NUMERIC(12,2) DEFAULT 0,
  fee_amount NUMERIC(12,2) DEFAULT 0,
  net_amount NUMERIC(12,2) DEFAULT 0,
  payment_id TEXT,
  square_data JSONB
);

CREATE INDEX IF NOT EXISTS idx_payout_fee_entries_effective_at ON payout_fee_entries(effective_at);
CREATE INDEX IF NOT EXISTS idx_payout_fee_entries_type ON payout_fee_entries(type);
CREATE INDEX IF NOT EXISTS idx_payout_fee_entries_payment_id ON payout_fee_entries(payment_id);
