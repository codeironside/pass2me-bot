import type { Db } from './client';
import { newId, normalizePhone, nowIso } from '../domain/ids';
import type { Kobo } from '../domain/money';
import { kobo } from '../domain/money';

export type StaffRole = 'business_admin' | 'location_manager' | 'cashier';
export type BotMode = 'customer' | 'merchant' | 'developer' | 'onboarding';

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  role: 'merchant' | 'admin';
  status: string;
}

export interface StoreRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  logo_url?: string | null;
  banner_url?: string | null;
  subscription_plan: 'starter' | 'growth' | 'enterprise';
  subscription_status: string;
  is_archived: number | boolean;
  settings: string | null;
}

export interface ProductRow {
  id: string;
  store_id: string;
  name: string;
  description: string | null;
  price: number | string;
  is_active: number | boolean;
  inventory_tracking: number | boolean;
  low_stock_threshold: number;
  image_url?: string | null;
  images?: string | string[] | null;
  brand?: string | null;
  category_id?: string | null;
  category_name?: string | null;
}

export interface WalletRow {
  id: string;
  user_id: string;
  phone: string;
  currency: string;
  balance_kobo: number;
  locked_kobo?: number;
  status: string;
  monnify_account_number: string | null;
  monnify_account_reference: string | null;
}

export interface ConversationRow {
  id: string;
  phone: string;
  user_id: string | null;
  mode: BotMode;
  state: string;
  selected_store_id: string | null;
  cart_json: string;
  saved_json?: string;
  context_json: string;
}

export interface CartItem {
  product_id: string;
  store_id: string;
  name: string;
  unit_price_kobo: number;
  quantity: number;
  variant_id?: string;
}

export interface StaffAssignmentRow {
  id: string;
  user_id: string;
  store_id: string;
  role: StaffRole;
  is_active: number;
}

export function findUserByPhone(db: Db, phone: string): UserRow | undefined {
  const normalized = normalizePhone(phone);
  const last10 = normalized.slice(-10);
  if (last10.length < 10) return undefined;
  const compact = `replace(replace(replace(IFNULL(phone, ''), '+', ''), ' ', ''), '-', '')`;
  return db
    .prepare(
      `SELECT * FROM users
       WHERE phone = ?
          OR ${compact} = ?
          OR ${compact} LIKE ?
       LIMIT 1`
    )
    .get(normalized, normalized, `%${last10}`) as UserRow | undefined;
}

export function findUserById(db: Db, id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
    | UserRow
    | undefined;
}

export function listStaffAssignments(
  db: Db,
  userId: string
): StaffAssignmentRow[] {
  return db
    .prepare(
      `SELECT * FROM staff_assignments WHERE user_id = ? AND is_active = 1`
    )
    .all(userId) as StaffAssignmentRow[];
}

export function listOwnedStores(db: Db, userId: string): StoreRow[] {
  return db
    .prepare(
      `SELECT * FROM stores WHERE user_id = ? AND IFNULL(is_archived, 0) = 0`
    )
    .all(userId) as StoreRow[];
}

export function getStore(db: Db, storeId: string): StoreRow | undefined {
  return db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId) as
    | StoreRow
    | undefined;
}

