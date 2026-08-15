import type { Db } from '../../db/client';
import {
  createStoreCategory,
  getContext,
  getOrCreateConversation,
  getStore,
  listStoreCategories,
  updateConversation,
  writeBotAudit,
  type CartItem,
} from '../../db/repos';
import { decimalToKobo, formatNgn, kobo, koboToNairaString, nairaToKobo } from '../../domain/money';
import { newId, normalizePhone, nowIso } from '../../domain/ids';
import {
  deliverToWhatsAppNumber,
  sendDocument,
  sendImage,
  sendMenuMessage,
  sendText,
  type IncomingWahaMessage,
} from '../../services/whatsapp';
import {
  downloadInboundImage,
  loadCoverBytes,
  saveProductPhoto,
} from '../../services/media';
import { buildOrderReceiptPdf } from '../../services/receiptPdf';
import {
  assertWithinLimit,
  getPlanFeatures,
  type SubscriptionPlan,
} from '../../guardrails/plans';
import {
  canAdjustStock,
  canRecordSale,
  type ResolvedIdentity,
} from '../identity';
import { resolveCommand, type MenuOption } from '../command';

type InvRoles = {
  isOwner: boolean;
  roles: Array<'business_admin' | 'location_manager' | 'cashier'>;
};

function rolesForStore(identity: ResolvedIdentity, storeId: string): InvRoles {
  if (identity.isSuperAdmin) {
    return { isOwner: true, roles: ['business_admin'] };
  }
  const isOwner = identity.ownedStoreIds.includes(storeId);
  const roles = identity.staffRoles
    .filter((r) => r.storeId === storeId)
    .map((r) => r.role);
  return { isOwner, roles };
}

function rememberMenu(db: Db, phone: string, options: MenuOption[]): void {
  const conv = getOrCreateConversation(db, phone);
  const ctx = getContext(conv);
  updateConversation(db, phone, {
    context_json: JSON.stringify({ ...ctx, last_menu: options }),
  });
}

function lastMenu(db: Db, phone: string): MenuOption[] {
  const conv = getOrCreateConversation(db, phone);
  const ctx = getContext(conv);
  const menu = ctx.last_menu;
  if (!Array.isArray(menu)) return [];
  return menu.filter(
    (m): m is MenuOption =>
      typeof m === 'object' &&
      m !== null &&
      typeof (m as MenuOption).id === 'string' &&
      typeof (m as MenuOption).label === 'string'
  );
}

type StockRow = {
  id: string;
  name: string;
  description: string | null;
  price: number | string;
  is_active: number | boolean;
  low_stock_threshold: number | null;
  images: unknown;
  brand: string | null;
  category_name: string | null;
  qty: number;
  reserved: number;
};

const PRODUCT_PAGE = 8;

function accessibleStoreIds(identity: ResolvedIdentity): string[] {
  return [
    ...new Set([
      ...identity.ownedStoreIds,
      ...identity.staffRoles.map((s) => s.storeId),
    ]),
  ];
}

function listStockRows(db: Db, storeId: string): StockRow[] {
  return db
    .prepare(
      `SELECT p.id, p.name, p.description, p.price, p.is_active, p.low_stock_threshold, p.images, p.brand,
              c.name AS category_name,
              IFNULL(i.quantity, 0) AS qty,
              IFNULL(i.reserved_quantity, 0) AS reserved
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN inventory i ON i.product_id = p.id AND i.variant_id IS NULL
       WHERE p.store_id = ?
       ORDER BY p.name COLLATE NOCASE`
    )
    .all(storeId) as StockRow[];
}

function availableOf(row: StockRow): number {
  return Math.max(0, Number(row.qty) - Number(row.reserved));
}

function isLow(row: StockRow): boolean {
  const threshold = Number(row.low_stock_threshold ?? 5);
  return availableOf(row) <= threshold;
}

function firstImageUrl(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim();
    if (/^https?:\/\//i.test(t)) return t;
    try {
      return firstImageUrl(JSON.parse(t));
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstImageUrl(item);
      if (found) return found;
    }
  }
  return null;
}

async function sendPhoto(
  chatId: string,
  url: string | null,
  caption: string
): Promise<void> {
  if (!url) {
    await sendText(chatId, caption);
    return;
  }
  const bytes = await loadCoverBytes(url);
  if (bytes) await sendImage(chatId, bytes, caption);
  else await sendText(chatId, caption);
}

export async function showStockHub(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  page = 0
): Promise<void> {
  const store = getStore(db, storeId);
  const rows = listStockRows(db, storeId);
  const low = rows.filter(isLow).length;
  const pageCount = Math.max(1, Math.ceil(rows.length / PRODUCT_PAGE));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const slice = rows.slice(
    safePage * PRODUCT_PAGE,
    safePage * PRODUCT_PAGE + PRODUCT_PAGE
  );

  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  updateConversation(db, identity.phone, {
    state: 'merch_inv_list',
    selected_store_id: storeId,
    context_json: JSON.stringify({
      ...ctx,
      inv_store_id: storeId,
      inv_page: safePage,
    }),
  });

  const lines = [
    `*Inventory — ${store?.name ?? 'Store'}*`,
    `${rows.length} product(s) Â· ${low} low stock Â· page ${safePage + 1}/${pageCount}`,
    '',
  ];
  if (rows.length === 0) {
    lines.push('No products yet. Reply *add product* to create one.');
    const emptyOpts: MenuOption[] = [
      { id: 'merch_add_product', label: 'Add product' },
      { id: 'inv_stores', label: 'All stores' },
      { id: 'cust_home', label: 'Main menu' },
    ];
    rememberMenu(db, identity.phone, emptyOpts);
    await sendMenuMessage(
      chatId,
      lines.join('\n'),
      emptyOpts.map((o) => ({ id: o.id, text: o.label }))
    );
    return;
  }

  const options: MenuOption[] = slice.map((p) => ({
    id: `inv_item_${p.id}`,
    label: `${p.name.slice(0, 20)} (${availableOf(p)})`,
  }));
  if (safePage + 1 < pageCount) {
    options.push({ id: 'inv_next', label: 'Next page' });
  }
  if (safePage > 0) {
    options.push({ id: 'inv_prev', label: 'Previous page' });
  }
  options.push({ id: 'inv_low', label: 'Low stock' });
  options.push({ id: 'inv_moves', label: 'Stock history' });
  options.push({ id: 'inv_sell_pick', label: 'Sell walk-in' });
  options.push({ id: 'merch_add_product', label: 'Add product' });
  options.push({ id: 'inv_stores', label: 'All stores' });
  options.push({ id: 'cust_home', label: 'Main menu' });
  rememberMenu(db, identity.phone, options);

  for (const p of slice) {
    const flag = isLow(p) ? ' ⚠ low' : '';
    const hidden = Number(p.is_active) ? '' : ' Â· hidden';
    const out = availableOf(p) < 1 ? ' Â· hidden from buyers' : '';
    lines.push(
      `• *${p.name}*${flag}${hidden}${out}`,
      `  ${p.brand ? `${p.brand} Â· ` : ''}on hand ${p.qty} Â· available ${availableOf(p)} Â· ${formatNgn(decimalToKobo(p.price))}`
    );
  }
  lines.push('', 'Pick a product for info, edit, stock, photo, or walk-in sale.');
  await sendMenuMessage(
    chatId,
    lines.join('\n'),
    options.map((o) => ({ id: o.id, text: o.label }))
  );
}

