import type { Db } from '../../db/client';
import {
  getContext,
  getOrCreateConversation,
  getStore,
  updateConversation,
  writeBotAudit,
} from '../../db/repos';
import {
  decimalToKobo,
  formatNgn,
  koboToNairaString,
  nairaToKobo,
} from '../../domain/money';
import { newId, nowIso } from '../../domain/ids';
import { sendList, sendMenuMessage, sendText } from '../../services/whatsapp';
import type { IncomingWahaMessage } from '../../services/whatsapp';
import { applyLedgerEntry } from '../../services/wallet';
import {
  assertWithinLimit,
  getPlanFeatures,
  usageWarning,
  type SubscriptionPlan,
} from '../../guardrails/plans';
import {
  canAdjustStock,
  canManageRefunds,
  canRecordSale,
  type ResolvedIdentity,
} from '../identity';
import { resolveCommand, type MenuOption } from '../command';
import {
  canCreateStore,
  continueCreateStore,
  continueManageLocations,
  handleManageLocationsEntry,
  startCreateStore,
} from './merchantLocations';

const MERCHANT_MENU: MenuOption[] = [
  { id: 'merch_orders', label: 'Orders' },
  { id: 'merch_stock', label: 'Stock' },
  { id: 'merch_add_product', label: 'Add product' },
  { id: 'merch_add_store', label: 'Add location' },
  { id: 'merch_stats', label: 'Stats' },
  { id: 'merch_logistics', label: 'Logistics' },
  { id: 'merch_invite', label: 'Invite staff' },
  { id: 'merch_locations', label: 'Manage locations' },
];

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

function rolesForStore(
  identity: ResolvedIdentity,
  storeId: string
): { isOwner: boolean; roles: Array<'business_admin' | 'location_manager' | 'cashier'> } {
  if (identity.isSuperAdmin) {
    return { isOwner: true, roles: ['business_admin'] };
  }
  const isOwner = identity.ownedStoreIds.includes(storeId);
  const roles = identity.staffRoles
    .filter((r) => r.storeId === storeId)
    .map((r) => r.role);
  return { isOwner, roles };
}

export async function sendMerchantHome(
  chatId: string,
  identity: ResolvedIdentity,
  db?: Db
): Promise<void> {
  const storeCount = new Set([
    ...identity.ownedStoreIds,
    ...identity.staffRoles.map((s) => s.storeId),
  ]).size;
  const menu = [...MERCHANT_MENU];
  if (db) {
    const conv = getOrCreateConversation(db, identity.phone);
    // Clear leftover wallet_menu so numeric picks map to merchant options
    if (conv.state === 'wallet_menu' || conv.state === 'idle') {
      updateConversation(db, identity.phone, { state: 'idle' });
    }
    rememberMenu(db, identity.phone, menu);
  }
  await sendMenuMessage(
    chatId,
    `*Merchant menu*\nLocations linked: ${storeCount}${identity.isSuperAdmin ? ' · superadmin' : ''}\nManage stores, stock, orders, and stats.`,
    menu.map((o) => ({ id: o.id, text: o.label }))
  );
}