export function getOrCreateConversation(
  db: Db,
  phone: string
): ConversationRow {
  const existing = db
    .prepare('SELECT * FROM bot_conversations WHERE phone = ?')
    .get(phone) as ConversationRow | undefined;
  if (existing) return existing;

  const row: ConversationRow = {
    id: newId('conv'),
    phone,
    user_id: null,
    mode: 'customer',
    state: 'idle',
    selected_store_id: null,
    cart_json: '[]',
    saved_json: '[]',
    context_json: '{}',
  };
  db.prepare(
    `INSERT INTO bot_conversations
      (id, phone, user_id, mode, state, selected_store_id, cart_json, saved_json, context_json, last_message_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.phone,
    row.user_id,
    row.mode,
    row.state,
    row.selected_store_id,
    row.cart_json,
    row.saved_json,
    row.context_json,
    nowIso(),
    nowIso(),
    nowIso()
  );
  return row;
}

export function updateConversation(
  db: Db,
  phone: string,
  patch: Partial<{
    user_id: string | null;
    mode: BotMode;
    state: string;
    selected_store_id: string | null;
    cart_json: string;
    saved_json: string;
    context_json: string;
  }>
): ConversationRow {
  const current = getOrCreateConversation(db, phone);
  const next = {
    user_id: patch.user_id !== undefined ? patch.user_id : current.user_id,
    mode: patch.mode ?? current.mode,
    state: patch.state ?? current.state,
    selected_store_id:
      patch.selected_store_id !== undefined
        ? patch.selected_store_id
        : current.selected_store_id,
    cart_json: patch.cart_json ?? current.cart_json,
    saved_json: patch.saved_json ?? current.saved_json ?? '[]',
    context_json: patch.context_json ?? current.context_json,
  };
  db.prepare(
    `UPDATE bot_conversations
     SET user_id = ?, mode = ?, state = ?, selected_store_id = ?,
         cart_json = ?, saved_json = ?, context_json = ?, last_message_at = ?, updated_at = ?
     WHERE phone = ?`
  ).run(
    next.user_id,
    next.mode,
    next.state,
    next.selected_store_id,
    next.cart_json,
    next.saved_json,
    next.context_json,
    nowIso(),
    nowIso(),
    phone
  );
  return { ...current, ...next };
}

export function parseCart(cartJson: string): CartItem[] {
  try {
    const parsed = JSON.parse(cartJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is CartItem =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as CartItem).product_id === 'string' &&
        typeof (item as CartItem).quantity === 'number'
    );
  } catch {
    return [];
  }
}

export function getContext(conv: ConversationRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(conv.context_json) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return {};
}

export function getWalletByUserId(
  db: Db,
  userId: string
): WalletRow | undefined {
  return db
    .prepare('SELECT * FROM wallets WHERE user_id = ?')
    .get(userId) as WalletRow | undefined;
}

/**
 * Returns an existing wallet only if it already has a Monnify VA.
 * Does not create incomplete wallet rows — use provisionMonnifyWallet instead.
 */
export function ensureWallet(
  db: Db,
  userId: string,
  _phone: string
): WalletRow {
  const existing = getWalletByUserId(db, userId);
  if (existing?.monnify_account_number?.trim()) return existing;
  throw new Error(
    'Wallet not ready. Open *wallet* and provide your BVN or NIN to create it.'
  );
}

const MARKETPLACE_FROM = `
  FROM products p
  JOIN stores s ON s.id = p.store_id
  WHERE IFNULL(p.is_active, 1) = 1
    AND IFNULL(s.is_archived, 0) = 0
    AND IFNULL((
      SELECT i.quantity - IFNULL(i.reserved_quantity, 0)
      FROM inventory i
      WHERE i.product_id = p.id AND i.variant_id IS NULL
      LIMIT 1
    ), 0) > 0
`;

function marketplaceSearchClause(query?: string): {
  sql: string;
  params: string[];
} {
  const term = query?.trim();
  if (!term) return { sql: '', params: [] };
  const q = `%${term.replace(/%/g, '')}%`;
  return {
    sql: ` AND (p.name LIKE ? OR IFNULL(p.description, '') LIKE ? OR IFNULL(p.brand, '') LIKE ? OR s.name LIKE ?)`,
    params: [q, q, q, q],
  };
}

export function countMarketplaceProducts(db: Db, query?: string): number {
  const search = marketplaceSearchClause(query);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c ${MARKETPLACE_FROM}${search.sql}`
    )
    .get(...search.params) as { c: number };
  return Number(row?.c ?? 0);
}

