import Database from 'better-sqlite3';

const db = new Database('./data/pas2me.sqlite');
console.log('stores', db.prepare('SELECT id, name, user_id FROM stores LIMIT 20').all());
console.log(
  'admins',
  db
    .prepare(
      `SELECT id, phone, role FROM users WHERE role = 'admin' OR phone LIKE '%8134481508'`
    )
    .all()
);
console.log('store_sql', db.prepare(`SELECT sql FROM sqlite_master WHERE name='stores'`).get());
