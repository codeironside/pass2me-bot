import Database from 'better-sqlite3';

const db = new Database('./data/pas2me.sqlite');
console.log(
  'users',
  db.prepare('SELECT id, phone, first_name, last_name, role FROM users').all()
);
console.log(
  'wallets',
  db.prepare('SELECT id, user_id, phone, balance_kobo FROM wallets').all()
);
console.log(
  'convs',
  db.prepare('SELECT phone, user_id, mode FROM bot_conversations').all()
);
console.log(
  'recent msgs',
  db
    .prepare(
      `SELECT actor_phone, details, created_at FROM bot_audit_logs
       WHERE action = 'wa_message' ORDER BY created_at DESC LIMIT 8`
    )
    .all()
);
db.close();
