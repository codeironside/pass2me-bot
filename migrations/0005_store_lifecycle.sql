-- Platform store lifecycle columns (wa-stores migration 0002).
-- Additive: existing D1/sqlite stores tables were created before these existed.

ALTER TABLE stores ADD COLUMN is_archived BOOLEAN DEFAULT FALSE;
ALTER TABLE stores ADD COLUMN archived_at DATETIME;