async function showStorePicker(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  const ids = accessibleStoreIds(identity);
  if (ids.length === 0) {
    const options: MenuOption[] = [
      { id: 'merch_add_store', label: 'Create store' },
      { id: 'cust_home', label: 'Main menu' },
    ];
    rememberMenu(db, identity.phone, options);
    updateConversation(db, identity.phone, { state: 'merch_inv_stores' });
    await sendMenuMessage(
      chatId,
      [
        '*Inventory*',
        '',
        'You have no store yet. Create one to add products.',
        'Products must belong to a store. Buyers only see items with stock above 0.',
      ].join('\n'),
      options.map((o) => ({ id: o.id, text: o.label }))
    );
    return;
  }

  const options: MenuOption[] = [];
  const lines = [
    '*Inventory*',
    'Pick a store to see products, add stock, or edit listings.',
    '',
  ];
  for (const id of ids) {
    const store = getStore(db, id);
    if (!store || Number(store.is_archived)) continue;
    const rows = listStockRows(db, id);
    const low = rows.filter(isLow).length;
    const hiddenBuyers = rows.filter((r) => availableOf(r) < 1).length;
    lines.push(
      `• *${store.name}*`,
      `  ${rows.length} product(s)${low ? ` Â· ${low} low stock` : ''}${hiddenBuyers ? ` Â· ${hiddenBuyers} not visible to buyers` : ''}`
    );
    options.push({
      id: `inv_store_${id}`,
      label: `${store.name.slice(0, 22)} (${rows.length})`,
    });
  }
  options.push({ id: 'merch_add_store', label: 'Create store' });
  options.push({ id: 'cust_home', label: 'Main menu' });
  rememberMenu(db, identity.phone, options);
  updateConversation(db, identity.phone, { state: 'merch_inv_stores' });
  await sendMenuMessage(
    chatId,
    lines.join('\n'),
    options.map((o) => ({ id: o.id, text: o.label }))
  );
}

/** Main entry from customer menu item 8 / reply *inventory*. */
export async function openInventoryHub(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  if (!identity.user) {
    await sendText(
      chatId,
      [
        'Inventory needs a Pas2me account.',
        'Sign up at https://www.pas2me.com with this WhatsApp number,',
        'then reply *inventory*.',
      ].join('\n')
    );
    return;
  }
  updateConversation(db, identity.phone, { mode: 'merchant', state: 'idle' });
  await showStorePicker(db, identity, chatId);
}

async function showProductCard(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  productId: string
): Promise<void> {
  const row = listStockRows(db, storeId).find((p) => p.id === productId);
  if (!row) {
    await sendText(chatId, 'Product not found at this location.');
    await showStockHub(db, identity, chatId, storeId);
    return;
  }
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  updateConversation(db, identity.phone, {
    state: 'merch_inv_item',
    context_json: JSON.stringify({ ...ctx, inv_product_id: productId }),
  });
  const options: MenuOption[] = [
    { id: 'inv_sell', label: 'Sell walk-in' },
    { id: 'inv_edit', label: 'Edit details' },
    { id: 'inv_receive', label: 'Receive stock (+)' },
    { id: 'inv_set', label: 'Set quantity' },
    { id: 'inv_history', label: 'Stock history' },
    { id: 'inv_photo', label: 'Change photo' },
    {
      id: 'inv_toggle',
      label: Number(row.is_active) ? 'Hide from shop' : 'Show in shop',
    },
    { id: 'inv_back', label: 'Back to products' },
  ];
  rememberMenu(db, identity.phone, options);
  const caption = [
    `*${row.name}*`,
    row.brand ? `Brand: ${row.brand}` : '',
    row.category_name ? `Category: ${row.category_name}` : '',
    row.description ? `About: ${row.description}` : '',
    `Price: ${formatNgn(decimalToKobo(row.price))}`,
    `On hand: ${row.qty} Â· reserved: ${row.reserved} Â· available: ${availableOf(row)}`,
    availableOf(row) < 1 ? 'Buyers cannot see this until stock is above 0.' : '',
    `Low-stock alert at: ${Number(row.low_stock_threshold ?? 5)}`,
    `Shop listing: ${Number(row.is_active) ? 'visible' : 'hidden'}`,
    `ID: \`${row.id}\``,
  ]
    .filter(Boolean)
    .join('\n');
  await sendPhoto(chatId, firstImageUrl(row.images), caption);
  await sendMenuMessage(
    chatId,
    'Inventory actions:',
    options.map((o) => ({ id: o.id, text: o.label }))
  );
}

