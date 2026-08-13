-- Additive bot tables (do not alter platform CHECKs)

CREATE TABLE IF NOT EXISTS wallets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'NGN',
    balance_kobo INTEGER NOT NULL DEFAULT 0 CHECK (balance_kobo >= 0),
    alatpay_account_number TEXT,
    alatpay_account_reference TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
    id TEXT PRIMARY KEY,
    wallet_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('credit', 'debit')),
    amount_kobo INTEGER NOT NULL CHECK (amount_kobo > 0),
    balance_after_kobo INTEGER NOT NULL CHECK (balance_after_kobo >= 0),
    type TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'NGN',
    provider TEXT,
    provider_reference TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    store_id TEXT,
    order_id TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (wallet_id) REFERENCES wallets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_wallet ON wallet_transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_provider_ref ON wallet_transactions(provider_reference);

CREATE TABLE IF NOT EXISTS auto_topup_settings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 0,
    threshold_kobo INTEGER NOT NULL DEFAULT 0 CHECK (threshold_kobo >= 0),
    topup_amount_kobo INTEGER NOT NULL DEFAULT 0 CHECK (topup_amount_kobo >= 0),
    funding_method TEXT NOT NULL DEFAULT 'alatpay_checkout'
      CHECK (funding_method IN ('alatpay_checkout', 'bank_transfer', 'card', 'ussd')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bot_conversations (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL UNIQUE,
    user_id TEXT,
    mode TEXT NOT NULL DEFAULT 'customer'
      CHECK (mode IN ('customer', 'merchant', 'developer', 'onboarding')),
    state TEXT NOT NULL DEFAULT 'idle',
    selected_store_id TEXT,
    cart_json TEXT NOT NULL DEFAULT '[]',
    context_json TEXT NOT NULL DEFAULT '{}',
    last_message_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (selected_store_id) REFERENCES stores(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_conversations_phone ON bot_conversations(phone);

CREATE TABLE IF NOT EXISTS staff_assignments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    store_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN (
      'business_admin',
      'location_manager',
      'cashier'
    )),
    is_active INTEGER NOT NULL DEFAULT 1,
    invited_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
    UNIQUE(user_id, store_id, role)
);

CREATE INDEX IF NOT EXISTS idx_staff_assignments_user ON staff_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_staff_assignments_store ON staff_assignments(store_id);

CREATE TABLE IF NOT EXISTS staff_invites (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    store_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN (
      'business_admin',
      'location_manager',
      'cashier'
    )),
    invited_phone TEXT,
    invited_by_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
    expires_at DATETIME NOT NULL,
    accepted_user_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
    FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS airtime_orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    beneficiary_phone TEXT NOT NULL,
    amount_kobo INTEGER NOT NULL CHECK (amount_kobo > 0),
    network TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'processing', 'successful', 'failed')),
    provider TEXT NOT NULL DEFAULT 'flutterwave',
    provider_reference TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS developer_access (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1 AND level <= 5),
    can_view_ledger INTEGER NOT NULL DEFAULT 1,
    can_adjust_flags INTEGER NOT NULL DEFAULT 0,
    can_manual_credit INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sms_otp_challenges (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    purpose TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at DATETIME NOT NULL,
    consumed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sms_otp_phone ON sms_otp_challenges(phone);

CREATE TABLE IF NOT EXISTS bot_audit_logs (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT,
    actor_phone TEXT,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bot_audit_created ON bot_audit_logs(created_at);