export function listMarketplaceProducts(
  db: Db,
  opts: { query?: string; limit?: number; offset?: number } = {}
): Array<ProductRow & { store_name: string }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));
  const offset = Math.max(0, opts.offset ?? 0);
  const search = marketplaceSearchClause(opts.query);
  return db
    .prepare(
      `SELECT p.*, s.name AS store_name
       ${MARKETPLACE_FROM}${search.sql}
       ORDER BY p.is_featured DESC, p.updated_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...search.params, limit, offset) as Array<
    ProductRow & { store_name: string }
  >;
}

export function searchMarketplaceProducts(
  db: Db,
  query: string,
  limit = 10
): Array<ProductRow & { store_name: string }> {
  return listMarketplaceProducts(db, { query, limit, offset: 0 });
}

export function listFeaturedProducts(
  db: Db,
  limit = 10
): Array<ProductRow & { store_name: string }> {
  return listMarketplaceProducts(db, { limit, offset: 0 });
}

export function getProduct(
  db: Db,
  productId: string
): (ProductRow & { store_name: string }) | undefined {
  const sql = `SELECT p.*, s.name AS store_name, c.name AS category_name
       FROM products p
       JOIN stores s ON s.id = p.store_id
       LEFT JOIN categories c ON c.id = p.category_id`;
  const exact = db.prepare(`${sql} WHERE p.id = ?`).get(productId) as
    | (ProductRow & { store_name: string })
    | undefined;
  if (exact) return exact;
  return db
    .prepare(`${sql} WHERE lower(p.id) = lower(?)`)
    .get(productId) as (ProductRow & { store_name: string }) | undefined;
}

export function listStoreCategories(
  db: Db,
  storeId: string
): Array<{ id: string; name: string }> {
  return db
    .prepare(
      `SELECT id, name FROM categories WHERE store_id = ? ORDER BY sort_order, name LIMIT 12`
    )
    .all(storeId) as Array<{ id: string; name: string }>;
}

export function createStoreCategory(
  db: Db,
  storeId: string,
  name: string
): { id: string; name: string } {
  const id = newId('cat');
  const ts = nowIso();
  const trimmed = name.trim().slice(0, 80);
  db.prepare(
    `INSERT INTO categories (id, store_id, name, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)`
  ).run(id, storeId, trimmed, ts, ts);
  return { id, name: trimmed };
}

export function getInventoryQty(db: Db, productId: string): number {
  const row = db
    .prepare(
      `SELECT quantity, reserved_quantity FROM inventory WHERE product_id = ? AND variant_id IS NULL LIMIT 1`
    )
    .get(productId) as
    | { quantity: number; reserved_quantity: number }
    | undefined;
  if (!row) return 0;
  return Math.max(0, row.quantity - (row.reserved_quantity ?? 0));
}

/** Subtract sold qty from stock when an order is paid. Never throws; payment must not fail because of stock ledger. */
export function applyPaidOrderToInventory(db: Db, orderId: string): void {
  try {
    applyPaidOrderToInventoryInner(db, orderId);
  } catch (err) {
    console.error(`[inventory] applyPaidOrderToInventory failed order=${orderId}`, err);
  }
}

function movementsTableReady(db: Db): boolean {
  try {
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
    return true;
  } catch (err) {
    console.warn('[inventory] cannot create inventory_movements', err);
    return false;
  }
}

function applyPaidOrderToInventoryInner(db: Db, orderId: string): void {
  const hasMovements = movementsTableReady(db);
  const items = db
    .prepare(
      `SELECT product_id, variant_id, quantity FROM order_items WHERE order_id = ?`
    )
    .all(orderId) as Array<{
    product_id: string;
    variant_id?: string | null;
    quantity: number;
  }>;

  for (const item of items) {
    const reason = `order_paid:${orderId}:${item.product_id}`;
    if (hasMovements) {
      try {
        const already = db
          .prepare(`SELECT id FROM inventory_movements WHERE reason = ? LIMIT 1`)
          .get(reason) as { id: string } | undefined;
        if (already) continue;
      } catch {
        /* continue and decrement */
      }
    }

    const inv = (
      item.variant_id
        ? db
            .prepare(
              `SELECT id, quantity FROM inventory WHERE product_id = ? AND variant_id = ? LIMIT 1`
            )
            .get(item.product_id, item.variant_id)
        : db
            .prepare(
              `SELECT id, quantity FROM inventory WHERE product_id = ? AND variant_id IS NULL LIMIT 1`
            )
            .get(item.product_id)
    ) as { id: string; quantity: number } | undefined;

    if (!inv) {
      console.warn(
        `[inventory] no stock row for product=${item.product_id} order=${orderId}`
      );
      continue;
    }

    const prev = Number(inv.quantity) || 0;
    const sold = Math.max(0, Number(item.quantity) || 0);
    const next = Math.max(0, prev - sold);
    db.prepare(
      `UPDATE inventory SET quantity = ?, updated_at = ? WHERE id = ?`
    ).run(next, nowIso(), inv.id);
    if (hasMovements) {
      try {
        db.prepare(
          `INSERT INTO inventory_movements
            (id, product_id, previous_quantity, new_quantity, change_amount, reason, notes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          newId('im'),
          item.product_id,
          prev,
          next,
          -sold,
          reason,
          `Paid order ${orderId}`,
          nowIso()
        );
      } catch (err) {
        console.warn('[inventory] movement insert failed', err);
      }
    }
    console.log(
      `[inventory] ${item.product_id} ${prev} → ${next} (sold ${sold}) order=${orderId}`
    );
  }
}

