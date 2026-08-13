/**
 * Seed a level-1 developer user + wallet for local testing.
 * Run: npx tsx scripts/seed-developer.ts
 */
import { loadDotEnvFile, applyDevEnvDefaults } from '../src/config/dotenv';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { getDb, runMigrations, closeDb } from '../src/db/client';
import { newId, normalizePhone, nowIso } from '../src/domain/ids';
import { ensureWallet } from '../src/db/repos';

loadDotEnvFile();
applyDevEnvDefaults();
resetEnvCache();
loadEnv();

const db = getDb();
runMigrations(db);

const phoneInput = process.env.SEED_PHONE ?? '08134481508';
const phone = normalizePhone(phoneInput); // 2348134481598
const email = `oluwatobi.ayoola+dev@pas2me.local`;
const firstName = 'Oluwatobi';
const lastName = 'Ayoola';

const existing = db
  .prepare(
    `SELECT id, phone FROM users WHERE phone = ? OR phone LIKE ? OR email = ? LIMIT 1`
  )
  .get(phone, `%${phone.slice(-10)}`, email) as
  | { id: string; phone: string | null }
  | undefined;

let userId: string;

if (existing) {
  userId = existing.id;
  db.prepare(
    `UPDATE users
     SET first_name = ?, last_name = ?, phone = ?, role = 'admin', status = 'active', updated_at = ?
     WHERE id = ?`
  ).run(firstName, lastName, phone, nowIso(), userId);
  console.log(`Updated existing user ${userId}`);
} else {
  userId = newId('usr');
  db.prepare(
    `INSERT INTO users
      (id, email, password_hash, first_name, last_name, phone, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'admin', 'active', ?, ?)`
  ).run(
    userId,
    email,
    'seed-no-login-password',
    firstName,
    lastName,
    phone,
    nowIso(),
    nowIso()
  );
  console.log(`Inserted user ${userId}`);
}

db.prepare(
  `INSERT INTO developer_access
    (id, user_id, level, can_view_ledger, can_adjust_flags, can_manual_credit, notes, created_at, updated_at)
   VALUES (?, ?, 4, 1, 1, 1, ?, ?, ?)
   ON CONFLICT(user_id) DO UPDATE SET
     level = 4,
     can_view_ledger = 1,
     can_adjust_flags = 1,
     can_manual_credit = 1,
     notes = excluded.notes,
     updated_at = excluded.updated_at`
).run(
  newId('dev'),
  userId,
  'Seeded superadmin — full platform access via bot modes',
  nowIso(),
  nowIso()
);

const wallet = ensureWallet(db, userId, phone);
console.log(`Wallet ${wallet.id} balance_kobo=${wallet.balance_kobo}`);

console.log(
  JSON.stringify(
    {
      userId,
      name: `${firstName} ${lastName}`,
      phone,
      phoneLocal: phoneInput,
      email,
      role: 'admin',
      developerLevel: 4,
      walletId: wallet.id,
      db: loadEnv().DATABASE_PATH,
    },
    null,
    2
  )
);

closeDb();
