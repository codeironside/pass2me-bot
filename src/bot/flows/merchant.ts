import type { Db } from '../../db/client';
import {
  getContext,
  getOrCreateConversation,
  getStore,
  listStoreCategories,
  createStoreCategory,
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
import { sendImage, sendList, sendMenuMessage, sendText } from '../../services/whatsapp';
import type { IncomingWahaMessage } from '../../services/whatsapp';
import { applyLedgerEntry } from '../../services/wallet';
import {
  assertWithinLimit,
  getPlanFeatures,
  type SubscriptionPlan,
} from '../../guardrails/plans';
import {
  downloadInboundImage,
  loadCoverBytes,
  saveProductPhoto,
} from '../../services/media';
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
import {
  handleInventoryMessage,
} from './merchantInventory';

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
    `*Merchant menu*\nLocations linked: ${storeCount}${identity.isSuperAdmin ? ' · superadmin' : ''}\n${storeCount === 0 ? 'Create a store first — products must belong to a store.' : 'Manage stores, stock, orders, and stats.'}`,
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
    ignoreNumericMenu:
      conv.state === 'merch_inv_sell_qty' ||
      conv.state === 'merch_inv_sell_phone' ||
      conv.state === 'merch_inv_receive' ||
      conv.state === 'merch_inv_set' ||
      conv.state === 'merch_inv_edit_price' ||
      conv.state === 'merch_inv_edit_name',
  });

  if (conv.state.startsWith('merch_inv_')) {
    if (
      await handleInventoryMessage(
        db,
        identity,
        chatId,
        conv.selected_store_id ?? undefined,
        text,
        interactiveId,
        inbound
      )
    ) {
      return;
    }
  }

  if (cmd === 'cust_home') {
    updateConversation(db, phone, { mode: 'customer', state: 'idle' });
    const { sendCustomerHome } = await import('./customer');
    await sendCustomerHome(db, chatId, identity);
    return;
  }

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
      conv.state.startsWith('merch_inv_') ||
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
          new_product_image_url: null,
          new_product_brand: null,
          new_product_category_id: null,
          new_product_category_name: null,
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

  if (
    await handleInventoryMessage(
      db,
      identity,
      chatId,
      conv.selected_store_id ?? undefined,
      text,
      interactiveId,
      inbound
    )
  ) {
    return;
  }

  const storeId = await resolveActiveStore(db, identity, chatId);
  if (!storeId) return;

  if (cmd === 'merch_orders' || lower === 'orders') {
    await listOrders(db, identity, chatId, storeId);
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
    await continueAddProduct(
      db,
      identity,
      chatId,
      storeId,
      text,
      lower,
      inbound,
      interactiveId
    );
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
      new_product_image_url: null,
      new_product_brand: null,
      new_product_category_id: null,
      new_product_category_name: null,
    }),
  });
  await sendText(
    chatId,
    'Create product — step 1/7\nEnter the *product name*:\n(or reply *cancel*)'
  );
}

async function promptProductCategory(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  brand: string | null
): Promise<void> {
  const cats = listStoreCategories(db, storeId);
  const options: MenuOption[] = cats.map((c) => ({
    id: `cat_${c.id}`,
    label: c.name.slice(0, 28),
  }));
  options.push({ id: 'cat_new', label: 'New category' });
  options.push({ id: 'cat_skip', label: 'Skip' });
  rememberMenu(db, identity.phone, options);
  const brandLine = brand ? `Brand: *${brand}*\n` : '';
  await sendMenuMessage(
    chatId,
    `${brandLine}Step 4/7 — Pick a *category*, type a new name, or skip:`,
    options.map((o) => ({ id: o.id, text: o.label }))
  );
}

async function goProductDescription(
  db: Db,
  phone: string,
  chatId: string,
  ctx: Record<string, unknown>,
  categoryId: string | null,
  categoryName: string | null
): Promise<void> {
  updateConversation(db, phone, {
    state: 'merch_product_desc',
    context_json: JSON.stringify({
      ...ctx,
      new_product_category_id: categoryId,
      new_product_category_name: categoryName,
    }),
  });
  const catNote = categoryName ? `Category: *${categoryName}*\n` : '';
  await sendText(
    chatId,
    `${catNote}Step 5/7 — Enter a *description*, or reply *-* to skip:`
  );
}

