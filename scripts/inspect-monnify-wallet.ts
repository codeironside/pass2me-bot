import Database from 'better-sqlite3';

const db = new Database('./data/pas2me.sqlite');

const audits = db
  .prepare(
    `SELECT id, action, created_at, substr(CAST(details AS TEXT), 1, 500) AS details
     FROM bot_audit_logs
     WHERE action LIKE '%monnify%' OR action LIKE '%topup%' OR action LIKE '%webhook%'
     ORDER BY created_at DESC
     LIMIT 15`
  )
  .all();
console.log('=== audits ===');
console.log(JSON.stringify(audits, null, 2));

const wallets = db
  .prepare(
    `SELECT user_id, balance_kobo, monnify_account_number, monnify_account_reference, status
     FROM wallets LIMIT 20`
  )
  .all();
console.log('=== wallets ===');
console.log(JSON.stringify(wallets, null, 2));

try {
  const ledger = db
    .prepare(
      `SELECT id, user_id, type, amount_kobo, direction, provider_reference, created_at
       FROM wallet_ledger_entries
       ORDER BY created_at DESC LIMIT 15`
    )
    .all();
  console.log('=== ledger ===');
  console.log(JSON.stringify(ledger, null, 2));
} catch (e) {
  console.log('ledger query failed', e);
}