function applyQtyChange(
  db: Db,
  identity: ResolvedIdentity,
  productId: string,
  nextQty: number,
  reason: string
): { previous: number; next: number } {
  const inv = db
    .prepare(
      `SELECT id, quantity FROM inventory WHERE product_id = ? AND variant_id IS NULL`
    )
    .get(productId) as { id: string; quantity: number } | undefined;
  const previous = Number(inv?.quantity ?? 0);
  const next = Math.max(0, nextQty);
  const ts = nowIso();
  if (inv) {
    db.prepare(
      `UPDATE inventory SET quantity = ?, updated_at = ? WHERE id = ?`
    ).run(next, ts, inv.id);
  } else {
    db.prepare(
      `INSERT INTO inventory (id, product_id, quantity, reserved_quantity, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`
    ).run(newId('inv'), productId, next, ts, ts);
  }
  db.prepare(
    `INSERT INTO inventory_movements
      (id, product_id, previous_quantity, new_quantity, change_amount, reason, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId('im'),
    productId,
    previous,
    next,
    next - previous,
    reason,
    identity.user?.id ?? null,
    ts
  );
  writeBotAudit(db, {
    actor_user_id: identity.user?.id,
    actor_phone: identity.phone,
    action: 'stock_adjust',
    resource_type: 'product',
    resource_id: productId,
    details: { previous, next, reason },
  });
  return { previous, next };
}

async function showEditMenu(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  productId: string
): Promise<void> {
  const options: MenuOption[] = [
    { id: 'inv_edit_name', label: 'Name' },
    { id: 'inv_edit_price', label: 'Price' },
    { id: 'inv_edit_brand', label: 'Brand' },
    { id: 'inv_edit_category', label: 'Category' },
    { id: 'inv_edit_desc', label: 'Description' },
    { id: `inv_item_${productId}`, label: 'Back' },
  ];
  rememberMenu(db, identity.phone, options);
  updateConversation(db, identity.phone, { state: 'merch_inv_edit' });
  await sendMenuMessage(
    chatId,
    'What do you want to edit?',
    options.map((o) => ({ id: o.id, text: o.label }))
  );
}

async function promptEditCategory(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string
): Promise<void> {
  const cats = listStoreCategories(db, storeId);
  const options: MenuOption[] = cats.map((c) => ({
    id: `cat_${c.id}`,
    label: c.name.slice(0, 28),
  }));
  options.push({ id: 'cat_new', label: 'New category' });
  options.push({ id: 'cat_skip', label: 'Clear category' });
  rememberMenu(db, identity.phone, options);
  updateConversation(db, identity.phone, { state: 'merch_inv_edit_category' });
  await sendMenuMessage(
    chatId,
    'Pick a category, type a new name, or clear:',
    options.map((o) => ({ id: o.id, text: o.label }))
  );
}

async function showLowStock(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string
): Promise<void> {
  const rows = listStockRows(db, storeId).filter(isLow);
  if (rows.length === 0) {
    await sendText(chatId, 'No low-stock products right now.');
    await showStockHub(db, identity, chatId, storeId);
    return;
  }
  const lines = ['*Low stock*', ''];
  for (const p of rows) {
    lines.push(
      `• *${p.name}* — available ${availableOf(p)} (alert ≤ ${Number(p.low_stock_threshold ?? 5)})`
    );
  }
  await sendText(chatId, lines.join('\n'));
  await showStockHub(db, identity, chatId, storeId);
}

async function showRecentMoves(
  db: Db,
  chatId: string,
  storeId: string
): Promise<void> {
  const rows = db
    .prepare(
      `SELECT m.created_at, m.reason, m.change_amount, m.new_quantity, p.name
       FROM inventory_movements m
       JOIN products p ON p.id = m.product_id
       WHERE p.store_id = ?
       ORDER BY m.created_at DESC
       LIMIT 12`
    )
    .all(storeId) as Array<{
    created_at: string;
    reason: string;
    change_amount: number;
    new_quantity: number;
    name: string;
  }>;
  if (rows.length === 0) {
    await sendText(chatId, 'No stock movements yet.');
    return;
  }
  const lines = ['*Recent stock movements*', ''];
  for (const r of rows) {
    const delta = Number(r.change_amount);
    const sign = delta > 0 ? `+${delta}` : String(delta);
    lines.push(
      `• ${r.name}: ${sign} → ${r.new_quantity} (${r.reason})`
    );
  }
  await sendText(chatId, lines.join('\n'));
}

async function showProductHistory(
  db: Db,
  chatId: string,
  productId: string
): Promise<void> {
  const rows = db
    .prepare(
      `SELECT created_at, reason, previous_quantity, new_quantity, change_amount
       FROM inventory_movements
       WHERE product_id = ?
       ORDER BY created_at DESC
       LIMIT 10`
    )
    .all(productId) as Array<{
    created_at: string;
    reason: string;
    previous_quantity: number;
    new_quantity: number;
    change_amount: number;
  }>;
  if (rows.length === 0) {
    await sendText(chatId, 'No history for this product yet.');
    return;
  }
  const lines = ['*Stock history*', ''];
  for (const r of rows) {
    lines.push(
      `• ${r.reason}: ${r.previous_quantity} → ${r.new_quantity} (${Number(r.change_amount) > 0 ? '+' : ''}${r.change_amount})`
    );
  }
  await sendText(chatId, lines.join('\n'));
}

async function showWalkInProductPicker(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string
): Promise<void> {
  const rows = listStockRows(db, storeId).filter((p) => availableOf(p) > 0);
  if (rows.length === 0) {
    await sendText(
      chatId,
      'No products with stock to sell. Receive stock first, then try again.'
    );
    await showStockHub(db, identity, chatId, storeId);
    return;
  }
  const options: MenuOption[] = rows.slice(0, 8).map((p) => ({
    id: `inv_sell_${p.id}`,
    label: `${p.name.slice(0, 18)} (${availableOf(p)})`,
  }));
  options.push({ id: 'inv_back', label: 'Back' });
  rememberMenu(db, identity.phone, options);
  updateConversation(db, identity.phone, { state: 'merch_inv_sell_pick' });
  await sendMenuMessage(
    chatId,
    'Pick a product to sell to a walk-in customer:',
    options.map((o) => ({ id: o.id, text: o.label }))
  );
}

async function promptWalkInQty(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  productId: string
): Promise<void> {
  const row = listStockRows(db, storeId).find((p) => p.id === productId);
  if (!row) {
    await sendText(chatId, 'Product not found.');
    await showStockHub(db, identity, chatId, storeId);
    return;
  }
  const avail = availableOf(row);
  if (avail < 1) {
    await sendText(chatId, `*${row.name}* has no available stock.`);
    await showProductCard(db, identity, chatId, storeId, productId);
    return;
  }
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  updateConversation(db, identity.phone, {
    state: 'merch_inv_sell_qty',
    context_json: JSON.stringify({
      ...ctx,
      inv_store_id: storeId,
      inv_product_id: productId,
      inv_sell_qty: null,
      inv_sell_method: null,
      inv_sell_phone: null,
      last_menu: [],
    }),
  });
  await sendText(
    chatId,
    [
      `Sell *${row.name}* to a walk-in customer.`,
      `Price: ${formatNgn(decimalToKobo(row.price))}`,
      `Available: ${avail}`,
      '',
      'Type the *quantity* as a number (example: *2*).',
      'Reply *cancel* to stop.',
    ].join('\n')
  );
}

async function promptWalkInPay(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  qty: number
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  const productId = String(ctx.inv_product_id ?? '');
  updateConversation(db, identity.phone, {
    state: 'merch_inv_sell_pay',
    context_json: JSON.stringify({ ...ctx, inv_sell_qty: qty }),
  });
  const options: MenuOption[] = [
    { id: 'inv_pay_cash', label: 'Cash' },
    { id: 'inv_pay_card', label: 'Card (POS)' },
    { id: 'inv_pay_transfer', label: 'Transfer' },
    { id: `inv_item_${productId}`, label: 'Cancel' },
  ];
  rememberMenu(db, identity.phone, options);
  await sendMenuMessage(
    chatId,
    [
      `Qty *${qty}*. How did the customer pay?`,
      '',
      'Collect cash, card on *your POS*, or transfer to *your* account.',
      'Pas2me does not take this payment.',
    ].join('\n'),
    options.map((o) => ({ id: o.id, text: o.label }))
  );
}

async function promptWalkInName(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  method: WalkInPayMethod
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  updateConversation(db, identity.phone, {
    state: 'merch_inv_sell_name',
    context_json: JSON.stringify({
      ...ctx,
      inv_sell_method: method,
      inv_sell_name: null,
      last_menu: [],
    }),
  });
  await sendText(
    chatId,
    [
      `Payment: *${walkInPayLabel(method)}* (collected by you, not Pas2me).`,
      '',
      "Type the customer's *full name* for the receipt.",
      'Reply *cancel* to stop.',
    ].join('\n')
  );
}

async function promptWalkInPhone(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  method: WalkInPayMethod
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  updateConversation(db, identity.phone, {
    state: 'merch_inv_sell_phone',
    context_json: JSON.stringify({
      ...ctx,
      inv_sell_method: method,
      last_menu: [],
    }),
  });
  await sendText(
    chatId,
    [
      `Customer: *${String(ctx.inv_sell_name ?? '').trim() || '—'}*`,
      '',
      'Type their *WhatsApp number* so we can send the receipt.',
      'Example: *08031234567*',
      'Reply *cancel* to stop.',
    ].join('\n')
  );
}

type WalkInPayMethod = 'cash' | 'card' | 'transfer';

function walkInPayLabel(method: WalkInPayMethod): string {
  if (method === 'card') return 'Card (POS)';
  if (method === 'transfer') return 'Transfer';
  return 'Cash';
}

function walkInPayDb(method: WalkInPayMethod): string {
  if (method === 'card') return 'pos_card';
  if (method === 'transfer') return 'offline_transfer';
  return 'cash';
}

function formatWalkInPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('234') && digits.length === 13) {
    return `+234 ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
  }
  return phone;
}