async function handleProductCategoryReply(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  text: string,
  lower: string,
  interactiveId?: string
): Promise<boolean> {
  const phone = identity.phone;
  const conv = getOrCreateConversation(db, phone);
  const ctx = getContext(conv);
  const cmd = resolveCommand({
    text,
    interactiveId,
    lastMenu: lastMenu(db, phone),
  });

  if (conv.state === 'merch_product_category_new') {
    const name = text.trim();
    if (name.length < 2) {
      await sendText(chatId, 'Category name is too short. Try again:');
      return true;
    }
    const created = createStoreCategory(db, storeId, name);
    await goProductDescription(db, phone, chatId, ctx, created.id, created.name);
    return true;
  }

  if (cmd === 'cat_skip' || lower === '-' || lower === 'skip' || lower === 'none') {
    await goProductDescription(db, phone, chatId, ctx, null, null);
    return true;
  }
  if (cmd === 'cat_new' || lower === 'new category') {
    updateConversation(db, phone, { state: 'merch_product_category_new' });
    await sendText(chatId, 'Type the *new category name*:');
    return true;
  }
  if (cmd.startsWith('cat_')) {
    const id = cmd.slice(4);
    const match = listStoreCategories(db, storeId).find((c) => c.id === id);
    if (!match) {
      await sendText(chatId, 'Pick a category from the list, type a name, or *skip*.');
      return true;
    }
    await goProductDescription(db, phone, chatId, ctx, match.id, match.name);
    return true;
  }

  const typed = text.trim();
  if (typed.length >= 2) {
    const created = createStoreCategory(db, storeId, typed);
    await goProductDescription(db, phone, chatId, ctx, created.id, created.name);
    return true;
  }
  await sendText(chatId, 'Pick a category, type a name, or reply *skip*.');
  return true;
}

