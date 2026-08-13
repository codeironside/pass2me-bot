/**
 * Sync Oluwatobi's phone after manual DB correction (…98 → …08)
 * and ensure wallet phone matches.
 *
 * Run: npx tsx scripts/fix-developer-phone.ts
 */
import { loadDotEnvFile, applyDevEnvDefaults } from '../src/config/dotenv';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { getDb, runMigrations, closeDb } from '../src/db/client';
import { normalizePhone, nowIso } from '../src/domain/ids';

loadDotEnvFile();
applyDevEnvDefaults();
resetEnvCache();
loadEnv();

const db = getDb();
runMigrations(db);

const correctLocal = '08134481508'; // 08 not 98
const correct = normalizePhone(correctLocal);
const wrong = normalizePhone('08134481598');

const user =
  (db
    .prepare(
      `SELECT * FROM users WHERE phone LIKE ? OR phone LIKE ? OR first_name = 'Oluwatobi' LIMIT 1`
    )
    .get(`%${correct.slice(-10)}`, `%${wrong.slice(-10)}`) as
    | { id: string; phone: string | null }
    | undefined) ?? undefined;

if (!user) {
  console.error('User not found. Run npm run seed:developer first.');
  closeDb();
  process.exit(1);
}

db.prepare(
  `UPDATE users SET phone = ?, updated_at = ? WHERE id = ?`
).run(correct, nowIso(), user.id);

db.prepare(
  `UPDATE wallets SET phone = ?, updated_at = ? WHERE user_id = ?`
).run(correct, nowIso(), user.id);

console.log({
  userId: user.id,
  previousPhone: user.phone,
  newPhone: correct,
  localFormat: correctLocal,
});

closeDb();