function parseWalkInCustomerPhone(raw: string): string | null {
  const phone = normalizePhone(raw);
  if (phone.startsWith('234') && phone.length === 13) return phone;
  return null;
}

async function ensureWalkInCustomer(
  db: Db,
  storeId: string,
  customerPhone: string | null,
  customerName: string | null
): Promise<string | null> {
  if (!customerPhone) return null;
  const existing = db
    .prepare(
      `SELECT id FROM customers WHERE store_id = ? AND whatsapp_number = ?`
    )
    .get(storeId, customerPhone) as { id: string } | undefined;
  if (existing) {
    if (customerName) {
      db.prepare(
        `UPDATE customers SET name = ?, updated_at = ? WHERE id = ?`
      ).run(customerName, nowIso(), existing.id);
    }
    return existing.id;
  }
  const id = newId('cus');
  db.prepare(
    `INSERT INTO customers (id, store_id, whatsapp_number, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, storeId, customerPhone, customerName, nowIso(), nowIso());
  return id;
}

async function buildWalkInReceiptPdfs(params: {
  db: Db;
  store: { id: string; name?: string; whatsapp_number?: string | null };
  product: { id: string; name: string };
  qty: number;
  unitKobo: number;
  totalKobo: number;
  orderNumber: string;
  method: WalkInPayMethod;
  customerPhone: string | null;
  customerName: string;
}): Promise<{
  cart: CartItem[];
  fileName: string;
  buyerPdf: Buffer | null;
  vendorPdf: Buffer | null;
  buyerCaption: string;
  vendorCaption: string;
}> {
  const cart: CartItem[] = [
    {
      product_id: params.product.id,
      store_id: params.store.id,
      name: params.product.name,
      unit_price_kobo: params.unitKobo,
      quantity: params.qty,
    },
  ];
  const fileName = `Pas2me-receipt-${params.orderNumber}.pdf`;
  const paidVia = `${walkInPayLabel(params.method)} (in store)`;
  const storeName = params.store.name?.trim() || 'Pas2me store';
  const buyerPhone = params.customerPhone
    ? formatWalkInPhone(params.customerPhone)
    : '—';
  const pdfBase = {
    orderNumber: params.orderNumber,
    storeName,
    storePhone: params.store.whatsapp_number ?? null,
    buyerName: params.customerName,
    buyerPhone,
    cart,
    itemsTotal: kobo(params.totalKobo),
    deliveryFeeKobo: 0,
    total: kobo(params.totalKobo),
    fulfillment: 'Walk-in',
    paidVia,
    issuedAt: new Date(),
  };
  const buyerCaption = [
    `Hi *${params.customerName}*,`,
    '',
    `Here is your receipt from *${storeName}*.`,
    `Order *${params.orderNumber}*`,
    `*${params.product.name}* ×${params.qty}`,
    `Total: *${formatNgn(kobo(params.totalKobo))}*`,
    `Paid in store: ${walkInPayLabel(params.method)}`,
  ].join('\n');
  const vendorCaption = [
    `*WALK-IN SALE*`,
    `Order *${params.orderNumber}*`,
    `Buyer: *${params.customerName}* (${buyerPhone})`,
    `• ${params.qty}× ${params.product.name}`,
    `Total: *${formatNgn(kobo(params.totalKobo))}*`,
    `Paid in store: ${walkInPayLabel(params.method)}`,
  ].join('\n');

  let buyerPdf: Buffer | null = null;
  let vendorPdf: Buffer | null = null;
  try {
    buyerPdf = await buildOrderReceiptPdf(params.db, {
      ...pdfBase,
      audience: 'buyer',
    });
    vendorPdf = await buildOrderReceiptPdf(params.db, {
      ...pdfBase,
      audience: 'vendor',
    });
  } catch (err) {
    console.error('[walk-in] receipt PDF build failed', err);
  }
  return { cart, fileName, buyerPdf, vendorPdf, buyerCaption, vendorCaption };
}

async function completeWalkInSale(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  productId: string,
  qty: number,
  method: WalkInPayMethod,
  customerPhone: string | null,
  customerName: string | null
): Promise<void> {
  const { isOwner, roles } = rolesForStore(identity, storeId);
  if (!canRecordSale(roles, isOwner, identity.isSuperAdmin)) {
    await sendText(chatId, 'You cannot record walk-in sales.');
    return;
  }

  const product = db
    .prepare(
      `SELECT id, name, price FROM products WHERE id = ? AND store_id = ?`
    )
    .get(productId, storeId) as
    | { id: string; name: string; price: number | string }
    | undefined;
  if (!product) {
    await sendText(chatId, 'Product not found.');
    return;
  }

  const row = listStockRows(db, storeId).find((p) => p.id === productId);
  const avail = row ? availableOf(row) : 0;
  if (qty < 1 || qty > avail) {
    await sendText(
      chatId,
      `Need between 1 and ${avail} unit(s) for *${product.name}*.`
    );
    await promptWalkInQty(db, identity, chatId, storeId, productId);
    return;
  }

  const store = getStore(db, storeId);
  if (!store) return;
  const features = getPlanFeatures(store.subscription_plan as SubscriptionPlan);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const orderCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM orders WHERE store_id = ? AND created_at >= ?`
      )
      .get(storeId, monthStart.toISOString()) as { c: number }
  ).c;
  const gate = assertWithinLimit(
    orderCount,
    features.max_orders_per_month,
    'Orders'
  );
  if (!gate.ok) {
    await sendText(chatId, gate.message);
    return;
  }

  const unit = decimalToKobo(product.price);
  const totalKobo = Number(unit) * qty;
  const totalNaira = totalKobo / 100;
  const orderId = newId('ord');
  const orderNumber = `POS${Date.now().toString(36).toUpperCase()}`;
  const customerId = await ensureWalkInCustomer(
    db,
    storeId,
    customerPhone,
    customerName
  );

  db.prepare(
    `INSERT INTO orders
      (id, store_id, customer_id, order_number, status, subtotal, tax_amount, shipping_amount,
       total_amount, currency, payment_status, payment_method, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'confirmed', ?, 0, 0, ?, 'NGN', 'paid', ?, ?, ?, ?)`
  ).run(
    orderId,
    storeId,
    customerId,
    orderNumber,
    totalNaira,
    totalNaira,
    walkInPayDb(method),
    `Walk-in ${walkInPayLabel(method)} for ${customerName ?? 'walk-in customer'} collected in store by ${identity.phone}. Not processed by Pas2me.`,
    nowIso(),
    nowIso()
  );
  db.prepare(
    `INSERT INTO order_items
      (id, order_id, product_id, name, quantity, unit_price, total_price, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId('oi'),
    orderId,
    product.id,
    product.name,
    qty,
    Number(product.price),
    totalNaira,
    nowIso()
  );

  applyQtyChange(
    db,
    identity,
    productId,
    Math.max(0, Number(row?.qty ?? 0) - qty),
    'pos_sale'
  );

  const buyerLabel = customerName?.trim() || 'Walk-in customer';
  const receipts = await buildWalkInReceiptPdfs({
    db,
    store: {
      id: store.id,
      name: store.name,
      whatsapp_number:
        (store as { whatsapp_number?: string | null }).whatsapp_number ?? null,
    },
    product,
    qty,
    unitKobo: Number(unit),
    totalKobo,
    orderNumber,
    method,
    customerPhone,
    customerName: buyerLabel,
  });

  const vendorPdf = receipts.vendorPdf ?? receipts.buyerPdf;
  if (vendorPdf) {
    const vendorSent = await sendDocument(chatId, vendorPdf, {
      fileName: receipts.fileName,
      caption: receipts.vendorCaption,
    });
    console.log(
      `[walk-in] vendor PDF ${orderNumber} → ${chatId} ok=${vendorSent}`
    );
    if (!vendorSent) {
      await sendText(chatId, receipts.vendorCaption);
    }
  } else {
    await sendText(chatId, receipts.vendorCaption);
  }

  let receiptNote = customerPhone
    ? 'Sending receipt to the customer…'
    : `Sale for *${buyerLabel}*. No customer WhatsApp number.`;
  if (customerPhone) {
    const sent = await deliverToWhatsAppNumber(db, customerPhone, {
      text: receipts.buyerCaption,
      pdf: receipts.buyerPdf ?? receipts.vendorPdf ?? undefined,
      fileName: receipts.fileName,
    });
    if (sent.ok) {
      receiptNote = `Customer copy sent to *${buyerLabel}* (${formatWalkInPhone(customerPhone)}).`;
    } else if (sent.detail === 'not_on_whatsapp') {
      receiptNote = `That number is not on WhatsApp. Customer copy not delivered.`;
    } else {
      receiptNote = `Could not deliver the customer copy (${sent.detail}). Your copy is above.`;
    }
  }

  await sendText(
    chatId,
    [
      `Walk-in sale recorded for *${buyerLabel}*.`,
      `*${product.name}* ×${qty}`,
      `Order *${orderNumber}* — ${formatNgn(nairaToKobo(totalNaira))}`,
      `Paid in store: *${walkInPayLabel(method)}* (not via Pas2me)`,
      receiptNote,
    ].join('\n')
  );
  await showProductCard(db, identity, chatId, storeId, productId);
}
export async function handleInventoryMessage(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeIdHint: string | undefined,
  text: string,
  interactiveId: string | undefined,
  inbound?: IncomingWahaMessage
): Promise<boolean> {
  const phone = identity.phone;
  const conv = getOrCreateConversation(db, phone);
  const ctx = getContext(conv);
  const lower = text.trim().toLowerCase();
  const typedQtyState =
    conv.state === 'merch_inv_sell_qty' ||
    conv.state === 'merch_inv_sell_phone' ||
    conv.state === 'merch_inv_sell_name' ||
    conv.state === 'merch_inv_receive' ||
    conv.state === 'merch_inv_set' ||
    conv.state === 'merch_inv_edit_price' ||
    conv.state === 'merch_inv_edit_name';
  const cmd = resolveCommand({
    text,
    interactiveId,
    lastMenu: lastMenu(db, phone),
    ignoreNumericMenu: typedQtyState && !interactiveId,
  });
  const invState = conv.state.startsWith('merch_inv_');
  const invCmd =
    cmd.startsWith('inv_') ||
    cmd === 'merch_stock' ||
    cmd === 'cust_inventory' ||
    cmd === 'cust_sell' ||
    lower === 'inventory' ||
    lower === 'stock' ||
    lower === 'products' ||
    lower === 'low stock';

  if (
    !(typedQtyState && !interactiveId && lower !== 'cancel') &&
    (cmd === 'merch_add_product' ||
      cmd === 'merch_home' ||
      cmd === 'merch_add_store' ||
      cmd === 'cust_home')
  ) {
    return false;
  }

  if (!invState && !invCmd) return false;

  let storeId =
    (cmd.startsWith('inv_store_') ? cmd.slice('inv_store_'.length) : '') ||
    String(ctx.inv_store_id ?? '') ||
    storeIdHint ||
    conv.selected_store_id ||
    '';

  const skipMenuRouting = typedQtyState && !interactiveId && lower !== 'cancel';

  if (
    !skipMenuRouting &&
    (cmd === 'inv_stores' ||
      cmd === 'merch_stock' ||
      cmd === 'cust_inventory' ||
      cmd === 'cust_sell' ||
      lower === 'inventory' ||
      lower === 'stock' ||
      lower === 'products')
  ) {
    await showStorePicker(db, identity, chatId);
    return true;
  }

  if (!skipMenuRouting && cmd.startsWith('inv_store_')) {
    storeId = cmd.slice('inv_store_'.length);
    updateConversation(db, phone, {
      selected_store_id: storeId,
      context_json: JSON.stringify({ ...ctx, inv_store_id: storeId, inv_page: 0 }),
    });
    await showStockHub(db, identity, chatId, storeId, 0);
    return true;
  }

  if (!storeId) {
    await showStorePicker(db, identity, chatId);
    return true;
  }

  const { isOwner, roles } = rolesForStore(identity, storeId);
  if (!canAdjustStock(roles, isOwner, identity.isSuperAdmin)) {
    await sendText(chatId, 'You cannot manage inventory for this location.');
    return true;
  }

  if (
    !skipMenuRouting &&
    (cmd === 'merch_stock' ||
      lower === 'inventory' ||
      lower === 'stock' ||
      lower === 'products')
  ) {
    await showStockHub(db, identity, chatId, storeId, 0);
    return true;
  }
  if (cmd === 'inv_next') {
    await showStockHub(db, identity, chatId, storeId, Number(ctx.inv_page ?? 0) + 1);
    return true;
  }
  if (cmd === 'inv_prev' || cmd === 'inv_back') {
    await showStockHub(
      db,
      identity,
      chatId,
      storeId,
      cmd === 'inv_back' ? Number(ctx.inv_page ?? 0) : Number(ctx.inv_page ?? 0) - 1
    );
    return true;
  }
  if (cmd === 'inv_low' || lower === 'low stock') {
    await showLowStock(db, identity, chatId, storeId);
    return true;
  }
  if (cmd === 'inv_moves') {
    await showRecentMoves(db, chatId, storeId);
    await showStockHub(db, identity, chatId, storeId, Number(ctx.inv_page ?? 0));
    return true;
  }
  if (!skipMenuRouting && cmd.startsWith('inv_item_')) {
    await showProductCard(db, identity, chatId, storeId, cmd.slice('inv_item_'.length));
    return true;
  }

  if (
    !skipMenuRouting &&
    (cmd === 'inv_sell_pick' ||
      lower === 'sell walk-in' ||
      lower === 'walk-in' ||
      lower === 'walk in')
  ) {
    await showWalkInProductPicker(db, identity, chatId, storeId);
    return true;
  }
  if (!skipMenuRouting && cmd.startsWith('inv_sell_')) {
    await promptWalkInQty(db, identity, chatId, storeId, cmd.slice('inv_sell_'.length));
    return true;
  }
  if (!skipMenuRouting && cmd === 'inv_sell') {
    const pid = String(ctx.inv_product_id ?? '');
    if (!pid) {
      await showWalkInProductPicker(db, identity, chatId, storeId);
      return true;
    }
    await promptWalkInQty(db, identity, chatId, storeId, pid);
    return true;
  }
  if (cmd === 'inv_pay_cash' || cmd === 'inv_pay_card' || cmd === 'inv_pay_transfer') {
    const method: WalkInPayMethod =
      cmd === 'inv_pay_card' ? 'card' : cmd === 'inv_pay_transfer' ? 'transfer' : 'cash';
    await promptWalkInName(db, identity, chatId, method);
    return true;
  }

  const productId = String(ctx.inv_product_id ?? '');

  if (cmd === 'inv_edit') {
    if (!productId) {
      await showStockHub(db, identity, chatId, storeId);
      return true;
    }
    await showEditMenu(db, identity, chatId, productId);
    return true;
  }
  if (cmd === 'inv_edit_name') {
    updateConversation(db, phone, { state: 'merch_inv_edit_name' });
    await sendText(chatId, 'Enter the new *product name*:');
    return true;
  }
  if (cmd === 'inv_edit_price') {
    updateConversation(db, phone, { state: 'merch_inv_edit_price' });
    await sendText(chatId, 'Enter the new *price in Naira*:');
    return true;
  }
  if (cmd === 'inv_edit_brand') {
    updateConversation(db, phone, { state: 'merch_inv_edit_brand' });
    await sendText(chatId, 'Enter the new *brand*, or *-* to clear:');
    return true;
  }
  if (cmd === 'inv_edit_category') {
    await promptEditCategory(db, identity, chatId, storeId);
    return true;
  }
  if (cmd === 'inv_edit_desc') {
    updateConversation(db, phone, { state: 'merch_inv_edit_desc' });
    await sendText(chatId, 'Enter the new *description*, or *-* to clear:');
    return true;
  }

  if (cmd === 'inv_receive') {
    if (!productId) {
      await showStockHub(db, identity, chatId, storeId);
      return true;
    }
    const ctxRecv = getContext(getOrCreateConversation(db, phone));
    updateConversation(db, phone, {
      state: 'merch_inv_receive',
      context_json: JSON.stringify({ ...ctxRecv, last_menu: [] }),
    });
    await sendText(
      chatId,
      'How many units arrived? Type a whole number (example: *12*), or *cancel*.'
    );
    return true;
  }
  if (cmd === 'inv_set') {
    if (!productId) {
      await showStockHub(db, identity, chatId, storeId);
      return true;
    }
    const ctxSet = getContext(getOrCreateConversation(db, phone));
    updateConversation(db, phone, {
      state: 'merch_inv_set',
      context_json: JSON.stringify({ ...ctxSet, last_menu: [] }),
    });
    await sendText(chatId, 'Set on-hand quantity. Type a whole number, or *cancel*.');
    return true;
  }
  if (cmd === 'inv_history') {
    if (!productId) {
      await showStockHub(db, identity, chatId, storeId);
      return true;
    }
    await showProductHistory(db, chatId, productId);
    await showProductCard(db, identity, chatId, storeId, productId);
    return true;
  }
  if (cmd === 'inv_photo') {
    if (!productId) {
      await showStockHub(db, identity, chatId, storeId);
      return true;
    }
    updateConversation(db, phone, { state: 'merch_inv_photo' });
    await sendText(
      chatId,
      'Send a *photo*, paste an https image URL, or reply *-* to remove the photo:'
    );
    return true;
  }
  if (cmd === 'inv_toggle') {
    if (!productId) {
      await showStockHub(db, identity, chatId, storeId);
      return true;
    }
    const row = db
      .prepare(`SELECT is_active, name FROM products WHERE id = ? AND store_id = ?`)
      .get(productId, storeId) as
      | { is_active: number | boolean; name: string }
      | undefined;
    if (!row) {
      await sendText(chatId, 'Product not found.');
      return true;
    }
    const next = Number(row.is_active) ? 0 : 1;
    db.prepare(
      `UPDATE products SET is_active = ?, updated_at = ? WHERE id = ?`
    ).run(next, nowIso(), productId);
    await sendText(
      chatId,
      next
        ? `*${row.name}* is now visible in the shop.`
        : `*${row.name}* is hidden from browse/search.`
    );
    await showProductCard(db, identity, chatId, storeId, productId);
    return true;
  }

  if (conv.state === 'merch_inv_edit_name') {
    const name = text.trim();
    if (name.length < 2) {
      await sendText(chatId, 'Name is too short. Try again:');
      return true;
    }
    db.prepare(
      `UPDATE products SET name = ?, updated_at = ? WHERE id = ? AND store_id = ?`
    ).run(name.slice(0, 120), nowIso(), productId, storeId);
    await sendText(chatId, `Name updated to *${name.slice(0, 120)}*.`);
    await showProductCard(db, identity, chatId, storeId, productId);
    return true;
  }
  if (conv.state === 'merch_inv_edit_price') {
    let priceKobo;
    try {
      priceKobo = nairaToKobo(text.trim());
    } catch {
      await sendText(chatId, 'Invalid price. Example: 2500');
      return true;
    }
    if (Number(priceKobo) < 100) {
      await sendText(chatId, 'Minimum price is ₦1.');
      return true;
    }
    db.prepare(
      `UPDATE products SET price = ?, updated_at = ? WHERE id = ? AND store_id = ?`
    ).run(Number(koboToNairaString(priceKobo)), nowIso(), productId, storeId);
    await sendText(chatId, `Price updated to *${formatNgn(priceKobo)}*.`);
    await showProductCard(db, identity, chatId, storeId, productId);
    return true;
  }
  if (conv.state === 'merch_inv_edit_brand') {
    const brand =
      lower === '-' || lower === 'skip' || lower === 'none' || lower === 'clear'
        ? null
        : text.trim().slice(0, 80);
    db.prepare(
      `UPDATE products SET brand = ?, updated_at = ? WHERE id = ? AND store_id = ?`
    ).run(brand, nowIso(), productId, storeId);
    await sendText(chatId, brand ? `Brand updated to *${brand}*.` : 'Brand cleared.');
    await showProductCard(db, identity, chatId, storeId, productId);
    return true;
  }
  if (conv.state === 'merch_inv_edit_desc') {
    const description =
      lower === '-' || lower === 'skip' || lower === 'none' || lower === 'clear'
        ? null
        : text.trim().slice(0, 500);
    db.prepare(
      `UPDATE products SET description = ?, updated_at = ? WHERE id = ? AND store_id = ?`
    ).run(description, nowIso(), productId, storeId);
    await sendText(chatId, 'Description updated.');
    await showProductCard(db, identity, chatId, storeId, productId);
    return true;
  }
  if (conv.state === 'merch_inv_edit_category') {
    if (cmd === 'cat_skip' || lower === '-' || lower === 'skip' || lower === 'clear') {
      db.prepare(
        `UPDATE products SET category_id = NULL, updated_at = ? WHERE id = ? AND store_id = ?`
      ).run(nowIso(), productId, storeId);
      await sendText(chatId, 'Category cleared.');
      await showProductCard(db, identity, chatId, storeId, productId);
      return true;
    }
    if (cmd === 'cat_new') {
      updateConversation(db, phone, { state: 'merch_inv_edit_category_new' });
      await sendText(chatId, 'Type the *new category name*:');
      return true;
    }
    let categoryId: string | null = null;
    if (cmd.startsWith('cat_')) {
      categoryId = cmd.slice(4);
    } else if (text.trim().length >= 2) {
      categoryId = createStoreCategory(db, storeId, text.trim()).id;
    }
    if (!categoryId) {
      await sendText(chatId, 'Pick a category or type a name.');
      return true;
    }
    db.prepare(
      `UPDATE products SET category_id = ?, updated_at = ? WHERE id = ? AND store_id = ?`
    ).run(categoryId, nowIso(), productId, storeId);
    await sendText(chatId, 'Category updated.');
    await showProductCard(db, identity, chatId, storeId, productId);
    return true;
  }
  if (conv.state === 'merch_inv_edit_category_new') {
    const name = text.trim();
    if (name.length < 2) {
      await sendText(chatId, 'Category name is too short.');
      return true;
    }
    const created = createStoreCategory(db, storeId, name);
    db.prepare(
      `UPDATE products SET category_id = ?, updated_at = ? WHERE id = ? AND store_id = ?`
    ).run(created.id, nowIso(), productId, storeId);
    await sendText(chatId, `Category set to *${created.name}*.`);
    await showProductCard(db, identity, chatId, storeId, productId);
    return true;
  }

  if (conv.state === 'merch_inv_sell_qty') {
    if (lower === 'cancel') {
      await showProductCard(db, identity, chatId, storeId, productId);
      return true;
    }
    const qty = Number(text.trim());
    if (!Number.isInteger(qty) || qty < 1) {
      await sendText(chatId, 'Enter a whole number of 1 or more, or *cancel*.');
      return true;
    }
    await promptWalkInPay(db, identity, chatId, qty);
    return true;
  }
  if (conv.state === 'merch_inv_sell_pay') {
    if (lower === 'cash') {
      await promptWalkInName(db, identity, chatId, 'cash');
      return true;
    }
    if (lower === 'card' || lower === 'pos' || lower === 'card (pos)') {
      await promptWalkInName(db, identity, chatId, 'card');
      return true;
    }
    if (lower === 'transfer' || lower === 'bank' || lower === 'bank transfer') {
      await promptWalkInName(db, identity, chatId, 'transfer');
      return true;
    }
    if (lower === 'cancel') {
      await showProductCard(db, identity, chatId, storeId, productId);
      return true;
    }
    await sendText(chatId, 'Pick *Cash*, *Card (POS)*, or *Transfer*.');
    return true;
  }
  if (conv.state === 'merch_inv_sell_name') {
    if (lower === 'cancel') {
      await showProductCard(db, identity, chatId, storeId, productId);
      return true;
    }
    const name = text.trim().replace(/\s+/g, ' ');
    if (parseWalkInCustomerPhone(name)) {
      await sendText(chatId, 'That looks like a phone number. Type the customer *name* first.');
      return true;
    }
    if (name.length < 2 || !/[a-zA-Z]/.test(name)) {
      await sendText(chatId, 'Enter the customer name (at least 2 letters), or *cancel*.');
      return true;
    }
    const convNow = getOrCreateConversation(db, phone);
    const ctxNow = getContext(convNow);
    updateConversation(db, phone, {
      state: 'merch_inv_sell_phone',
      context_json: JSON.stringify({
        ...ctxNow,
        inv_sell_name: name.slice(0, 80),
        last_menu: [],
      }),
    });
    await promptWalkInPhone(
      db,
      identity,
      chatId,
      (String(ctxNow.inv_sell_method ?? 'cash') === 'card'
        ? 'card'
        : String(ctxNow.inv_sell_method ?? '') === 'transfer'
          ? 'transfer'
          : 'cash')
    );
    return true;
  }
  if (conv.state === 'merch_inv_sell_phone') {
    if (lower === 'cancel') {
      await showProductCard(db, identity, chatId, storeId, productId);
      return true;
    }
    const method = String(ctx.inv_sell_method ?? 'cash') as WalkInPayMethod;
    const payMethod: WalkInPayMethod =
      method === 'card' || method === 'transfer' ? method : 'cash';
    const qty = Number(ctx.inv_sell_qty ?? 0);
    const customerName = String(ctx.inv_sell_name ?? '').trim() || null;
    if (qty < 1) {
      await promptWalkInQty(db, identity, chatId, storeId, productId);
      return true;
    }
    if (!customerName) {
      await promptWalkInName(db, identity, chatId, payMethod);
      return true;
    }
    if (lower === 'skip' || lower === '-' || lower === 'none') {
      await completeWalkInSale(
        db,
        identity,
        chatId,
        storeId,
        productId,
        qty,
        payMethod,
        null,
        customerName
      );
      return true;
    }
    const customerPhone = parseWalkInCustomerPhone(text);
    if (!customerPhone) {
      await sendText(
        chatId,
        'That number is not valid. Example: *08031234567*. Or *cancel*.'
      );
      return true;
    }
    await completeWalkInSale(
      db,
      identity,
      chatId,
      storeId,
      productId,
      qty,
      payMethod,
      customerPhone,
      customerName
    );
    return true;
  }

  if (conv.state === 'merch_inv_receive') {
    if (lower === 'cancel') {
      await showProductCard(db, identity, chatId, storeId, productId);
      return true;
    }
    const add = Number(text.trim());
    if (!Number.isInteger(add) || add < 1) {
      await sendText(chatId, 'Enter a whole number ≥ 1, or *cancel*.');
      return true;
    }
    const inv = db
      .prepare(
        `SELECT quantity FROM inventory WHERE product_id = ? AND variant_id IS NULL`
      )
      .get(productId) as { quantity: number } | undefined;
    const { next } = applyQtyChange(
      db,
      identity,
      productId,
      Number(inv?.quantity ?? 0) + add,
      'receive'
    );
    await sendText(chatId, `Received *${add}*. On hand is now *${next}*.`);
    await showProductCard(db, identity, chatId, storeId, productId);
    return true;
  }

  if (conv.state === 'merch_inv_set') {
    if (lower === 'cancel') {
      await showProductCard(db, identity, chatId, storeId, productId);
      return true;
    }
    const qty = Number(text.trim());
    if (!Number.isInteger(qty) || qty < 0) {
      await sendText(chatId, 'Enter a whole number ≥ 0, or *cancel*.');
      return true;
    }
    const { previous, next } = applyQtyChange(
      db,
      identity,
      productId,
      qty,
      'bot_adjustment'
    );
    await sendText(chatId, `Stock set ${previous} → *${next}*.`);
    await showProductCard(db, identity, chatId, storeId, productId);
    return true;
  }

  if (conv.state === 'merch_inv_photo') {
    if (!productId) {
      await showStockHub(db, identity, chatId, storeId);
      return true;
    }
    const skip = lower === '-' || lower === 'skip' || lower === 'none' || lower === 'remove';
    let imagesJson: string | null = null;
    if (!skip) {
      const urlCandidate = text.trim();
      if (/^https?:\/\//i.test(urlCandidate)) {
        imagesJson = JSON.stringify([urlCandidate.slice(0, 500)]);
      } else if (inbound?.hasMedia) {
        const image = await downloadInboundImage(inbound);
        if (!image) {
          await sendText(
            chatId,
            'Could not download that image. Send a photo, paste an https URL, or reply *-*.'
          );
          return true;
        }
        const url = await saveProductPhoto(image.buffer, image.ext);
        imagesJson = JSON.stringify([url]);
      } else {
        await sendText(
          chatId,
          'Send a *photo*, paste an https URL, or reply *-* to remove:'
        );
        return true;
      }
    }
    db.prepare(
      `UPDATE products SET images = ?, updated_at = ? WHERE id = ? AND store_id = ?`
    ).run(imagesJson, nowIso(), productId, storeId);
    await sendText(chatId, imagesJson ? 'Product photo updated.' : 'Product photo removed.');
    await showProductCard(db, identity, chatId, storeId, productId);
    return true;
  }

  if (invState) {
    await sendText(chatId, 'Pick an inventory action from the menu, or reply *stock*.');
    return true;
  }
  return false;
}
