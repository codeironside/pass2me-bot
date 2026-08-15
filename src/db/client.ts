import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getEnv } from '../config/env';
import { getD1Client, D1Client } from './d1';
import { D1DatabaseAdapter } from './d1Adapter';

export type Db = Database.Database;
export { getD1Client, D1Client, D1DatabaseAdapter };

let dbInstance: Db | null = null;

function wranglerD1Dir(): string {
  return path.resolve(
    process.cwd(),
    '..',
    'wa-stores-main',
    '.wrangler',
    'state',
    'v3',
    'd1',
    'miniflare-D1DatabaseObject'
  );
}

type LocalD1File = { name: string; full: string; size: number; mtime: number };

function listLocalD1Files(): LocalD1File[] {
  const dir = wranglerD1Dir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sqlite'))
    .map((name) => {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      return { name, full, size: st.size, mtime: st.mtimeMs };
    });
}

/** If Wrangler created a fresh empty D1, copy the complete sibling onto it. */
function seedLiveD1FromRichest(live: LocalD1File, files: LocalD1File[]): void {
  const richest = [...files].sort((a, b) => b.size - a.size)[0];
  if (!richest || richest.full === live.full) return;
  if (live.size >= richest.size * 0.8) return;
  try {
    fs.copyFileSync(richest.full, live.full);
    for (const suffix of ['-wal', '-shm']) {
      const src = richest.full + suffix;
      if (fs.existsSync(src)) fs.copyFileSync(src, live.full + suffix);
    }
    console.log(`[DB] seeded live D1 ${live.name} from ${richest.name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[DB] could not seed live D1: ${msg}`);
  }
}

function resolveD1OrSqlitePath(configuredPath: string): string {
  const resolvedConfigured = path.resolve(configuredPath);
  const files = listLocalD1Files();
  if (files.length > 0) {
    const configured = files.find(
      (f) => path.resolve(f.full) === resolvedConfigured
    );
    const live =
      configured ?? [...files].sort((a, b) => b.mtime - a.mtime)[0];
    seedLiveD1FromRichest(live, files);
    console.log(`\n[DB] Shared local D1 pas2me-stores:`);
    console.log(`     ${live.full}\n`);
    return live.full;
  }

  if (fs.existsSync(resolvedConfigured)) return resolvedConfigured;
  return resolvedConfigured;
}