async function continueAddProduct(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  text: string,
  lower: string,
  inbound?: IncomingWahaMessage,
  interactiveId?: string
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
        new_product_image_url: null,
        new_product_brand: null,
        new_product_category_id: null,
        new_product_category_name: null,
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
      `Name: *${name}*\nStep 2/7 — Enter *price in Naira* (e.g. 2500):`
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
      state: 'merch_product_brand',
      context_json: JSON.stringify({
        ...ctx,
        new_product_price_naira: priceNaira,
      }),
    });
    await sendText(
      chatId,
      `Price: *${formatNgn(priceKobo)}*\nStep 3/7 — Enter the *brand* (e.g. Nike), or reply *-* to skip:`
    );
    return;
  }

  if (conv.state === 'merch_product_brand') {
    const brand =
      lower === '-' || lower === 'skip' || lower === 'none'
        ? null
        : text.trim().slice(0, 80);
    if (brand && brand.length < 2) {
      await sendText(chatId, 'Brand is too short. Enter a brand, or *-* to skip:');
      return;
    }
    updateConversation(db, phone, {
      state: 'merch_product_category',
      context_json: JSON.stringify({
        ...ctx,
        new_product_brand: brand,
        new_product_category_id: null,
        new_product_category_name: null,
      }),
    });
    await promptProductCategory(db, identity, chatId, storeId, brand);
    return;
  }

  if (
    conv.state === 'merch_product_category' ||
    conv.state === 'merch_product_category_new'
  ) {
    const handled = await handleProductCategoryReply(
      db,
      identity,
      chatId,
      storeId,
      text,
      lower,
      interactiveId
    );
    if (handled) return;
  }

  if (conv.state === 'merch_product_desc') {
    const description =
      lower === '-' || lower === 'skip' || lower === 'none'
        ? null
        : text.trim().slice(0, 500);
    updateConversation(db, phone, {
      state: 'merch_product_photo',
      context_json: JSON.stringify({
        ...ctx,
        new_product_description: description,
        new_product_image_url: null,
      }),
    });
    await sendText(
      chatId,
      [
        'Step 6/7 — Add a *product photo* (customers see this when browsing):',
        '• Send a photo here',
        '• Or paste an https image URL',
        '• Or reply *-* to skip',
      ].join('\n')
    );
    return;
  }

  if (conv.state === 'merch_product_photo') {
    const skip =
      lower === '-' || lower === 'skip' || lower === 'none' || lower === 'no';
    let imageUrl: string | null = null;
    if (!skip) {
      const urlCandidate = text.trim();
      if (/^https?:\/\//i.test(urlCandidate)) {
        imageUrl = urlCandidate.slice(0, 500);
      } else if (inbound?.hasMedia) {
        const image = await downloadInboundImage(inbound);
        if (!image) {
          await sendText(
            chatId,
            'Could not download that image. Send a photo, paste an https URL, or reply *-* to skip:'
          );
          return;
        }
        imageUrl = await saveProductPhoto(image.buffer, image.ext);
      } else {
        await sendText(
          chatId,
          'Send a *photo*, paste an *https* image URL, or reply *-* to skip:'
        );
        return;
      }
    }
    updateConversation(db, phone, {
      state: 'merch_product_qty',
      context_json: JSON.stringify({
        ...ctx,
        new_product_image_url: imageUrl,
      }),
    });
    await sendText(
      chatId,
      'Step 7/7 — Enter *stock quantity* (how many units you have, e.g. 10).\nBuyers will not see this product if quantity is 0.'
    );
    return;
  }

  if (conv.state === 'merch_product_qty') {
    const qty = Number(text.trim());
    if (!Number.isInteger(qty) || qty < 0) {
      await sendText(
        chatId,
        'Enter a whole number ≥ 0 for stock. Use 0 if you are not ready to sell yet (buyers will not see it).'
      );
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
    const photo = ctx.new_product_image_url
      ? 'photo attached'
      : 'no photo';
    const caption = [
      `Confirm new product:`,
      `*${name}*`,
      ctx.new_product_brand ? `Brand: ${ctx.new_product_brand}` : 'Brand: (none)',
      ctx.new_product_category_name
        ? `Category: ${ctx.new_product_category_name}`
        : 'Category: (none)',
      `Price: ${formatNgn(decimalToKobo(priceNaira))}`,
      `Stock: ${qty}${qty < 1 ? ' (hidden from buyers until you add stock)' : ''}`,
      `Photo: ${photo}`,
      `Description: ${desc}`,
      ``,
      `Reply *YES* to create or *NO* to cancel.`,
    ].join('\n');
    const imageUrl =
      typeof ctx.new_product_image_url === 'string'
        ? ctx.new_product_image_url
        : null;
    if (imageUrl) {
      const bytes = await loadCoverBytes(imageUrl);
      if (bytes) await sendImage(chatId, bytes, caption);
      else await sendText(chatId, caption);
    } else {
      await sendText(chatId, caption);
    }
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
    const imageUrl =
      typeof ctx.new_product_image_url === 'string'
        ? ctx.new_product_image_url
        : null;
    const imagesJson = imageUrl ? JSON.stringify([imageUrl]) : null;
    const brand =
      typeof ctx.new_product_brand === 'string' ? ctx.new_product_brand : null;
    const categoryId =
      typeof ctx.new_product_category_id === 'string'
        ? ctx.new_product_category_id
        : null;
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
            (id, store_id, category_id, name, description, price, brand, images, is_active, is_featured,
             inventory_tracking, low_stock_threshold, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 1, 5, ?, ?)`
        ).run(
          productId,
          storeId,
          categoryId,
          name,
          description,
          priceNum,
          brand,
          imagesJson,
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
        new_product_image_url: null,
        new_product_brand: null,
        new_product_category_id: null,
        new_product_category_name: null,
      }),
    });

    const createdCaption = [
      `*Product created*`,
      `*${name}*`,
      brand ? `Brand: ${brand}` : '',
      ctx.new_product_category_name
        ? `Category: ${ctx.new_product_category_name}`
        : '',
      `Price: ${formatNgn(decimalToKobo(priceNaira))}`,
      `Stock: ${qty}${qty < 1 ? ' (hidden from buyers)' : ''}`,
      `ID: \`${productId}\``,
      ``,
      qty < 1
        ? `Add stock with *stock* before customers can see it.`
        : `Customers can find it via *marketplace* / *search*.`,
      `Edit anytime from *stock* → pick the product → *Edit details*.`,
    ]
      .filter(Boolean)
      .join('\n');
    if (imageUrl) {
      const bytes = await loadCoverBytes(imageUrl);
      if (bytes) await sendImage(chatId, bytes, createdCaption);
      else await sendText(chatId, createdCaption);
    } else {
      await sendText(chatId, createdCaption);
    }
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
    const nextQty = Math.max(0, inv.quantity - qty);
    db.prepare(
      `UPDATE inventory SET quantity = ?, updated_at = ? WHERE id = ?`
    ).run(nextQty, nowIso(), inv.id);
    db.prepare(
      `INSERT INTO inventory_movements
        (id, product_id, previous_quantity, new_quantity, change_amount, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'pos_sale', ?, ?)`
    ).run(
      newId('im'),
      productId,
      inv.quantity,
      nextQty,
      nextQty - inv.quantity,
      identity.user?.id ?? null,
      nowIso()
    );
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