export async function handleMerchantMessage(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  text: string,
  interactiveId?: string,
  location?: { latitude: number; longitude: number; description?: string },
  inbound?: IncomingWahaMessage
): Promise<void> {
  const phone = identity.phone;
  const conv = getOrCreateConversation(db, phone);
  const lower = text.trim().toLowerCase();
  const cmd = resolveCommand({
    text,
    interactiveId,
    lastMenu: lastMenu(db, phone),
  });

  if (
    cmd === 'merch_home' ||
    lower === 'menu' ||
    lower === 'help' ||
    lower === 'merchant'
  ) {
    if (
      conv.state.startsWith('merch_product_') ||
      conv.state.startsWith('merch_store_') ||
      conv.state.startsWith('merch_loc_') ||
      conv.state.startsWith('merch_logistics') ||
      conv.state.startsWith('merch_set_') ||
      conv.state.startsWith('merch_rate_') ||
      conv.state.startsWith('merch_waybill') ||
      conv.state.startsWith('merch_batch') ||
      conv.state.startsWith('merch_sync') ||
      conv.state.startsWith('merch_stock_') ||
      conv.state.startsWith('merch_sale_') ||
      conv.state.startsWith('merch_refund_')
    ) {
      const ctx = getContext(conv);
      updateConversation(db, phone, {
        state: 'idle',
        context_json: JSON.stringify({
          ...ctx,
          new_product_name: null,
          new_product_price_naira: null,
          new_product_description: null,
          new_product_qty: null,
          new_store_name: null,
          new_store_description: null,
          new_store_banner_url: null,
          manage_store_id: null,
        }),
      });
    }
    await sendMerchantHome(chatId, identity, db);
    return;
  }

  // Create-store / add-location can run with zero stores
  if (
    cmd === 'merch_add_store' ||
    lower === 'create store' ||
    lower === 'add store' ||
    lower === 'new store' ||
    lower === 'add location' ||
    lower === 'new location' ||
    lower === 'create location'
  ) {
    await startCreateStore(db, identity, chatId);
    return;
  }

  if (conv.state.startsWith('merch_store_')) {
    await continueCreateStore(
      db,
      identity,
      chatId,
      text,
      lower,
      inbound,
      location
    );
    return;
  }

  if (
    await continueManageLocations(
      db,
      identity,
      chatId,
      text,
      interactiveId,
      inbound,
      location
    )
  ) {
    return;
  }

  if (
    cmd === 'merch_locations' ||
    lower === 'locations' ||
    lower === 'switch location' ||
    lower === 'manage locations'
  ) {
    await handleManageLocationsEntry(db, identity, chatId);
    return;
  }

  if (cmd.startsWith('loc_')) {
    const storeId = cmd.slice(4);
    updateConversation(db, phone, { selected_store_id: storeId });
    await sendText(chatId, `Active location set. Use *menu* for actions.`);
    await sendMerchantHome(chatId, identity, db);
    return;
  }

  // Logistics: open submenu without requiring a store first (submenu actions resolve store)
  const logisticsStates = [
    'merch_logistics_menu',
    'merch_set_pickup',
    'merch_set_pickup_confirm',
    'merch_rate_lga',
    'merch_waybill_order',
    'merch_batch_lga',
    'merch_batch_confirm',
    'merch_sync_waybill',
  ];
  const logisticsCmds = new Set([
    'merch_rates',
    'merch_set_pickup',
    'merch_link_cabme',
    'merch_waybill',
    'merch_batch',
    'merch_sync_waybill',
  ]);
  const wantsLogistics =
    cmd === 'merch_logistics' ||
    lower === 'logistics' ||
    lower === 'waybill' ||
    logisticsStates.includes(conv.state) ||
    logisticsCmds.has(cmd);

  if (wantsLogistics) {
    const { handleMerchantLogisticsMessage, sendMerchantLogisticsMenu } =
      await import('./logistics');

    // Opening the logistics hub does not need an active store yet
    if (
      cmd === 'merch_logistics' ||
      lower === 'logistics' ||
      lower === 'waybill'
    ) {
      await sendMerchantLogisticsMenu(db, identity, chatId);
      return;
    }

    const storeId = await resolveActiveStore(db, identity, chatId);
    if (!storeId) return;

    if (
      await handleMerchantLogisticsMessage(
        db,
        identity,
        chatId,
        text,
        interactiveId,
        storeId,
        location
      )
    ) {
      return;
    }
  }

  const storeId = await resolveActiveStore(db, identity, chatId);
  if (!storeId) return;

  if (cmd === 'merch_orders' || lower === 'orders') {
    await listOrders(db, identity, chatId, storeId);
    return;
  }

  if (cmd === 'merch_stock' || lower === 'stock' || lower === 'products') {
    await listStock(db, identity, chatId, storeId);
    return;
  }

  if (
    cmd === 'merch_add_product' ||
    lower === 'add product' ||
    lower === 'new product' ||
    lower === 'create product'
  ) {
    await startAddProduct(db, identity, chatId, storeId);
    return;
  }

  if (conv.state.startsWith('merch_product_')) {
    await continueAddProduct(db, identity, chatId, storeId, text, lower);
    return;
  }

  if (cmd === 'merch_stats' || lower === 'stats') {
    await showStats(db, identity, chatId, storeId);
    return;
  }

  if (cmd === 'merch_invite' || lower === 'invite') {
    const { startInviteFlow } = await import('./invites');
    await startInviteFlow(db, identity, chatId, storeId);
    return;
  }

  // stock <productId> <qty>
  if (lower.startsWith('stock ')) {
    const parts = text.trim().split(/\s+/);
    const productId = parts[1];
    const qty = Number(parts[2]);
    if (!productId || !Number.isInteger(qty) || qty < 0) {
      await sendText(chatId, 'Usage: stock <product_id> <qty>');
      return;
    }
    await promptStockConfirm(db, identity, chatId, storeId, productId, qty);
    return;
  }

  if (conv.state === 'merch_stock_confirm') {
    await finishStockConfirm(db, identity, chatId, storeId, lower);
    return;
  }

  // sale <productId> <qty>
  if (lower.startsWith('sale ')) {
    const parts = text.trim().split(/\s+/);
    const productId = parts[1];
    const qty = Number(parts[2] ?? '1');
    if (!productId || !Number.isInteger(qty) || qty < 1) {
      await sendText(chatId, 'Usage: sale <product_id> <qty>');
      return;
    }
    await promptSaleConfirm(db, identity, chatId, storeId, productId, qty);
    return;
  }

  if (conv.state === 'merch_sale_confirm') {
    await finishSaleConfirm(db, identity, chatId, storeId, lower);
    return;
  }

  // refund <order_number>
  if (lower.startsWith('refund ')) {
    const orderNumber = text.trim().slice(7).trim();
    await promptRefundConfirm(db, identity, chatId, storeId, orderNumber);
    return;
  }

  if (conv.state === 'merch_refund_confirm') {
    await finishRefundConfirm(db, identity, chatId, storeId, lower);
    return;
  }

  if (conv.state.startsWith('invite_')) {
    const { continueInviteFlow } = await import('./invites');
    await continueInviteFlow(db, identity, chatId, storeId, text, interactiveId);
    return;
  }

  await sendMerchantHome(chatId, identity, db);
}