export function getDb(): Db {
  if (dbInstance) return dbInstance;
  const env = getEnv();

  const d1Adapter = new D1DatabaseAdapter();
  if (env.CLOUDFLARE_D1_REMOTE && d1Adapter.isConfigured()) {
    console.log(
      `\n[DB] Connected to Remote Cloudflare D1 API (${env.CLOUDFLARE_DATABASE_ID})\n`
    );
    dbInstance = d1Adapter as unknown as Db;
    return dbInstance;
  }
  if (d1Adapter.isConfigured() && !env.CLOUDFLARE_D1_REMOTE) {
    console.log(
      '[DB] Cloudflare D1 credentials present; using local wrangler D1 (set CLOUDFLARE_D1_REMOTE=true for hosted).'
    );
  }

  const targetDbPath = resolveD1OrSqlitePath(env.DATABASE_PATH);
  const dir = path.dirname(targetDbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(targetDbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  dbInstance = db;
  syncSharedTablesFromSiblingD1(db);
  return db;
}

let lastSiblingSyncAt = 0;

/**
 * Miniflare can create a new D1 sqlite when wrangler config changes.
 * Dashboard signups then land in a sibling file the bot is not reading.
 * Copy users/stores across so WhatsApp identity still resolves.
 */
export function syncSharedTablesFromSiblingD1(db: Db, force = false): void {
  const now = Date.now();
  if (!force && now - lastSiblingSyncAt < 2000) return;
  lastSiblingSyncAt = now;

  const dbPath = typeof db.name === 'string' ? db.name : '';
  if (!dbPath || !dbPath.includes('miniflare-D1DatabaseObject')) return;

  const dir = path.dirname(dbPath);
  let siblings: string[] = [];
  try {
    siblings = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sqlite'))
      .map((f) => path.join(dir, f))
      .filter((full) => path.resolve(full) !== path.resolve(dbPath));
  } catch {
    return;
  }
  if (siblings.length === 0) return;

  siblings.forEach((full, i) => {
    const alias = `sib${i}`;
    const attachPath = full.replace(/\\/g, '/').replace(/'/g, "''");
    try {
      db.exec(`ATTACH DATABASE '${attachPath}' AS ${alias}`);
      const tables = new Set(
        (
          db
            .prepare(
              `SELECT name FROM ${alias}.sqlite_master WHERE type = 'table'`
            )
            .all() as Array<{ name: string }>
        ).map((r) => r.name)
      );
      if (tables.has('users')) {
        db.exec(`INSERT OR IGNORE INTO users SELECT * FROM ${alias}.users`);
        try {
          db.exec(
            `UPDATE users SET
               phone = COALESCE(
                 (SELECT s.phone FROM ${alias}.users s WHERE s.id = users.id),
                 users.phone
               ),
               email = COALESCE(
                 (SELECT s.email FROM ${alias}.users s WHERE s.id = users.id),
                 users.email
               )
             WHERE id IN (SELECT id FROM ${alias}.users)`
          );
        } catch {
          /* column mismatch between sibling files */
        }
      }
      if (tables.has('stores')) {
        db.exec(`INSERT OR IGNORE INTO stores SELECT * FROM ${alias}.stores`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[DB] sibling sync skipped for ${path.basename(full)}: ${msg}`);
    } finally {
      try {
        db.exec(`DETACH DATABASE ${alias}`);
      } catch {
        /* ignore */
      }
    }
  });
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function tableColumns(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

function ensureColumn(
  db: Db,
  table: string,
  column: string,
  definition: string
): void {
  if (tableColumns(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[DB] added column ${table}.${column}`);
}

/** Columns the bot expects on the shared platform `stores` table. */
function ensurePlatformStoreColumns(db: Db): void {
  const tables = tableColumns(db, 'stores');
  if (tables.size === 0) return;
  ensureColumn(db, 'stores', 'is_archived', 'BOOLEAN DEFAULT 0');
  ensureColumn(db, 'stores', 'archived_at', 'DATETIME');
}

function ensureProductCatalogColumns(db: Db): void {
  if (tableColumns(db, 'products').size === 0) return;
  ensureColumn(db, 'products', 'brand', 'TEXT');
}

function ensureInventorySupportTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      previous_quantity INTEGER NOT NULL,
      new_quantity INTEGER NOT NULL,
      change_amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      notes TEXT,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function ensureBotConversationColumns(db: Db): void {
  if (tableColumns(db, 'bot_conversations').size === 0) return;
  ensureColumn(
    db,
    'bot_conversations',
    'saved_json',
    "TEXT NOT NULL DEFAULT '[]'"
  );
}

export function runMigrations(db: Db = getDb()): void {
  const remote = db instanceof D1DatabaseAdapter;
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS _bot_migrations (
        id TEXT PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (remote) {
      console.warn(
        `[DB] remote D1 migration bootstrap skipped: ${msg}\n     Bot tables should already exist on pas2me-stores.`
      );
      return;
    }
    throw err;
  }

  const migrationsDir = path.resolve(process.cwd(), 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    (db.prepare('SELECT id FROM _bot_migrations').all() as Array<{ id: string }>).map(
      (r) => r.id
    )
  );

  const insert = db.prepare(
    'INSERT INTO _bot_migrations (id) VALUES (?)'
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    try {
      db.exec(sql);
      insert.run(file);
      console.log(`Applied migration: ${file}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('already exists') ||
        msg.toLowerCase().includes('duplicate column name')
      ) {
        insert.run(file);
        console.log(`Migration ${file} skipped (already present in database).`);
      } else {
        throw err;
      }
    }
  }

  ensurePlatformStoreColumns(db);
  ensureProductCatalogColumns(db);
  ensureBotConversationColumns(db);
  try {
    ensureInventorySupportTables(db);
  } catch (err) {
    console.warn('[DB] inventory_movements ensure failed', err);
  }
}
