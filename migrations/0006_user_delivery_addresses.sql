-- Saved customer dropoff locations (WhatsApp pin + LGA + landmark)

CREATE TABLE IF NOT EXISTS user_delivery_addresses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    phone TEXT NOT NULL,
    label TEXT NOT NULL,
    lga TEXT NOT NULL,
    address TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_delivery_addresses_user
  ON user_delivery_addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_user_delivery_addresses_default
  ON user_delivery_addresses(user_id, is_default);
