-- Saved-for-later list on the WhatsApp conversation (not the live cart)

ALTER TABLE bot_conversations ADD COLUMN saved_json TEXT NOT NULL DEFAULT '[]';
