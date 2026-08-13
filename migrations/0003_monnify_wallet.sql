-- Swap AlatPay wallet columns for Monnify (additive + backfill)

ALTER TABLE wallets ADD COLUMN monnify_account_number TEXT;
ALTER TABLE wallets ADD COLUMN monnify_account_reference TEXT;

UPDATE wallets
SET monnify_account_number = COALESCE(monnify_account_number, alatpay_account_number),
    monnify_account_reference = COALESCE(monnify_account_reference, alatpay_account_reference)
WHERE alatpay_account_number IS NOT NULL
   OR alatpay_account_reference IS NOT NULL;

-- Rebuild auto_topup_settings so funding_method allows monnify_checkout
CREATE TABLE IF NOT EXISTS auto_topup_settings_monnify (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 0,
    threshold_kobo INTEGER NOT NULL DEFAULT 0 CHECK (threshold_kobo >= 0),
    topup_amount_kobo INTEGER NOT NULL DEFAULT 0 CHECK (topup_amount_kobo >= 0),
    funding_method TEXT NOT NULL DEFAULT 'monnify_checkout'
      CHECK (funding_method IN ('monnify_checkout', 'alatpay_checkout', 'bank_transfer', 'card', 'ussd')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO auto_topup_settings_monnify
  (id, user_id, enabled, threshold_kobo, topup_amount_kobo, funding_method, created_at, updated_at)
SELECT
  id,
  user_id,
  enabled,
  threshold_kobo,
  topup_amount_kobo,
  CASE
    WHEN funding_method = 'alatpay_checkout' THEN 'monnify_checkout'
    ELSE funding_method
  END,
  created_at,
  updated_at
FROM auto_topup_settings;

DROP TABLE auto_topup_settings;
ALTER TABLE auto_topup_settings_monnify RENAME TO auto_topup_settings;
