-- Logistics / waybill domain (Pas2me owns; Cabme dispatches)

ALTER TABLE wallets ADD COLUMN locked_kobo INTEGER NOT NULL DEFAULT 0 CHECK (locked_kobo >= 0);

CREATE TABLE IF NOT EXISTS store_delivery_rates (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    lga TEXT NOT NULL,
    fee_kobo INTEGER NOT NULL CHECK (fee_kobo >= 0),
    cabme_estimate_kobo INTEGER,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
    UNIQUE(store_id, lga)
);

CREATE INDEX IF NOT EXISTS idx_store_delivery_rates_store ON store_delivery_rates(store_id);

CREATE TABLE IF NOT EXISTS order_logistics (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE,
    store_id TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('vendor_delivery', 'dispatch_pickup', 'walk_in')),
    logistics_status TEXT NOT NULL DEFAULT 'logistics_selected'
      CHECK (logistics_status IN (
        'logistics_selected',
        'awaiting_payment',
        'paid_ready',
        'waybill_draft',
        'batched',
        'dispatch_requested',
        'rider_assigned',
        'en_route_to_pickup',
        'picked_up',
        'en_route_to_dropoff',
        'delivered',
        'closed',
        'dispatch_failed',
        'returned',
        'cancelled'
      )),
    dropoff_lga TEXT,
    dropoff_address TEXT,
    dropoff_lat REAL,
    dropoff_lng REAL,
    pickup_address TEXT,
    pickup_lat REAL,
    pickup_lng REAL,
    delivery_fee_kobo INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee_kobo >= 0),
    fee_payer TEXT NOT NULL DEFAULT 'none'
      CHECK (fee_payer IN ('buyer', 'vendor', 'none')),
    fee_hold_status TEXT NOT NULL DEFAULT 'none'
      CHECK (fee_hold_status IN ('none', 'held', 'released', 'refunded')),
    waybill_id TEXT,
    batch_id TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_order_logistics_store_status
  ON order_logistics(store_id, logistics_status);
CREATE INDEX IF NOT EXISTS idx_order_logistics_lga
  ON order_logistics(store_id, dropoff_lga);

CREATE TABLE IF NOT EXISTS waybill_batches (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    dropoff_lga TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN ('open', 'requested', 'assigned', 'in_transit', 'completed', 'split', 'cancelled')),
    requested_by_user_id TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS waybills (
    id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    batch_id TEXT,
    order_id TEXT,
    requester_role TEXT NOT NULL CHECK (requester_role IN ('vendor', 'buyer')),
    requester_user_id TEXT,
    dropoff_lga TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN (
        'draft',
        'requested',
        'rider_assigned',
        'en_route_to_pickup',
        'picked_up',
        'en_route_to_dropoff',
        'delivered',
        'failed',
        'cancelled',
        'split'
      )),
    cabme_parcel_id TEXT,
    cabme_status TEXT,
    amount_kobo INTEGER NOT NULL DEFAULT 0,
    fee_payer TEXT NOT NULL CHECK (fee_payer IN ('buyer', 'vendor')),
    sender_name TEXT,
    sender_phone TEXT,
    receiver_name TEXT,
    receiver_phone TEXT,
    pickup_address TEXT,
    dropoff_address TEXT,
    raw_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
    FOREIGN KEY (batch_id) REFERENCES waybill_batches(id) ON DELETE SET NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_waybills_store_status ON waybills(store_id, status);
CREATE INDEX IF NOT EXISTS idx_waybills_cabme ON waybills(cabme_parcel_id);

CREATE TABLE IF NOT EXISTS waybill_orders (
    waybill_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (waybill_id, order_id),
    FOREIGN KEY (waybill_id) REFERENCES waybills(id) ON DELETE CASCADE,
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cabme_user_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    cabme_user_id TEXT NOT NULL,
    phone TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS logistics_events (
    id TEXT PRIMARY KEY,
    order_id TEXT,
    waybill_id TEXT,
    batch_id TEXT,
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    notify_buyer INTEGER NOT NULL DEFAULT 0,
    notify_vendor INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
