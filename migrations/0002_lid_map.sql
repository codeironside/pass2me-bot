-- Map WhatsApp @lid identifiers to real phone numbers (cached from WAHA)
CREATE TABLE IF NOT EXISTS whatsapp_lid_map (
    id TEXT PRIMARY KEY,
    lid TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL,
    chat_id TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_lid_map_phone ON whatsapp_lid_map(phone);