async function resolveActiveStore(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<string | null> {
  const conv = getOrCreateConversation(db, identity.phone);
  if (conv.selected_store_id) {
    const access =
      identity.isSuperAdmin ||
      identity.ownedStoreIds.includes(conv.selected_store_id) ||
      identity.staffRoles.some((s) => s.storeId === conv.selected_store_id);
    if (access) return conv.selected_store_id;
  }

  const allIds = [
    ...new Set([
      ...identity.ownedStoreIds,
      ...identity.staffRoles.map((s) => s.storeId),
    ]),
  ];
  if (allIds.length === 1) {
    updateConversation(db, identity.phone, { selected_store_id: allIds[0]! });
    return allIds[0]!;
  }
  if (allIds.length === 0) {
    if (canCreateStore(identity)) {
      await sendText(
        chatId,
        'You have no stores yet.\nReply *add location* (or pick it from the menu) to add one first.'
      );
      await sendMerchantHome(chatId, identity, db);
    } else {
      await sendText(chatId, 'No store locations assigned to this phone.');
    }
    return null;
  }
  await listLocations(db, identity, chatId);
  await sendText(
    chatId,
    'Pick a location above (reply with the `loc_…` id), then try your action again.'
  );
  return null;
}

async function listLocations(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  const ids = [
    ...new Set([
      ...identity.ownedStoreIds,
      ...identity.staffRoles.map((s) => s.storeId),
    ]),
  ];
  const rows = ids
    .map((id) => getStore(db, id))
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  if (rows.length === 0) {
    if (canCreateStore(identity)) {
      await sendText(
        chatId,
        'No locations found.\nReply *add location* (menu item) to create one.'
      );
    } else {
      await sendText(chatId, 'No locations found.');
    }
    return;
  }

  await sendList(chatId, 'Select a location:', 'Locations', [
    {
      title: 'Your locations',
      rows: rows.slice(0, 10).map((s) => ({
        id: `loc_${s.id}`,
        title: s.name.slice(0, 24),
        description: s.subscription_plan,
      })),
    },
  ]);
}

async function listOrders(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string
): Promise<void> {
  const rows = db
    .prepare(
      `SELECT order_number, status, payment_status, total_amount, created_at
       FROM orders WHERE store_id = ?
       ORDER BY created_at DESC LIMIT 8`
    )
    .all(storeId) as Array<{
    order_number: string;
    status: string;
    payment_status: string;
    total_amount: number | string;
  }>;

  if (rows.length === 0) {
    await sendText(chatId, 'No orders yet for this location.');
    return;
  }

  const lines = rows.map(
    (r) =>
      `• ${r.order_number}: ${r.status}/${r.payment_status} ${formatNgn(decimalToKobo(r.total_amount))}`
  );
  lines.push('', 'Refund: refund ORDER_NO');
  await sendText(chatId, lines.join('\n'));
  void identity;
}

async function listStock(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string
): Promise<void> {
  const store = getStore(db, storeId);
  if (!store) return;
  const features = getPlanFeatures(store.subscription_plan as SubscriptionPlan);
  const count = (
    db
      .prepare('SELECT COUNT(*) AS c FROM products WHERE store_id = ?')
      .get(storeId) as { c: number }
  ).c;
  const warn = usageWarning(count, features.max_products);

  const products = db
    .prepare(
      `SELECT p.id, p.name, p.price, IFNULL(i.quantity, 0) AS qty
       FROM products p
       LEFT JOIN inventory i ON i.product_id = p.id AND i.variant_id IS NULL
       WHERE p.store_id = ?
       ORDER BY p.updated_at DESC
       LIMIT 10`
    )
    .all(storeId) as Array<{
    id: string;
    name: string;
    price: number | string;
    qty: number;
  }>;

  const lines = products.map(
    (p) =>
      `• ${p.name} (${p.id.slice(0, 8)}…) qty=${p.qty} ${formatNgn(decimalToKobo(p.price))}`
  );
  if (warn) lines.unshift(warn, '');
  lines.push('', 'Reply *add product* to create a product.');
  lines.push('Set stock: stock <product_id> <qty>');
  lines.push('Record sale: sale <product_id> <qty>');
  await sendText(chatId, lines.join('\n') || 'No products.\nReply *add product* to create one.');
  void identity;
}

async function startAddProduct(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string
): Promise<void> {
  const { isOwner, roles } = rolesForStore(identity, storeId);
  if (!canAdjustStock(roles, isOwner, identity.isSuperAdmin)) {
    await sendText(chatId, 'You cannot create products for this location.');
    return;
  }

  const store = getStore(db, storeId);
  if (!store) {
    await sendText(chatId, 'Store not found.');
    return;
  }
  const features = getPlanFeatures(store.subscription_plan as SubscriptionPlan);
  const count = (
    db
      .prepare('SELECT COUNT(*) AS c FROM products WHERE store_id = ?')
      .get(storeId) as { c: number }
  ).c;
  const gate = assertWithinLimit(count, features.max_products, 'Products');
  if (!gate.ok) {
    await sendText(chatId, gate.message);
    return;
  }

  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  updateConversation(db, identity.phone, {
    state: 'merch_product_name',
    context_json: JSON.stringify({
      ...ctx,
      new_product_name: null,
      new_product_price_naira: null,
      new_product_description: null,
      new_product_qty: null,
    }),
  });
  await sendText(
    chatId,
    'Create product — step 1/4\nEnter the *product name*:\n(or reply *cancel*)'
  );
}

async function continueAddProduct(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  text: string,
  lower: string
): Promise<void> {
  const phone = identity.phone;
  const conv = getOrCreateConversation(db, phone);
  const ctx = getContext(conv);

  if (lower === 'cancel') {
    updateConversation(db, phone, {
      state: 'idle',
      context_json: JSON.stringify({
        ...ctx,
        new_product_name: null,
        new_product_price_naira: null,
        new_product_description: null,
        new_product_qty: null,
      }),
    });
    await sendText(chatId, 'Product creation cancelled.');
    await sendMerchantHome(chatId, identity, db);
    return;
  }

  const { isOwner, roles } = rolesForStore(identity, storeId);
  if (!canAdjustStock(roles, isOwner, identity.isSuperAdmin)) {
    await sendText(chatId, 'You cannot create products for this location.');
    return;
  }

  if (conv.state === 'merch_product_name') {
    const name = text.trim();
    if (name.length < 2) {
      await sendText(chatId, 'Name is too short. Enter a product name:');
      return;
    }
    if (name.length > 120) {
      await sendText(chatId, 'Name is too long (max 120 chars). Try again:');
      return;
    }
    updateConversation(db, phone, {
      state: 'merch_product_price',
      context_json: JSON.stringify({ ...ctx, new_product_name: name }),
    });
    await sendText(
      chatId,
      `Name: *${name}*\nStep 2/4 — Enter *price in Naira* (e.g. 2500):`
    );
    return;
  }

  if (conv.state === 'merch_product_price') {
    let priceKobo;
    try {
      priceKobo = nairaToKobo(text.trim());
    } catch {
      await sendText(chatId, 'Invalid price. Example: 2500');
      return;
    }
    if (Number(priceKobo) < 100) {
      await sendText(chatId, 'Minimum price is ₦1.');
      return;
    }
    const priceNaira = koboToNairaString(priceKobo);
    updateConversation(db, phone, {
      state: 'merch_product_desc',
      context_json: JSON.stringify({
        ...ctx,
        new_product_price_naira: priceNaira,
      }),
    });
    await sendText(
      chatId,
      `Price: *${formatNgn(priceKobo)}*\nStep 3/4 — Enter a *description*, or reply *-* to skip:`
    );
    return;
  }

  if (conv.state === 'merch_product_desc') {
    const description =
      lower === '-' || lower === 'skip' || lower === 'none'
        ? null
        : text.trim().slice(0, 500);
    updateConversation(db, phone, {
      state: 'merch_product_qty',
      context_json: JSON.stringify({
        ...ctx,
        new_product_description: description,
      }),
    });
    await sendText(
      chatId,
      'Step 4/4 — Enter *starting stock quantity* (e.g. 10):'
    );
    return;
  }

  if (conv.state === 'merch_product_qty') {
    const qty = Number(text.trim());
    if (!Number.isInteger(qty) || qty < 0) {
      await sendText(chatId, 'Enter a whole number ≥ 0 for stock.');
      return;
    }
    updateConversation(db, phone, {
      state: 'merch_product_confirm',
      context_json: JSON.stringify({
        ...ctx,
        new_product_qty: qty,
      }),
    });
    const name = String(ctx.new_product_name ?? '');
    const priceNaira = String(ctx.new_product_price_naira ?? '0');
    const desc = ctx.new_product_description
      ? String(ctx.new_product_description)
      : '(none)';
    await sendText(
      chatId,
      [
        `Confirm new product:`,
        `*${name}*`,
        `Price: ${formatNgn(decimalToKobo(priceNaira))}`,
        `Stock: ${qty}`,
        `Description: ${desc}`,
        ``,
        `Reply *YES* to create or *NO* to cancel.`,
      ].join('\n')
    );
    return;
  }

  if (conv.state === 'merch_product_confirm') {
    if (lower === 'no') {
      updateConversation(db, phone, { state: 'idle' });
      await sendText(chatId, 'Product creation cancelled.');
      await sendMerchantHome(chatId, identity, db);
      return;
    }
    if (lower !== 'yes' && lower !== 'y') {
      await sendText(chatId, 'Reply *YES* to create or *NO* to cancel.');
      return;
    }

    const name = String(ctx.new_product_name ?? '').trim();
    const priceNaira = String(ctx.new_product_price_naira ?? '');
    const description =
      typeof ctx.new_product_description === 'string'
        ? ctx.new_product_description
        : null;
    const qty = Number(ctx.new_product_qty ?? 0);
    if (!name || !priceNaira) {
      await sendText(chatId, 'Session expired. Start again with *add product*.');
      updateConversation(db, phone, { state: 'idle' });
      return;
    }

    const store = getStore(db, storeId);
    if (!store) {
      await sendText(chatId, 'Store not found.');
      return;
    }
    const features = getPlanFeatures(store.subscription_plan as SubscriptionPlan);
    const count = (
      db
        .prepare('SELECT COUNT(*) AS c FROM products WHERE store_id = ?')
        .get(storeId) as { c: number }
    ).c;
    const gate = assertWithinLimit(count, features.max_products, 'Products');
    if (!gate.ok) {
      await sendText(chatId, gate.message);
      updateConversation(db, phone, { state: 'idle' });
      return;
    }

    const productId = newId('prod');
    const invId = newId('inv');
    const ts = nowIso();
    const priceNum = Number(priceNaira);

    try {
      const run = db.transaction(() => {
        db.prepare(
          `INSERT INTO products
            (id, store_id, name, description, price, is_active, is_featured,
             inventory_tracking, low_stock_threshold, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, 0, 1, 5, ?, ?)`
        ).run(
          productId,
          storeId,
          name,
          description,
          priceNum,
          ts,
          ts
        );

        db.prepare(
          `INSERT INTO inventory
            (id, product_id, variant_id, quantity, reserved_quantity, created_at, updated_at)
           VALUES (?, ?, NULL, ?, 0, ?, ?)`
        ).run(invId, productId, qty, ts, ts);

        if (features.stock_movement_history || qty > 0) {
          db.prepare(
            `INSERT INTO inventory_movements
              (id, product_id, previous_quantity, new_quantity, change_amount, reason, created_by, created_at)
             VALUES (?, ?, 0, ?, ?, 'initial_stock', ?, ?)`
          ).run(newId('imv'), productId, qty, qty, identity.user?.id ?? null, ts);
        }

        writeBotAudit(db, {
          actor_user_id: identity.user?.id,
          actor_phone: phone,
          action: 'product_create',
          resource_type: 'product',
          resource_id: productId,
          details: {
            store_id: storeId,
            name,
            price: priceNum,
            quantity: qty,
          },
        });
      });
      run();
    } catch (err) {
      console.error('[merchant] create product failed', err);
      await sendText(
        chatId,
        err instanceof Error ? err.message : 'Could not create product.'
      );
      return;
    }

    updateConversation(db, phone, {
      state: 'idle',
      context_json: JSON.stringify({
        ...ctx,
        new_product_name: null,
        new_product_price_naira: null,
        new_product_description: null,
        new_product_qty: null,
      }),
    });

    await sendText(
      chatId,
      [
        `*Product created*`,
        `*${name}*`,
        `Price: ${formatNgn(decimalToKobo(priceNaira))}`,
        `Stock: ${qty}`,
        `ID: \`${productId}\``,
        ``,
        `Customers can find it via *browse* / *search*.`,
        `Update stock later: stock ${productId} <qty>`,
      ].join('\n')
    );
    await sendMerchantHome(chatId, identity, db);
  }
}

async function showStats(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string
): Promise<void> {
  const paid = db
    .prepare(
      `SELECT COUNT(*) AS c, IFNULL(SUM(total_amount), 0) AS revenue
       FROM orders WHERE store_id = ? AND payment_status = 'paid'`
    )
    .get(storeId) as { c: number; revenue: number | string };
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS c FROM orders WHERE store_id = ? AND payment_status = 'pending'`
    )
    .get(storeId) as { c: number };

  await sendText(
    chatId,
    [
      `*Location stats*`,
      `Paid orders: ${paid.c}`,
      `Revenue: ${formatNgn(decimalToKobo(paid.revenue))}`,
      `Pending payment: ${pending.c}`,
    ].join('\n')
  );
  void identity;
}

async function setStock(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  productId: string,
  qty: number
): Promise<void> {
  const { isOwner, roles } = rolesForStore(identity, storeId);
  if (!canAdjustStock(roles, isOwner, identity.isSuperAdmin)) {
    await sendText(chatId, 'You cannot adjust stock for this location.');
    return;
  }

  const product = db
    .prepare('SELECT id, name FROM products WHERE id = ? AND store_id = ?')
    .get(productId, storeId) as { id: string; name: string } | undefined;
  if (!product) {
    await sendText(chatId, 'Product not found at this location.');
    return;
  }

  const inv = db
    .prepare(
      `SELECT id, quantity FROM inventory WHERE product_id = ? AND variant_id IS NULL`
    )
    .get(productId) as { id: string; quantity: number } | undefined;

  const run = db.transaction(() => {
    if (inv) {
      db.prepare(
        `UPDATE inventory SET quantity = ?, updated_at = ? WHERE id = ?`
      ).run(qty, nowIso(), inv.id);
      db.prepare(
        `INSERT INTO inventory_movements
          (id, product_id, previous_quantity, new_quantity, change_amount, reason, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'bot_adjustment', ?, ?)`
      ).run(
        newId('im'),
        productId,
        inv.quantity,
        qty,
        qty - inv.quantity,
        identity.user?.id ?? null,
        nowIso()
      );
    } else {
      db.prepare(
        `INSERT INTO inventory (id, product_id, quantity, reserved_quantity, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?)`
      ).run(newId('inv'), productId, qty, nowIso(), nowIso());
    }
  });
  run();

  writeBotAudit(db, {
    actor_user_id: identity.user?.id,
    actor_phone: identity.phone,
    action: 'stock_adjust',
    resource_type: 'product',
    resource_id: productId,
    details: { qty, store_id: storeId },
  });

  await sendText(chatId, `Stock updated to ${qty}.`);
}

async function promptStockConfirm(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  productId: string,
  qty: number
): Promise<void> {
  const { isOwner, roles } = rolesForStore(identity, storeId);
  if (!canAdjustStock(roles, isOwner, identity.isSuperAdmin)) {
    await sendText(chatId, 'You cannot adjust stock for this location.');
    return;
  }
  const product = db
    .prepare('SELECT id, name FROM products WHERE id = ? AND store_id = ?')
    .get(productId, storeId) as { id: string; name: string } | undefined;
  if (!product) {
    await sendText(chatId, 'Product not found at this location.');
    return;
  }
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  updateConversation(db, identity.phone, {
    state: 'merch_stock_confirm',
    context_json: JSON.stringify({
      ...ctx,
      pending_stock_product_id: productId,
      pending_stock_qty: qty,
    }),
  });
  await sendText(
    chatId,
    `*Are you sure?* Set stock for *${product.name}* to *${qty}*?\nReply *YES* or *NO*.`
  );
}

async function finishStockConfirm(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  lower: string
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  if (lower === 'no' || lower === 'n') {
    updateConversation(db, identity.phone, { state: 'idle' });
    await sendText(chatId, 'Stock update cancelled.');
    return;
  }
  if (lower !== 'yes' && lower !== 'y') {
    await sendText(chatId, 'Reply *YES* or *NO*.');
    return;
  }
  const productId = String(ctx.pending_stock_product_id ?? '');
  const qty = Number(ctx.pending_stock_qty);
  updateConversation(db, identity.phone, { state: 'idle' });
  if (!productId || !Number.isInteger(qty)) {
    await sendText(chatId, 'Session expired. Try stock again.');
    return;
  }
  await setStock(db, identity, chatId, storeId, productId, qty);
}

async function promptSaleConfirm(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  productId: string,
  qty: number
): Promise<void> {
  const { isOwner, roles } = rolesForStore(identity, storeId);
  if (!canRecordSale(roles, isOwner, identity.isSuperAdmin)) {
    await sendText(chatId, 'You cannot record sales.');
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
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  updateConversation(db, identity.phone, {
    state: 'merch_sale_confirm',
    context_json: JSON.stringify({
      ...ctx,
      pending_sale_product_id: productId,
      pending_sale_qty: qty,
    }),
  });
  await sendText(
    chatId,
    `*Are you sure?* Record sale of *${qty}× ${product.name}* (${formatNgn(decimalToKobo(product.price))} each)?\nReply *YES* or *NO*.`
  );
}

async function finishSaleConfirm(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  lower: string
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  if (lower === 'no' || lower === 'n') {
    updateConversation(db, identity.phone, { state: 'idle' });
    await sendText(chatId, 'Sale cancelled.');
    return;
  }
  if (lower !== 'yes' && lower !== 'y') {
    await sendText(chatId, 'Reply *YES* or *NO*.');
    return;
  }
  const productId = String(ctx.pending_sale_product_id ?? '');
  const qty = Number(ctx.pending_sale_qty);
  updateConversation(db, identity.phone, { state: 'idle' });
  if (!productId || !Number.isInteger(qty) || qty < 1) {
    await sendText(chatId, 'Session expired. Try sale again.');
    return;
  }
  await recordSale(db, identity, chatId, storeId, productId, qty);
}

async function promptRefundConfirm(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  orderNumber: string
): Promise<void> {
  const { isOwner, roles } = rolesForStore(identity, storeId);
  if (!canManageRefunds(roles, isOwner, identity.isSuperAdmin)) {
    await sendText(chatId, 'You cannot issue refunds.');
    return;
  }
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  updateConversation(db, identity.phone, {
    state: 'merch_refund_confirm',
    context_json: JSON.stringify({
      ...ctx,
      pending_refund_order: orderNumber,
    }),
  });
  await sendText(
    chatId,
    `*Are you sure?* Refund order *${orderNumber}*?\nReply *YES* or *NO*.`
  );
}

async function finishRefundConfirm(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  lower: string
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  if (lower === 'no' || lower === 'n') {
    updateConversation(db, identity.phone, { state: 'idle' });
    await sendText(chatId, 'Refund cancelled.');
    return;
  }
  if (lower !== 'yes' && lower !== 'y') {
    await sendText(chatId, 'Reply *YES* or *NO*.');
    return;
  }
  const orderNumber = String(ctx.pending_refund_order ?? '');
  updateConversation(db, identity.phone, { state: 'idle' });
  if (!orderNumber) {
    await sendText(chatId, 'Session expired. Try refund again.');
    return;
  }
  await refundOrder(db, identity, chatId, storeId, orderNumber);
}

async function recordSale(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  productId: string,
  qty: number
): Promise<void> {
  const { isOwner, roles } = rolesForStore(identity, storeId);
  if (!canRecordSale(roles, isOwner, identity.isSuperAdmin)) {
    await sendText(chatId, 'You cannot record sales.');
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

  db.prepare(
    `INSERT INTO orders
      (id, store_id, order_number, status, subtotal, tax_amount, shipping_amount,
       total_amount, currency, payment_status, payment_method, notes, created_at, updated_at)
     VALUES (?, ?, ?, 'confirmed', ?, 0, 0, ?, 'NGN', 'paid', 'pos_cashier', ?, ?, ?)`
  ).run(
    orderId,
    storeId,
    orderNumber,
    totalNaira,
    totalNaira,
    `Recorded by ${identity.phone}`,
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

  // Decrement stock if tracked
  const inv = db
    .prepare(
      `SELECT id, quantity FROM inventory WHERE product_id = ? AND variant_id IS NULL`
    )
    .get(productId) as { id: string; quantity: number } | undefined;
  if (inv) {
    db.prepare(
      `UPDATE inventory SET quantity = ?, updated_at = ? WHERE id = ?`
    ).run(Math.max(0, inv.quantity - qty), nowIso(), inv.id);
  }

  if (store.user_id) {
    try {
      applyLedgerEntry(db, {
        userId: store.user_id,
        direction: 'credit',
        amount: nairaToKobo(totalNaira),
        type: 'purchase',
        idempotencyKey: `pos_${orderId}`,
        storeId,
        orderId,
        metadata: { source: 'cashier_pos', location_store_id: storeId },
        actorPhone: identity.phone,
        actorUserId: identity.user?.id,
      });
    } catch (err) {
      console.error('Vendor wallet credit failed', err);
    }
  }

  await sendText(
    chatId,
    `Sale recorded. Order *${orderNumber}* — ${formatNgn(nairaToKobo(totalNaira))}`
  );
}

async function refundOrder(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  orderNumber: string
): Promise<void> {
  const { isOwner, roles } = rolesForStore(identity, storeId);
  if (!canManageRefunds(roles, isOwner, identity.isSuperAdmin)) {
    await sendText(chatId, 'You cannot issue refunds.');
    return;
  }

  const order = db
    .prepare(
      `SELECT id, payment_status, total_amount, customer_id FROM orders
       WHERE order_number = ? AND store_id = ?`
    )
    .get(orderNumber, storeId) as
    | {
        id: string;
        payment_status: string;
        total_amount: number | string;
        customer_id: string | null;
      }
    | undefined;

  if (!order) {
    await sendText(chatId, 'Order not found.');
    return;
  }
  if (order.payment_status !== 'paid') {
    await sendText(chatId, 'Only paid orders can be refunded.');
    return;
  }

  db.prepare(
    `UPDATE orders SET payment_status = 'refunded', status = 'refunded', updated_at = ? WHERE id = ?`
  ).run(nowIso(), order.id);

  // Manual wallet credit to customer if we can resolve user by customer phone
  if (order.customer_id) {
    const customer = db
      .prepare('SELECT whatsapp_number FROM customers WHERE id = ?')
      .get(order.customer_id) as { whatsapp_number: string } | undefined;
    if (customer) {
      const user = db
        .prepare(
          `SELECT id FROM users WHERE phone LIKE ? LIMIT 1`
        )
        .get(`%${customer.whatsapp_number.slice(-10)}`) as
        | { id: string }
        | undefined;
      if (user) {
        try {
          applyLedgerEntry(db, {
            userId: user.id,
            direction: 'credit',
            amount: decimalToKobo(order.total_amount),
            type: 'refund',
            idempotencyKey: `refund_${order.id}`,
            storeId,
            orderId: order.id,
            actorUserId: identity.user?.id,
            actorPhone: identity.phone,
            metadata: { method: 'manual_wallet_credit' },
          });
        } catch (err) {
          console.error('Refund credit failed', err);
        }
      }
    }
  }

  writeBotAudit(db, {
    actor_user_id: identity.user?.id,
    actor_phone: identity.phone,
    action: 'refund',
    resource_type: 'order',
    resource_id: order.id,
    details: { order_number: orderNumber, store_id: storeId },
  });

  await sendText(chatId, `Order *${orderNumber}* marked refunded.`);
}