export function writeBotAudit(
  db: Db,
  entry: {
    actor_user_id?: string | null;
    actor_phone?: string | null;
    action: string;
    resource_type: string;
    resource_id?: string | null;
    details?: Record<string, unknown>;
  }
): void {
  db.prepare(
    `INSERT INTO bot_audit_logs (id, actor_user_id, actor_phone, action, resource_type, resource_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId('aud'),
    entry.actor_user_id ?? null,
    entry.actor_phone ?? null,
    entry.action,
    entry.resource_type,
    entry.resource_id ?? null,
    entry.details ? JSON.stringify(entry.details) : null,
    nowIso()
  );
}

export interface UserDeliveryAddressRow {
  id: string;
  user_id: string;
  phone: string;
  label: string;
  lga: string;
  address: string;
  lat: number;
  lng: number;
  is_default: number | boolean;
}

const MAX_SAVED_DROPOFFS = 8;

export function listUserDeliveryAddresses(
  db: Db,
  userId: string
): UserDeliveryAddressRow[] {
  return db
    .prepare(
      `SELECT * FROM user_delivery_addresses
       WHERE user_id = ?
       ORDER BY is_default DESC, updated_at DESC
       LIMIT ?`
    )
    .all(userId, MAX_SAVED_DROPOFFS) as UserDeliveryAddressRow[];
}

export function getUserDeliveryAddress(
  db: Db,
  userId: string,
  addressId: string
): UserDeliveryAddressRow | undefined {
  return db
    .prepare(
      `SELECT * FROM user_delivery_addresses WHERE id = ? AND user_id = ?`
    )
    .get(addressId, userId) as UserDeliveryAddressRow | undefined;
}

export function saveUserDeliveryAddress(
  db: Db,
  params: {
    userId: string;
    phone: string;
    label: string;
    lga: string;
    address: string;
    lat: number;
    lng: number;
    makeDefault: boolean;
  }
): UserDeliveryAddressRow {
  const existing = listUserDeliveryAddresses(db, params.userId);
  const near = existing.find(
    (row) =>
      Math.abs(Number(row.lat) - params.lat) < 0.0003 &&
      Math.abs(Number(row.lng) - params.lng) < 0.0003
  );
  const makeDefault = params.makeDefault || existing.length === 0;
  if (makeDefault) {
    db.prepare(
      `UPDATE user_delivery_addresses SET is_default = 0, updated_at = ? WHERE user_id = ?`
    ).run(nowIso(), params.userId);
  }

  if (near) {
    db.prepare(
      `UPDATE user_delivery_addresses
       SET label = ?, lga = ?, address = ?, lat = ?, lng = ?, is_default = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      params.label.slice(0, 80),
      params.lga.slice(0, 80),
      params.address.slice(0, 240),
      params.lat,
      params.lng,
      makeDefault ? 1 : Number(near.is_default) ? 1 : 0,
      nowIso(),
      near.id
    );
    return getUserDeliveryAddress(db, params.userId, near.id)!;
  }

  if (existing.length >= MAX_SAVED_DROPOFFS) {
    const oldest = [...existing].sort((a, b) =>
      Number(a.is_default) ? 1 : Number(b.is_default) ? -1 : 0
    )[existing.length - 1];
    if (oldest && !Number(oldest.is_default)) {
      db.prepare(`DELETE FROM user_delivery_addresses WHERE id = ?`).run(
        oldest.id
      );
    }
  }

  const id = newId('adr');
  db.prepare(
    `INSERT INTO user_delivery_addresses
     (id, user_id, phone, label, lga, address, lat, lng, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.userId,
    params.phone,
    params.label.slice(0, 80),
    params.lga.slice(0, 80),
    params.address.slice(0, 240),
    params.lat,
    params.lng,
    makeDefault ? 1 : 0,
    nowIso(),
    nowIso()
  );
  return getUserDeliveryAddress(db, params.userId, id)!;
}

export function setDefaultUserDeliveryAddress(
  db: Db,
  userId: string,
  addressId: string
): boolean {
  const row = getUserDeliveryAddress(db, userId, addressId);
  if (!row) return false;
  const now = nowIso();
  db.prepare(
    `UPDATE user_delivery_addresses SET is_default = 0, updated_at = ? WHERE user_id = ?`
  ).run(now, userId);
  db.prepare(
    `UPDATE user_delivery_addresses SET is_default = 1, updated_at = ? WHERE id = ? AND user_id = ?`
  ).run(now, addressId, userId);
  return true;
}

export function asKoboBalance(balance: number): Kobo {
  return kobo(balance);
}
