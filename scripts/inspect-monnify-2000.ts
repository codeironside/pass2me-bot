import Database from 'better-sqlite3';

const db = new Database('./data/pas2me.sqlite');

const wallet = db
  .prepare(
    `SELECT user_id, balance_kobo, monnify_account_number, monnify_account_reference
     FROM wallets WHERE user_id = 'usr_No1_QccOGHVxY7xgLC3Yj'`
  )
  .get();
console.log('wallet', wallet);

const audits = db
  .prepare(
    `SELECT created_at, substr(CAST(details AS TEXT), 1, 800) AS details
     FROM bot_audit_logs
     WHERE action = 'monnify_payment_webhook'
     ORDER BY created_at DESC
     LIMIT 20`
  )
  .all();
console.log('webhook count', audits.length);
for (const a of audits) {
  const d = String(a.details);
  const amount = /"amountPaid":\s*([^,}\s]+)/.exec(d)?.[1];
  const tx = /"transactionReference":"([^"]+)"/.exec(d)?.[1];
  console.log(a.created_at, 'amountPaid=', amount, 'tx=', tx);
}

const txs = db
  .prepare(
    `SELECT id, type, direction, amount_kobo, idempotency_key, provider_reference, created_at
     FROM wallet_transactions
     WHERE user_id = 'usr_No1_QccOGHVxY7xgLC3Yj'
     ORDER BY created_at DESC
     LIMIT 20`
  )
  .all();
console.log('wallet_transactions', txs);
