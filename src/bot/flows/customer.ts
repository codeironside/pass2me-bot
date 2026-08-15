import type { Db } from '../../db/client';
import {
  getContext,
  getInventoryQty,
  applyPaidOrderToInventory,
  getOrCreateConversation,
  getProduct,
  getWalletByUserId,
  listMarketplaceProducts,
  listOwnedStores,
  listUserDeliveryAddresses,
  parseCart,
  saveUserDeliveryAddress,
  countMarketplaceProducts,
  updateConversation,
  type CartItem,
  type UserDeliveryAddressRow,
} from '../../db/repos';
import {
  decimalToKobo,
  formatNgn,
  kobo,
  type Kobo,
} from '../../domain/money';
import { newId, nowIso } from '../../domain/ids';
import { sendDocument, sendImage, sendMenuMessage, sendText } from '../../services/whatsapp';
import { loadCoverBytes } from '../../services/media';
import { buildOrderReceiptPdf } from '../../services/receiptPdf';
import { notifyVendorsOfPaidOrder } from '../../services/orderNotify';
import {
  createBankTransferCharge,
  createCheckout,
  describeBankTransferInstructions,
} from '../../services/monnify';
import { applyLedgerEntry } from '../../services/wallet';
import { getEnv } from '../../config/env';
import {
  assertWithinLimit,
  getPlanFeatures,
  usageWarning,
  type SubscriptionPlan,
} from '../../guardrails/plans';
import type { ResolvedIdentity } from '../identity';
import { resolveCommand, type MenuOption } from '../command';

function cartTotal(items: CartItem[]): Kobo {
  let total = 0n;
  for (const item of items) {
    total += BigInt(item.unit_price_kobo) * BigInt(item.quantity);
  }
  return kobo(total);
}

function isRegistered(identity: ResolvedIdentity): boolean {
  return Boolean(identity.user);
}

function titleCaseName(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map((part) =>
      part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part
    )
    .join(' ');
}

function displayName(identity: ResolvedIdentity): string {
  const first = identity.user?.first_name?.trim() ?? '';
  const last = identity.user?.last_name?.trim() ?? '';
  const full = titleCaseName(`${first} ${last}`.trim());
  return full || 'there';
}

function formatPhoneDisplay(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.startsWith('234') && digits.length === 13) {
    return `+234 ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
  }
  return phone?.trim() || '—';
}

async function requireRegistered(
  identity: ResolvedIdentity,
  chatId: string,
  action: string
): Promise<boolean> {
  if (isRegistered(identity)) return true;
  await sendText(
    chatId,
    [
      `*${action}* needs a Pas2me account linked to this WhatsApp number.`,
      '',
      'Sign up at https://www.pas2me.com then message this bot again.',
      '',
      'As a guest you can still open *marketplace* and *search* products.',
      'Reply *menu* for options.',
    ].join('\n')
  );
  return false;
}

function rememberMenu(
  db: Db,
  phone: string,
  options: MenuOption[]
): void {
  const conv = getOrCreateConversation(db, phone);
  const ctx = getContext(conv);
  updateConversation(db, phone, {
    context_json: JSON.stringify({ ...ctx, last_menu: options }),
  });
}

function lastMenuFromConv(conv: {
  context_json: string;
}): MenuOption[] {
  try {
    const parsed = JSON.parse(conv.context_json) as {
      last_menu?: MenuOption[];
    };
    if (!Array.isArray(parsed.last_menu)) return [];
    return parsed.last_menu.filter(
      (m) =>
        typeof m === 'object' &&
        m !== null &&
        typeof m.id === 'string' &&
        typeof m.label === 'string'
    );
  } catch {
    return [];
  }
}

async function sendMenu(
  db: Db,
  chatId: string,
  phone: string,
  body: string,
  options: MenuOption[]
): Promise<void> {
  rememberMenu(db, phone, options);
  await sendMenuMessage(
    chatId,
    body,
    options.map((o) => ({ id: o.id, text: o.label }))
  );
}

/** D1/sqlite may return images as a JSON string, a parsed array, or an object. */
function firstHttpUrl(value: unknown, depth = 0): string | null {
  if (value == null || depth > 4) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '[]' || trimmed === '{}' || trimmed === 'null') {
      return null;
    }
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    try {
      return firstHttpUrl(JSON.parse(trimmed), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstHttpUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return firstHttpUrl(
      rec.url ?? rec.src ?? rec.image_url ?? rec.secure_url ?? rec.path,
      depth + 1
    );
  }
  return null;
}

function productImageUrl(product: {
  image_url?: unknown;
  images?: unknown;
}): string | null {
  return firstHttpUrl(product.image_url) ?? firstHttpUrl(product.images);
}

async function sendProductImage(
  chatId: string,
  product: {
    name?: string;
    image_url?: unknown;
    images?: unknown;
  },
  caption: string
): Promise<boolean> {
  try {
    const url = productImageUrl(product);
    if (!url) {
      console.log(`[product] no image url for ${product.name ?? 'unknown'}`);
      return false;
    }
    const bytes = await loadCoverBytes(url);
    if (bytes) {
      await sendImage(chatId, bytes, caption);
      return true;
    }
    if (/^https?:\/\//i.test(url)) {
      await sendImage(chatId, url, caption);
      return true;
    }
    return false;
  } catch (err) {
    console.error('[product] sendProductImage failed', err);
    return false;
  }
}

function addProductToCart(
  cart: CartItem[],
  product: {
    id: string;
    store_id: string;
    name: string;
    price: number | string;
  },
  quantity: number
): CartItem[] {
  const next = [...cart];
  const existing = next.find((c) => c.product_id === product.id);
  if (existing) existing.quantity += quantity;
  else {
    next.push({
      product_id: product.id,
      store_id: product.store_id,
      name: product.name,
      unit_price_kobo: Number(decimalToKobo(product.price)),
      quantity,
    });
  }
  return next;
}

function mergeCartItems(base: CartItem[], extra: CartItem[]): CartItem[] {
  const next = [...base];
  for (const item of extra) {
    const existing = next.find((c) => c.product_id === item.product_id);
    if (existing) existing.quantity += item.quantity;
    else next.push({ ...item });
  }
  return next;
}

function groupCartByStore(
  db: Db,
  cart: CartItem[]
): Array<{
  storeId: string;
  storeName: string;
  items: CartItem[];
  itemsKobo: ReturnType<typeof kobo>;
}> {
  const groups: Array<{
    storeId: string;
    storeName: string;
    items: CartItem[];
    itemsKobo: ReturnType<typeof kobo>;
  }> = [];
  for (const item of cart) {
    let group = groups.find((g) => g.storeId === item.store_id);
    if (!group) {
      const store = db
        .prepare('SELECT name FROM stores WHERE id = ?')
        .get(item.store_id) as { name?: string } | undefined;
      group = {
        storeId: item.store_id,
        storeName: store?.name?.trim() || 'Store',
        items: [],
        itemsKobo: kobo(0),
      };
      groups.push(group);
    }
    group.items.push(item);
  }
  for (const group of groups) {
    group.itemsKobo = cartTotal(group.items);
  }
  return groups;
}

export async function sendCustomerHome(
  db: Db,
  chatId: string,
  identity: ResolvedIdentity
): Promise<void> {
  const registered = isRegistered(identity);
  const guestOptions: MenuOption[] = [
    { id: 'cust_browse', label: 'Marketplace' },
    { id: 'cust_search', label: 'Search' },
    { id: 'cust_signup_info', label: 'Create account' },
  ];
  const memberOptions: MenuOption[] = [
    { id: 'cust_browse', label: 'Marketplace' },
    { id: 'cust_search', label: 'Search' },
    { id: 'cust_cart', label: 'Cart' },
    { id: 'cust_saved', label: 'Saved for later' },
    { id: 'cust_orders', label: 'My orders' },
    { id: 'cust_wallet', label: 'Wallet' },
    { id: 'cust_profile', label: 'Profile' },
    { id: 'cust_inventory', label: 'Inventory' },
  ];

  const body = registered
    ? [
        `Hi *${displayName(identity)}* 👋`,
        'Welcome to *Pas2me* marketplace.',
        'Marketplace, cart, orders, wallet, profile — or open *Inventory* to sell.',
      ].join('\n')
    : [
        'Welcome to *Pas2me* marketplace.',
        '',
        'You are browsing as a *guest*.',
        'Marketplace and search are open. Cart, checkout, wallet, and orders need an account on https://www.pas2me.com',
      ].join('\n');

  await sendMenu(
    db,
    chatId,
    identity.phone,
    body,
    registered ? memberOptions : guestOptions
  );
}

async function showProfile(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  const user = identity.user;
  if (!user) return;

  const stores = listOwnedStores(db, user.id);
  const wallet = getWalletByUserId(db, user.id);
  const roleLabel =
    user.role === 'admin'
      ? 'Admin'
      : identity.ownedStoreIds.length > 0 || identity.staffRoles.length > 0
        ? 'Merchant'
        : 'Customer';

  const lines = [
    `*Your profile*`,
    '',
    `Name: *${displayName(identity)}*`,
    `Email: ${user.email}`,
    `Phone: ${formatPhoneDisplay(user.phone ?? identity.phone)}`,
    `Account: ${roleLabel}`,
    `Status: ${user.status}`,
  ];

  if (stores.length > 0) {
    lines.push(
      `Stores: ${stores.map((s) => s.name).slice(0, 5).join(', ')}`
    );
  }

  if (wallet) {
    lines.push(
      `Wallet: *${formatNgn(kobo(wallet.balance_kobo))}* (${wallet.status})`
    );
  } else {
    lines.push('Wallet: not set up yet — reply *wallet* to create one.');
  }

  const dropoffs = listUserDeliveryAddresses(db, user.id);
  if (dropoffs.length > 0) {
    lines.push('', '*Saved delivery locations*');
    for (const loc of dropoffs) {
      const star = Number(loc.is_default) ? ' ★ default' : '';
      lines.push(`• ${loc.label} (${loc.lga})${star}`);
    }
  } else {
    lines.push(
      '',
      'No saved delivery locations yet. You can save one at checkout.'
    );
  }

  lines.push('', 'Update your details at https://www.pas2me.com');

  const options: MenuOption[] = [{ id: 'cust_home', label: 'Main menu' }];
  await sendMenu(db, chatId, identity.phone, lines.join('\n'), options);
}

const BROWSE_PAGE_SIZE = 5;

async function showMarketplacePage(
  db: Db,
  chatId: string,
  phone: string,
  page = 0,
  query?: string
): Promise<void> {
  const total = countMarketplaceProducts(db, query);
  if (total === 0) {
    await sendText(
      chatId,
      query?.trim()
        ? `No products matched *${query.trim()}*. Reply *marketplace* or *search*.`
        : 'No products in the marketplace yet.'
    );
    return;
  }

  const pageCount = Math.max(1, Math.ceil(total / BROWSE_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const offset = safePage * BROWSE_PAGE_SIZE;
  const products = listMarketplaceProducts(db, {
    query,
    limit: BROWSE_PAGE_SIZE,
    offset,
  });
  const from = offset + 1;
  const to = offset + products.length;

  const conv = getOrCreateConversation(db, phone);
  const ctx = getContext(conv);
  updateConversation(db, phone, {
    state: 'idle',
    context_json: JSON.stringify({
      ...ctx,
      browse_page: safePage,
      browse_query: query?.trim() || null,
    }),
  });

  const options: MenuOption[] = products.map((p) => ({
    id: `view_${p.id}`,
    label: `${p.name} · ${formatNgn(decimalToKobo(p.price))}`.slice(0, 36),
  }));
  if (safePage + 1 < pageCount) {
    options.push({ id: 'browse_next', label: 'Next page' });
  }
  if (safePage > 0) {
    options.push({ id: 'browse_prev', label: 'Previous page' });
  }
  options.push({ id: 'cust_search', label: 'Search' });
  options.push({ id: 'cust_home', label: 'Main menu' });

  const nextIndex = products.length + 1;
  const hint =
    safePage + 1 < pageCount
      ? `Reply *${nextIndex}* or *next* for more products.`
      : 'Last page — reply *prev* to go back.';

  const lines = [
    query?.trim() ? `*Search:* ${query.trim()}` : '*Marketplace*',
    `Page ${safePage + 1} of ${pageCount}  ·  ${from}–${to} of ${total}`,
    '',
    hint,
  ];

  await sendMenu(db, chatId, phone, lines.join('\n'), options);
}

function browseStateFromConv(conv: { context_json: string }): {
  page: number;
  query?: string;
} {
  let ctx: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(conv.context_json) as unknown;
    if (parsed && typeof parsed === 'object') {
      ctx = parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  const page = Number(ctx.browse_page ?? 0);
  const query =
    typeof ctx.browse_query === 'string' && ctx.browse_query.trim()
      ? ctx.browse_query.trim()
      : undefined;
  return {
    page: Number.isFinite(page) && page >= 0 ? page : 0,
    query,
  };
}

async function confirmSaveCartForLater(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const cart = parseCart(conv.cart_json);
  if (cart.length === 0) {
    await sendText(chatId, 'Cart is empty — nothing to save.');
    return;
  }
  await sendMenu(
    db,
    chatId,
    identity.phone,
    [
      `Save *${cart.length}* cart item(s) for later?`,
      '',
      '⚠️ *Warning:* you can only buy saved items later if they are *still in stock*. Price and availability can change.',
    ].join('\n'),
    [
      { id: 'cust_save_later_yes', label: 'Yes, save for later' },
      { id: 'cust_save_later_no', label: 'No, keep in cart' },
    ]
  );
}

async function saveCartForLater(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const cart = parseCart(conv.cart_json);
  if (cart.length === 0) {
    await sendText(chatId, 'Cart is empty — nothing to save.');
    return;
  }
  const saved = mergeCartItems(parseCart(conv.saved_json ?? '[]'), cart);
  updateConversation(db, identity.phone, {
    cart_json: '[]',
    saved_json: JSON.stringify(saved),
    state: 'idle',
  });
  await sendMenu(
    db,
    chatId,
    identity.phone,
    [
      `Saved *${cart.length}* item(s) for later. Cart is now empty.`,
      '',
      '⚠️ You can only check out a saved item *if it is still in stock*.',
    ].join('\n'),
    [
      { id: 'cust_saved', label: 'View saved' },
      { id: 'cust_browse', label: 'Marketplace' },
    ]
  );
}

async function showSavedForLater(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const saved = parseCart(conv.saved_json ?? '[]');
  if (saved.length === 0) {
    await sendText(
      chatId,
      'No saved items. From a product or your cart, choose *Save for later*.'
    );
    return;
  }
  const lines = [
    '*Saved for later*',
    '',
    '⚠️ Buying later is only possible if the product is *still in stock*.',
    '',
  ];
  const options: MenuOption[] = [];
  saved.forEach((item, i) => {
    const product = getProduct(db, item.product_id);
    const stock = product ? getInventoryQty(db, item.product_id) : 0;
    const stockNote = !product
      ? 'unavailable'
      : stock <= 0
        ? 'out of stock'
        : `${stock} in stock`;
    lines.push(
      `• ${item.name} ×${item.quantity} — ${stockNote}`
    );
    options.push({
      id: `saved_buy_${i}`,
      label: `Move to cart: ${item.name}`.slice(0, 36),
    });
  });
  options.push({ id: 'cust_cart', label: 'View cart' });
  options.push({ id: 'cust_home', label: 'Main menu' });
  await sendMenu(db, chatId, identity.phone, lines.join('\n'), options);
}

async function moveSavedToCart(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  index: number
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const saved = parseCart(conv.saved_json ?? '[]');
  const item = saved[index];
  if (!item) {
    await sendText(chatId, 'That saved item was not found.');
    return;
  }
  const product = getProduct(db, item.product_id);
  if (!product) {
    const next = saved.filter((_, i) => i !== index);
    updateConversation(db, identity.phone, { saved_json: JSON.stringify(next) });
    await sendText(chatId, `*${item.name}* is no longer listed, so it was removed from saved.`);
    return;
  }
  const stock = getInventoryQty(db, product.id);
  if (stock <= 0) {
    await sendText(
      chatId,
      `*${product.name}* is out of stock, so it cannot be moved to cart yet.\nIt stays in Saved for later.`
    );
    return;
  }
  const qty = Math.min(item.quantity, stock);
  const cart = addProductToCart(parseCart(conv.cart_json), product, qty);
  const nextSaved = saved.filter((_, i) => i !== index);
  updateConversation(db, identity.phone, {
    cart_json: JSON.stringify(cart),
    saved_json: JSON.stringify(nextSaved),
    selected_store_id: product.store_id,
  });
  const extra =
    qty < item.quantity
      ? `\nOnly *${stock}* left — moved ${qty} to cart.`
      : '';
  await sendMenu(
    db,
    chatId,
    identity.phone,
    `Moved *${qty}× ${product.name}* to cart.${extra}`,
    [
      { id: 'cust_cart', label: 'View cart' },
      { id: 'cust_saved', label: 'Saved for later' },
      { id: 'cust_checkout', label: 'Checkout' },
    ]
  );
}

export async function handleCustomerMessage(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  text: string,
  interactiveId?: string,
  location?: { latitude: number; longitude: number; description?: string }
): Promise<void> {
  const phone = identity.phone;
  const conv = getOrCreateConversation(db, phone);
  const cmd = resolveCommand({
    text,
    interactiveId,
    lastMenu: lastMenuFromConv(conv),
    ignoreNumericMenu:
      conv.state.startsWith('merch_inv_') &&
      conv.state !== 'merch_inv_sell_pay' &&
      conv.state !== 'merch_inv_list' &&
      conv.state !== 'merch_inv_item' &&
      conv.state !== 'merch_inv_edit' &&
      conv.state !== 'merch_inv_sell_pick' &&
      !interactiveId,
  });
  const lower = text.trim().toLowerCase();

  if (conv.state.startsWith('merch_inv_')) {
    const { handleInventoryMessage } = await import('./merchantInventory');
    if (
      await handleInventoryMessage(
        db,
        identity,
        chatId,
        conv.selected_store_id ?? undefined,
        text,
        interactiveId
      )
    ) {
      return;
    }
  }

  if (cmd === 'cust_home' || lower === 'menu' || lower === 'help') {
    await sendCustomerHome(db, chatId, identity);
    return;
  }

  if (
    cmd === 'cust_inventory' ||
    cmd === 'cust_sell' ||
    lower === 'inventory' ||
    lower === 'sell'
  ) {
    const { openInventoryHub } = await import('./merchantInventory');
    await openInventoryHub(db, identity, chatId);
    return;
  }

  if (
    cmd === 'merch_add_store' ||
    lower === 'create store' ||
    lower === 'add store' ||
    lower === 'new store'
  ) {
    if (!identity.user) {
      await sendText(
        chatId,
        [
          'To create a store you need a Pas2me account.',
          'Sign up at https://www.pas2me.com with this WhatsApp number,',
          'then reply *inventory*.',
        ].join('\n')
      );
      return;
    }
    const { startCreateStore } = await import('./merchantLocations');
    updateConversation(db, phone, { mode: 'merchant', state: 'idle' });
    await startCreateStore(db, identity, chatId);
    return;
  }

  if (
    cmd === 'merch_add_product' ||
    lower === 'add product' ||
    lower === 'new product' ||
    lower === 'create product'
  ) {
    if (!identity.user) {
      await sendText(
        chatId,
        'Sign up at https://www.pas2me.com first, then create a store with *create store* before adding products.'
      );
      return;
    }
    const storeCount = new Set([
      ...identity.ownedStoreIds,
      ...identity.staffRoles.map((s) => s.storeId),
    ]).size;
    updateConversation(db, phone, { mode: 'merchant', state: 'idle' });
    if (storeCount === 0) {
      await sendText(
        chatId,
        'Products must belong to a store. Create a store in *Inventory* first.'
      );
      const { openInventoryHub } = await import('./merchantInventory');
      await openInventoryHub(db, identity, chatId);
      return;
    }
    const { handleMerchantMessage } = await import('./merchant');
    await handleMerchantMessage(db, identity, chatId, 'add product', undefined);
    return;
  }

  if (cmd === 'cust_clear_cart' || lower === 'clear cart') {
    if (!(await requireRegistered(identity, chatId, 'Clear cart'))) return;
    updateConversation(db, phone, { cart_json: '[]', state: 'idle' });
    await sendText(chatId, 'Cart cleared.');
    return;
  }

  if (cmd === 'cust_save_later') {
    if (!(await requireRegistered(identity, chatId, 'Save for later'))) return;
    await confirmSaveCartForLater(db, identity, chatId);
    return;
  }

  if (cmd === 'cust_save_later_yes') {
    if (!(await requireRegistered(identity, chatId, 'Save for later'))) return;
    await saveCartForLater(db, identity, chatId);
    return;
  }

  if (cmd === 'cust_save_later_no') {
    await sendText(chatId, 'Okay — items stay in your cart. Reply *cart* or *checkout*.');
    return;
  }

  if (cmd === 'cust_saved' || lower === 'saved' || lower === 'saved items') {
    if (!(await requireRegistered(identity, chatId, 'Saved items'))) return;
    await showSavedForLater(db, identity, chatId);
    return;
  }

  if (cmd.startsWith('saved_buy_')) {
    if (!(await requireRegistered(identity, chatId, 'Saved items'))) return;
    const idx = Number(cmd.slice('saved_buy_'.length));
    await moveSavedToCart(db, identity, chatId, idx);
    return;
  }

  if (cmd === 'cust_signup_info' || lower === 'create account' || lower === 'signup') {
    await sendText(
      chatId,
      [
        'Create your Pas2me account at:',
        'https://www.pas2me.com',
        '',
        'Use the same phone number as this WhatsApp chat.',
        'After signup, message the bot again for cart, checkout, and wallet.',
      ].join('\n')
    );
    return;
  }

  if (cmd === 'cust_browse' || lower === 'browse' || lower === 'marketplace') {
    await showMarketplacePage(db, chatId, phone, 0);
    return;
  }

  if (cmd === 'browse_next' || lower === 'next' || lower === 'more') {
    const { page, query } = browseStateFromConv(conv);
    await showMarketplacePage(db, chatId, phone, page + 1, query);
    return;
  }

  if (cmd === 'browse_prev' || lower === 'prev' || lower === 'previous') {
    const { page, query } = browseStateFromConv(conv);
    await showMarketplacePage(db, chatId, phone, Math.max(0, page - 1), query);
    return;
  }

  if (cmd === 'cust_search' || lower === 'search') {
    updateConversation(db, phone, { state: 'awaiting_search' });
    await sendText(chatId, 'Type a product name or store to search:');
    return;
  }

  if (cmd.startsWith('loc_use_')) {
    if (!(await requireRegistered(identity, chatId, 'Checkout'))) return;
    const idx = Number(cmd.slice('loc_use_'.length));
    await applySavedDropoff(db, identity, chatId, idx);
    return;
  }

  if (cmd === 'loc_new' || lower === 'new location' || lower === 'new dropoff') {
    if (!(await requireRegistered(identity, chatId, 'Checkout'))) return;
    const method = String(getContext(conv).logistics_method ?? '');
    if (method !== 'vendor_delivery' && method !== 'dispatch_pickup') {
      await sendText(chatId, 'Start *checkout* first, then choose delivery.');
      return;
    }
    await startNewDropoffCapture(db, identity, chatId);
    return;
  }

  if (cmd === 'loc_save_yes' || cmd === 'loc_save_no') {
    if (!(await requireRegistered(identity, chatId, 'Checkout'))) return;
    await finishDropoffSavePrompt(db, identity, chatId, cmd === 'loc_save_yes');
    return;
  }

  if (conv.state === 'checkout_pick_dropoff') {
    if (!(await requireRegistered(identity, chatId, 'Checkout'))) return;
    if (lower === 'new' || lower === 'new location') {
      await startNewDropoffCapture(db, identity, chatId);
      return;
    }
    await sendText(
      chatId,
      'Pick a *saved location* from the list, or reply *new* to enter a new dropoff.'
    );
    return;
  }

  if (conv.state === 'checkout_save_loc') {
    if (!(await requireRegistered(identity, chatId, 'Checkout'))) return;
    if (lower === 'yes' || lower === 'y' || lower === 'save') {
      await finishDropoffSavePrompt(db, identity, chatId, true);
      return;
    }
    if (lower === 'no' || lower === 'n' || lower === 'skip') {
      await finishDropoffSavePrompt(db, identity, chatId, false);
      return;
    }
    await sendText(
      chatId,
      'Reply *yes* to save this dropoff as your default, or *no* to continue without saving.'
    );
    return;
  }

  if (conv.state === 'checkout_lga') {
    if (!(await requireRegistered(identity, chatId, 'Checkout'))) return;
    const lga = text.trim();
    if (lga.length < 2) {
      await sendText(chatId, 'Please enter a valid LGA name.');
      return;
    }
    const ctx = getContext(conv);
    updateConversation(db, phone, {
      state: 'checkout_location',
      context_json: JSON.stringify({ ...ctx, checkout_lga: lga }),
    });
    await sendText(
      chatId,
      'Please *share your dropoff location* using WhatsApp:\nAttach → Location → Send your current/pin location.'
    );
    return;
  }

  if (conv.state === 'checkout_location') {
    if (!(await requireRegistered(identity, chatId, 'Checkout'))) return;
    if (!location) {
      await sendText(
        chatId,
        'Still waiting for a WhatsApp location pin.\nAttach → Location → Send location.'
      );
      return;
    }
    const ctx = getContext(conv);
    updateConversation(db, phone, {
      state: 'checkout_address',
      context_json: JSON.stringify({
        ...ctx,
        checkout_lat: location.latitude,
        checkout_lng: location.longitude,
        checkout_location_label: location.description ?? null,
      }),
    });
    await sendText(
      chatId,
      'Location received ✅\nSend a short address/landmark (optional but helpful), or reply *skip*:'
    );
    return;
  }

  if (conv.state === 'checkout_address') {
    if (!(await requireRegistered(identity, chatId, 'Checkout'))) return;
    const address =
      text.trim().toLowerCase() === 'skip' || !text.trim()
        ? String(getContext(conv).checkout_location_label ?? 'Shared WhatsApp location')
        : text.trim();
    await askSaveNewDropoff(db, identity, chatId, address);
    return;
  }

  if (conv.state === 'awaiting_cart_qty') {
    const ctx = getContext(conv);
    const productId = String(ctx.pending_product_id ?? '');
    if (/^\d{1,4}$/.test(text.trim()) && !interactiveId) {
      if (!(await requireRegistered(identity, chatId, 'Add to cart'))) return;
      const qty = Number(text.trim());
      const product = productId ? getProduct(db, productId) : undefined;
      if (!product || !Number.isInteger(qty) || qty < 1) {
        await sendText(chatId, 'Enter a whole number of 1 or more, or reply *menu*.');
        return;
      }
      const stock = getInventoryQty(db, product.id);
      if (stock <= 0) {
        updateConversation(db, phone, { state: 'idle' });
        await sendText(chatId, `*${product.name}* is out of stock.`);
        return;
      }
      if (qty > stock) {
        await sendText(
          chatId,
          `Only *${stock}* in stock. Reply with a number from 1 to ${stock}.`
        );
        return;
      }
      const cart = addProductToCart(parseCart(conv.cart_json), product, qty);
      updateConversation(db, phone, {
        cart_json: JSON.stringify(cart),
        selected_store_id: product.store_id,
        state: 'idle',
        context_json: JSON.stringify({
          ...ctx,
          pending_product_id: null,
          last_menu: [],
        }),
      });
      await sendMenu(db, chatId, phone, `Added *${qty}× ${product.name}* to cart.`, [
        { id: 'cust_cart', label: 'View cart' },
        { id: 'cust_checkout', label: 'Checkout' },
        { id: 'cust_browse', label: 'Marketplace' },
      ]);
      return;
    }
    if (!interactiveId && !cmd.startsWith('cust_') && !cmd.startsWith('prod_') && !cmd.startsWith('add_')) {
      await sendText(
        chatId,
        'Reply with the *quantity* (e.g. *2*), or *menu* to cancel.'
      );
      return;
    }
    updateConversation(db, phone, {
      state: 'idle',
      context_json: JSON.stringify({ ...ctx, pending_product_id: null }),
    });
  }

  if (conv.state === 'awaiting_search' && !interactiveId && !/^\d+$/.test(lower)) {
    // Don't treat menu numbers as search while awaiting — only free text
    if (
      !cmd.startsWith('cust_') &&
      !cmd.startsWith('prod_') &&
      cmd !== 'browse_next' &&
      cmd !== 'browse_prev'
    ) {
      await showMarketplacePage(db, chatId, phone, 0, text.trim());
      return;
    }
  }

  if (cmd.startsWith('view_') || cmd.startsWith('prod_')) {
    const productId = cmd.startsWith('view_')
      ? cmd.slice('view_'.length)
      : cmd.startsWith('prod_prod_')
        ? cmd.slice('prod_'.length)
        : cmd.slice('prod_'.length);
    const product = getProduct(db, productId);
    if (!product) {
      await sendText(chatId, 'Product not found.');
      return;
    }
    const qty = getInventoryQty(db, product.id);
    if (qty <= 0) {
      await sendText(
        chatId,
        `*${product.name}* is currently out of stock and hidden from the shop.`
      );
      return;
    }
    const price = formatNgn(decimalToKobo(product.price));
    const body = [
      `*${product.name}*`,
      product.brand ? `Brand: ${product.brand}` : '',
      product.category_name ? `Category: ${product.category_name}` : '',
      `Store: ${product.store_name}`,
      `Price: ${price}`,
      product.description ? `\n${product.description}` : '',
      `\nIn stock: ${qty}`,
    ]
      .filter(Boolean)
      .join('\n');

    updateConversation(db, phone, {
      selected_store_id: product.store_id,
      context_json: JSON.stringify({
        ...getContext(conv),
        last_product_id: product.id,
      }),
    });

    const options: MenuOption[] = isRegistered(identity)
      ? [
          { id: `add_${product.id}`, label: 'Add to cart' },
          { id: `save_${product.id}`, label: 'Save for later' },
          { id: 'cust_cart', label: 'View cart' },
          { id: 'cust_browse', label: 'More products' },
        ]
      : [
          { id: 'cust_browse', label: 'More products' },
          { id: 'cust_search', label: 'Search' },
          { id: 'cust_signup_info', label: 'Create account to buy' },
        ];

    const sentImage = await sendProductImage(chatId, product, body);
    await sendMenu(
      db,
      chatId,
      phone,
      sentImage ? 'What next?' : body,
      options
    );
    return;
  }

  if (cmd.startsWith('add_')) {
    if (!(await requireRegistered(identity, chatId, 'Add to cart'))) return;
    const productId = cmd.slice('add_'.length);
    const product = getProduct(db, productId);
    if (!product) {
      await sendText(chatId, 'Product not found.');
      return;
    }
    const stock = getInventoryQty(db, product.id);
    if (stock <= 0) {
      await sendText(chatId, `*${product.name}* is out of stock.`);
      return;
    }
    const ctx = getContext(conv);
    updateConversation(db, phone, {
      selected_store_id: product.store_id,
      state: 'awaiting_cart_qty',
      context_json: JSON.stringify({
        ...ctx,
        pending_product_id: product.id,
        last_menu: [],
      }),
    });
    await sendText(
      chatId,
      `How many *${product.name}* do you want?\nIn stock: *${stock}*\n\nReply with a number (e.g. *2*).`
    );
    return;
  }

  if (cmd.startsWith('save_')) {
    if (!(await requireRegistered(identity, chatId, 'Save for later'))) return;
    const productId = cmd.slice('save_'.length);
    const product = getProduct(db, productId);
    if (!product) {
      await sendText(chatId, 'Product not found.');
      return;
    }
    const convNow = getOrCreateConversation(db, phone);
    const saved = parseCart(convNow.saved_json ?? '[]');
    const next = addProductToCart(saved, product, 1);
    updateConversation(db, phone, { saved_json: JSON.stringify(next) });
    await sendMenu(
      db,
      chatId,
      phone,
      [
        `Saved *${product.name}* for later.`,
        '',
        '⚠️ You can only buy it later *if it is still in stock*.',
      ].join('\n'),
      [
        { id: 'cust_saved', label: 'View saved' },
        { id: 'cust_browse', label: 'Marketplace' },
      ]
    );
    return;
  }

  if (cmd === 'cust_cart' || lower === 'cart') {
    if (!(await requireRegistered(identity, chatId, 'Cart'))) return;
    const cart = parseCart(conv.cart_json);
    if (cart.length === 0) {
      const savedCount = parseCart(conv.saved_json ?? '[]').length;
      await sendMenu(
        db,
        chatId,
        phone,
        savedCount
          ? 'Your cart is empty. You have items saved for later.'
          : 'Your cart is empty. Reply *marketplace* to shop.',
        savedCount
          ? [
              { id: 'cust_saved', label: 'Saved for later' },
              { id: 'cust_browse', label: 'Marketplace' },
            ]
          : [{ id: 'cust_browse', label: 'Marketplace' }]
      );
      return;
    }
    const groups = groupCartByStore(db, cart);
    const lines: string[] = ['*Your cart*', ''];
    for (const group of groups) {
      lines.push(`*${group.storeName}*`);
      for (const item of group.items) {
        lines.push(
          `• ${item.name} ×${item.quantity} — ${formatNgn(kobo(item.unit_price_kobo * item.quantity))}`
        );
      }
      lines.push('');
    }
    if (groups.length > 1) {
      lines.push(
        `Buying from *${groups.length} stores* — you get one order per store, paid together.`
      );
      lines.push('');
    }
    lines.push(`*Total: ${formatNgn(cartTotal(cart))}*`);
    await sendMenu(db, chatId, phone, lines.join('\n'), [
      { id: 'cust_checkout', label: 'Checkout' },
      { id: 'cust_save_later', label: 'Save for later' },
      { id: 'cust_clear_cart', label: 'Clear cart' },
      { id: 'cust_browse', label: 'Marketplace' },
    ]);
    return;
  }

  if (cmd === 'cust_clear_cart' || lower === 'clear cart') {
    if (!(await requireRegistered(identity, chatId, 'Clear cart'))) return;
    updateConversation(db, phone, { cart_json: '[]' });
    await sendText(chatId, 'Cart cleared.');
    return;
  }

  if (cmd === 'cust_checkout' || lower === 'checkout' || lower === 'pay') {
    if (!(await requireRegistered(identity, chatId, 'Checkout'))) return;
    await startCheckout(db, identity, chatId);
    return;
  }

  if (cmd.startsWith('log_')) {
    if (!(await requireRegistered(identity, chatId, 'Checkout'))) return;
    await chooseLogisticsMethod(db, identity, chatId, cmd);
    return;
  }

  if (cmd.startsWith('pay_')) {
    if (!(await requireRegistered(identity, chatId, 'Payment'))) return;
    const method = cmd.slice('pay_'.length) as 'monnify' | 'wallet' | 'bank';
    await completeCheckout(db, identity, chatId, method);
    return;
  }

  if (lower.startsWith('waybill ')) {
    if (!(await requireRegistered(identity, chatId, 'Waybill'))) return;
    const { handleBuyerWaybillRequest } = await import('./logistics');
    await handleBuyerWaybillRequest(db, identity, chatId, text.trim().slice(8).trim());
    return;
  }

  if (lower === 'link cabme') {
    if (!(await requireRegistered(identity, chatId, 'Cabme link'))) return;
    const { linkCabmeAccount } = await import('../../services/cabmeLink');
    const result = await linkCabmeAccount(db, identity.user!.id, identity.phone);
    if (result.status === 'linked') {
      await sendText(
        chatId,
        `Cabme account linked ✅ (id ${result.cabmeUserId}).\nYou can now request dispatch waybills.`
      );
    } else {
      await sendText(chatId, result.message);
    }
    return;
  }

  if (cmd === 'cust_orders' || lower === 'orders' || lower === 'my orders') {
    if (!(await requireRegistered(identity, chatId, 'Orders'))) return;
    await showCustomerOrders(db, identity, chatId);
    return;
  }

  if (lower.startsWith('status ')) {
    if (!(await requireRegistered(identity, chatId, 'Order status'))) return;
    const orderNumber = text.trim().slice(7).trim();
    await showOrderStatus(db, identity, chatId, orderNumber);
    return;
  }

  if (lower.startsWith('cancel ')) {
    if (!(await requireRegistered(identity, chatId, 'Cancel order'))) return;
    const orderNumber = text.trim().slice(7).trim();
    await cancelOrder(db, identity, chatId, orderNumber);
    return;
  }

  if (lower.startsWith('reorder ')) {
    if (!(await requireRegistered(identity, chatId, 'Reorder'))) return;
    const orderNumber = text.trim().slice(8).trim();
    await reorder(db, identity, chatId, orderNumber);
    return;
  }

  if (cmd === 'cust_wallet' || lower === 'wallet') {
    if (!(await requireRegistered(identity, chatId, 'Wallet'))) return;
    const { handleWalletMenu } = await import('./wallet');
    await handleWalletMenu(db, identity, chatId);
    return;
  }

  if (
    cmd === 'cust_profile' ||
    lower === 'profile' ||
    lower === 'my profile' ||
    lower === 'account'
  ) {
    if (!(await requireRegistered(identity, chatId, 'Profile'))) return;
    await showProfile(db, identity, chatId);
    return;
  }

  await sendText(
    chatId,
    `I didn't understand that.\nReply *menu* for options, or *marketplace* / *search*.`
  );
}

async function startCheckout(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const cart = parseCart(conv.cart_json);
  if (cart.length === 0) {
    await sendText(chatId, 'Cart is empty.');
    return;
  }
  const total = cartTotal(cart);
  const groups = groupCartByStore(db, cart);
  const storeNote =
    groups.length > 1
      ? `\nThis cart has *${groups.length} stores*. You will get *${groups.length} orders* (one per store), paid in one go.`
      : '';
  await sendMenu(
    db,
    chatId,
    identity.phone,
    `Checkout total (items): *${formatNgn(total)}*${storeNote}\nHow should this get to you?`,
    [
    { id: 'log_vendor', label: 'Vendor delivery' },
    { id: 'log_dispatch', label: 'Dispatch pickup' },
    { id: 'log_walkin', label: 'I will pick it up' },
  ]);
}

async function chooseLogisticsMethod(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  cmd: string
): Promise<void> {
  const method =
    cmd === 'log_vendor'
      ? 'vendor_delivery'
      : cmd === 'log_dispatch'
        ? 'dispatch_pickup'
        : cmd === 'log_walkin'
          ? 'walk_in'
          : null;
  if (!method) {
    await sendText(chatId, 'Unknown logistics option.');
    return;
  }

  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);

  if (method === 'walk_in') {
    updateConversation(db, identity.phone, {
      state: 'checkout_pay',
      context_json: JSON.stringify({
        ...ctx,
        logistics_method: method,
        checkout_lga: null,
        checkout_address: null,
        delivery_fee_kobo: 0,
      }),
    });
    const cart = parseCart(conv.cart_json);
    const total = cartTotal(cart);
    await sendMenu(
      db,
      chatId,
      identity.phone,
      `Walk-in pickup selected.\nItems: *${formatNgn(total)}*\nDelivery: *₦0.00*\n\nChoose payment:`,
      [
        { id: 'pay_monnify', label: 'Monnify link' },
        { id: 'pay_wallet', label: 'Wallet balance' },
        { id: 'pay_bank', label: 'Bank transfer' },
      ]
    );
    return;
  }

  updateConversation(db, identity.phone, {
    state: 'checkout_pick_dropoff',
    context_json: JSON.stringify({
      ...ctx,
      logistics_method: method,
    }),
  });
  await promptDropoffChoice(db, identity, chatId, method);
}

function dropoffLabel(loc: UserDeliveryAddressRow): string {
  const star = Number(loc.is_default) ? '★ ' : '';
  return `${star}${loc.label} · ${loc.lga}`.slice(0, 36);
}

async function promptDropoffChoice(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  method: 'vendor_delivery' | 'dispatch_pickup'
): Promise<void> {
  const saved = identity.user
    ? listUserDeliveryAddresses(db, identity.user.id)
    : [];
  const methodLabel =
    method === 'vendor_delivery' ? 'Vendor delivery' : 'Dispatch pickup';

  if (saved.length === 0) {
    await startNewDropoffCapture(db, identity, chatId);
    return;
  }

  const options: MenuOption[] = saved.map((loc, i) => ({
    id: `loc_use_${i}`,
    label: dropoffLabel(loc),
  }));
  options.push({ id: 'loc_new', label: 'New location' });

  await sendMenu(
    db,
    chatId,
    identity.phone,
    [
      `${methodLabel} selected.`,
      'Pick a *saved dropoff*, or *New location*.',
      Number(saved[0]?.is_default)
        ? `Default: *${saved[0]!.label}* (${saved[0]!.lga})`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    options
  );
}

async function startNewDropoffCapture(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  const method = String(ctx.logistics_method ?? '');
  updateConversation(db, identity.phone, {
    state: 'checkout_lga',
    context_json: JSON.stringify({ ...ctx, pending_new_dropoff: true }),
  });
  await sendText(
    chatId,
    method === 'dispatch_pickup'
      ? 'Enter your *dropoff LGA* (e.g. Surulere):'
      : 'Enter your *dropoff LGA* (e.g. Ikeja):'
  );
}

async function applySavedDropoff(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  index: number
): Promise<void> {
  const userId = identity.user?.id;
  if (!userId) return;
  const saved = listUserDeliveryAddresses(db, userId);
  const loc = Number.isInteger(index) ? saved[index] : undefined;
  if (!loc) {
    await sendText(
      chatId,
      'That saved location was not found. Pick another or reply *new*.'
    );
    return;
  }
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  updateConversation(db, identity.phone, {
    context_json: JSON.stringify({
      ...ctx,
      checkout_lga: loc.lga,
      checkout_lat: loc.lat,
      checkout_lng: loc.lng,
      checkout_location_label: loc.label,
      pending_new_dropoff: false,
    }),
  });
  await finalizeLogisticsAndAskPayment(db, identity, chatId, loc.address);
}

async function askSaveNewDropoff(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  address: string
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  updateConversation(db, identity.phone, {
    state: 'checkout_save_loc',
    context_json: JSON.stringify({
      ...ctx,
      checkout_address: address,
      pending_new_dropoff: true,
    }),
  });
  await sendMenu(
    db,
    chatId,
    identity.phone,
    [
      `Dropoff: *${address}*`,
      `LGA: *${String(ctx.checkout_lga ?? '')}*`,
      '',
      'Save this location and use it as your *default* next time?',
    ].join('\n'),
    [
      { id: 'loc_save_yes', label: 'Yes, save as default' },
      { id: 'loc_save_no', label: 'No, just this order' },
    ]
  );
}

async function finishDropoffSavePrompt(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  saveAsDefault: boolean
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  const address = String(ctx.checkout_address ?? ctx.checkout_location_label ?? '');
  const lga = String(ctx.checkout_lga ?? '');
  const lat = Number(ctx.checkout_lat);
  const lng = Number(ctx.checkout_lng);
  const userId = identity.user?.id;

  if (saveAsDefault && userId && lga && Number.isFinite(lat) && Number.isFinite(lng)) {
    const label = address.slice(0, 60) || lga;
    saveUserDeliveryAddress(db, {
      userId,
      phone: identity.phone,
      label,
      lga,
      address: address || lga,
      lat,
      lng,
      makeDefault: true,
    });
  }

  await finalizeLogisticsAndAskPayment(db, identity, chatId, address || lga);
}

async function finalizeLogisticsAndAskPayment(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  address: string
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  const method = String(ctx.logistics_method ?? '') as
    | 'vendor_delivery'
    | 'dispatch_pickup'
    | 'walk_in';
  const lga = String(ctx.checkout_lga ?? '');
  const dropLat = Number(ctx.checkout_lat);
  const dropLng = Number(ctx.checkout_lng);
  if (!method || !lga || !Number.isFinite(dropLat) || !Number.isFinite(dropLng)) {
    await sendText(chatId, 'Checkout session expired. Reply *checkout* to start again.');
    return;
  }

  const cart = parseCart(conv.cart_json);
  const groups = groupCartByStore(db, cart);
  if (groups.length === 0) {
    await sendText(chatId, 'Cart is empty.');
    return;
  }

  const { lookupVendorDeliveryFee } = await import('./logistics');
  const { getStorePickupLocation } = await import('../../services/logistics');
  const feesByStore: Record<string, number> = {};
  let feeKobo = 0;
  const missingRates: string[] = [];
  if (method === 'vendor_delivery' || method === 'dispatch_pickup') {
    for (const group of groups) {
      const fee = lookupVendorDeliveryFee(db, group.storeId, lga);
      if (fee <= 0 && method === 'vendor_delivery') {
        missingRates.push(group.storeName);
      }
      feesByStore[group.storeId] = Math.max(0, fee);
      feeKobo += Math.max(0, fee);
    }
    if (missingRates.length > 0) {
      await sendText(
        chatId,
        `These stores have not set a delivery rate for LGA *${lga}* yet:\n• ${missingRates.join('\n• ')}\n\nChoose *Dispatch pickup* or *I will pick it up*, or save those items for later.`
      );
      updateConversation(db, identity.phone, { state: 'idle' });
      return;
    }
    const missingPin = groups.filter((g) => !getStorePickupLocation(db, g.storeId));
    if (missingPin.length > 0) {
      await sendText(
        chatId,
        `Note: ${missingPin.map((g) => g.storeName).join(', ')} ${missingPin.length === 1 ? 'has' : 'have'} not shared a pickup pin yet.`
      );
    }
  }

  const itemsTotal = cartTotal(cart);
  const payable = kobo(Number(itemsTotal) + feeKobo);
  const breakdown = groups
    .map((g) => {
      const fee = feesByStore[g.storeId] ?? 0;
      return `• ${g.storeName}: items ${formatNgn(g.itemsKobo)}${
        fee > 0 ? ` + delivery ${formatNgn(kobo(fee))}` : ''
      }`;
    })
    .join('\n');

  updateConversation(db, identity.phone, {
    state: 'checkout_pay',
    context_json: JSON.stringify({
      ...ctx,
      logistics_method: method,
      checkout_lga: lga,
      checkout_address: address,
      checkout_lat: dropLat,
      checkout_lng: dropLng,
      delivery_fee_kobo: feeKobo,
      delivery_fees_by_store: feesByStore,
    }),
  });

  await sendMenu(
    db,
    chatId,
    identity.phone,
    [
      `*Checkout summary*`,
      groups.length > 1
        ? `${groups.length} stores — one order each, paid together.`
        : '',
      breakdown,
      `Items: ${formatNgn(itemsTotal)}`,
      `Delivery (${method === 'vendor_delivery' ? 'vendor' : 'dispatch'} · ${lga}): ${formatNgn(kobo(feeKobo))}`,
      `Total: *${formatNgn(payable)}*`,
      ``,
      `Choose payment:`,
    ]
      .filter(Boolean)
      .join('\n'),
    [
      { id: 'pay_monnify', label: 'Monnify link' },
      { id: 'pay_wallet', label: 'Wallet balance' },
      { id: 'pay_bank', label: 'Bank transfer' },
      { id: 'cust_clear_cart', label: 'Clear cart' },
    ]
  );
}

async function ensureCustomer(
  db: Db,
  storeId: string,
  phone: string,
  name?: string
): Promise<string> {
  const existing = db
    .prepare(
      `SELECT id FROM customers WHERE store_id = ? AND whatsapp_number = ?`
    )
    .get(storeId, phone) as { id: string } | undefined;
  if (existing) return existing.id;

  // Plan customer limit (use store plan)
  const store = db
    .prepare('SELECT subscription_plan FROM stores WHERE id = ?')
    .get(storeId) as { subscription_plan: SubscriptionPlan } | undefined;
  if (store) {
    const features = getPlanFeatures(store.subscription_plan);
    const count = (
      db
        .prepare('SELECT COUNT(*) AS c FROM customers WHERE store_id = ?')
        .get(storeId) as { c: number }
    ).c;
    const warn = usageWarning(count, features.max_customers);
    if (warn) console.warn(warn);
    const gate = assertWithinLimit(count, features.max_customers, 'Customers');
    if (!gate.ok) throw new Error(gate.message);
  }

  const id = newId('cus');
  db.prepare(
    `INSERT INTO customers (id, store_id, whatsapp_number, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, storeId, phone, name ?? null, nowIso(), nowIso());
  return id;
}

async function sendWalletOrderReceipts(
  db: Db,
  params: {
    chatId: string;
    identity: ResolvedIdentity;
    store: {
      id: string;
      name?: string;
      user_id: string;
      whatsapp_number?: string | null;
    };
    cart: CartItem[];
    orderId: string;
    orderNumber: string;
    itemsTotal: Kobo;
    deliveryFeeKobo: number;
    total: Kobo;
    logisticsMethod: string;
    tip: string;
  }
): Promise<void> {
  const storeName = params.store.name?.trim() || 'Pas2me store';
  let storeAddress: string | null = null;
  let storePhone: string | null = params.store.whatsapp_number ?? null;
  try {
    const extra = db
      .prepare(
        `SELECT description, whatsapp_number, settings FROM stores WHERE id = ?`
      )
      .get(params.store.id) as
      | {
          description?: string | null;
          whatsapp_number?: string | null;
          settings?: string | null;
        }
      | undefined;
    storePhone = extra?.whatsapp_number || storePhone;
    storeAddress = extra?.description?.trim() || null;
    if (!storeAddress && extra?.settings) {
      try {
        const settings = JSON.parse(extra.settings) as Record<string, unknown>;
        const addr =
          (typeof settings.address === 'string' && settings.address) ||
          (typeof settings.pickup_address === 'string' &&
            settings.pickup_address) ||
          null;
        storeAddress = addr;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* columns may differ */
  }
  const buyerName = displayName(params.identity);
  const fulfillment =
    params.logisticsMethod === 'dispatch_pickup'
      ? 'Dispatch pickup'
      : params.logisticsMethod === 'vendor_delivery'
        ? 'Vendor delivery'
        : 'In-store pickup';

  const pdfBase = {
    orderNumber: params.orderNumber,
    storeName,
    storeAddress,
    storePhone,
    buyerName,
    buyerPhone: formatPhoneDisplay(params.identity.phone),
    cart: params.cart,
    itemsTotal: params.itemsTotal,
    deliveryFeeKobo: params.deliveryFeeKobo,
    total: params.total,
    fulfillment,
    paidVia: 'Wallet',
    issuedAt: new Date(),
  };

  const fileName = `Pas2me-receipt-${params.orderNumber}.pdf`;
  try {
    const buyerPdf = await buildOrderReceiptPdf(db, {
      ...pdfBase,
      audience: 'buyer',
    });
    const sent = await sendDocument(params.chatId, buyerPdf, {
      fileName,
      caption: [
        `Receipt for *${params.orderNumber}*`,
        `Total: *${formatNgn(params.total)}*`,
        params.tip,
      ]
        .filter(Boolean)
        .join('\n'),
    });
    if (!sent) {
      await sendText(
        params.chatId,
        `Receipt *${params.orderNumber}* — total ${formatNgn(params.total)}\n${params.tip}`
      );
    }
  } catch (err) {
    console.error('[order] buyer PDF receipt failed', err);
    await sendText(
      params.chatId,
      `Receipt *${params.orderNumber}* — total ${formatNgn(params.total)}\n${params.tip}`
    );
  }

  await notifyVendorsOfPaidOrder(db, params.orderId, 'Wallet');
}

async function completeCheckout(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  method: 'monnify' | 'wallet' | 'bank'
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const cart = parseCart(conv.cart_json);
  if (cart.length === 0) {
    await sendText(chatId, 'Cart is empty.');
    return;
  }

  const short: string[] = [];
  for (const item of cart) {
    const available = getInventoryQty(db, item.product_id);
    if (available < item.quantity) {
      short.push(
        `• ${item.name} — want ${item.quantity}, in stock ${available}`
      );
    }
  }
  if (short.length > 0) {
    await sendText(
      chatId,
      `Not enough stock to complete this order:\n${short.join('\n')}\n\nUpdate your cart and try again.`
    );
    return;
  }

  const groups = groupCartByStore(db, cart);
  type StoreSnap = {
    id: string;
    name?: string;
    subscription_plan: SubscriptionPlan;
    user_id: string;
    whatsapp_number?: string | null;
  };
  const stores: StoreSnap[] = [];
  for (const group of groups) {
    const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(group.storeId) as
      | StoreSnap
      | undefined;
    if (!store) {
      await sendText(
        chatId,
        `Store not found for items from ${group.storeName}.`
      );
      return;
    }
    stores.push(store);
    const features = getPlanFeatures(store.subscription_plan);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const orderCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM orders WHERE store_id = ? AND created_at >= ?`
        )
        .get(store.id, monthStart.toISOString()) as { c: number }
    ).c;
    const orderGate = assertWithinLimit(
      orderCount,
      features.max_orders_per_month,
      'Orders'
    );
    if (!orderGate.ok) {
      await sendText(chatId, `${store.name ?? 'Store'}: ${orderGate.message}`);
      return;
    }
  }

  const ctx = getContext(conv);
  const logisticsMethod = (String(ctx.logistics_method ?? 'walk_in') ||
    'walk_in') as 'vendor_delivery' | 'dispatch_pickup' | 'walk_in';
  const deliveryFeeKobo = Number(ctx.delivery_fee_kobo ?? 0);
  const dropoffLga = ctx.checkout_lga ? String(ctx.checkout_lga) : undefined;
  const dropoffAddress = ctx.checkout_address
    ? String(ctx.checkout_address)
    : undefined;
  const dropoffLat =
    typeof ctx.checkout_lat === 'number' ? ctx.checkout_lat : Number(ctx.checkout_lat);
  const dropoffLng =
    typeof ctx.checkout_lng === 'number' ? ctx.checkout_lng : Number(ctx.checkout_lng);

  if (
    (logisticsMethod === 'vendor_delivery' ||
      logisticsMethod === 'dispatch_pickup') &&
    (!dropoffLga ||
      !dropoffAddress ||
      !Number.isFinite(dropoffLat) ||
      !Number.isFinite(dropoffLng))
  ) {
    await sendText(
      chatId,
      'Delivery details missing (LGA + shared location). Reply *checkout* and choose logistics again.'
    );
    return;
  }

  const feesRaw = ctx.delivery_fees_by_store;
  const feesByStore =
    feesRaw && typeof feesRaw === 'object' && !Array.isArray(feesRaw)
      ? (feesRaw as Record<string, number>)
      : {};

  const itemsTotal = cartTotal(cart);
  const total = kobo(Number(itemsTotal) + deliveryFeeKobo);
  const toNaira = (amountKobo: number) => amountKobo / 100;

  const {
    createOrderLogistics,
    markLogisticsPaidReady,
    lockDeliveryFee,
  } = await import('../../services/logistics');

  const deliveryMethodDb =
    logisticsMethod === 'walk_in' ? 'pickup' : 'delivery';

  const created: Array<{
    orderId: string;
    orderNumber: string;
    store: (typeof stores)[0];
    items: CartItem[];
    itemsTotal: ReturnType<typeof kobo>;
    deliveryFeeKobo: number;
    total: ReturnType<typeof kobo>;
  }> = groups.map((group, i) => {
    const store = stores[i]!;
    const groupFee = Number(
      feesByStore[group.storeId] ?? (groups.length === 1 ? deliveryFeeKobo : 0)
    );
    return {
      orderId: newId('ord'),
      orderNumber: `P2M${Date.now().toString(36).toUpperCase()}${i > 0 ? String(i + 1) : ''}`,
      store,
      items: group.items,
      itemsTotal: group.itemsKobo,
      deliveryFeeKobo: groupFee,
      total: kobo(Number(group.itemsKobo) + groupFee),
    };
  });

  for (const [i, group] of groups.entries()) {
    const store = stores[i]!;
    const customerId = await ensureCustomer(
      db,
      store.id,
      identity.phone,
      identity.user
        ? `${identity.user.first_name} ${identity.user.last_name}`
        : undefined
    );
    const row = created[i]!;
    db.prepare(
      `INSERT INTO orders
        (id, store_id, customer_id, order_number, status, subtotal, tax_amount, shipping_amount,
         total_amount, currency, payment_status, shipping_address, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, ?, 'NGN', 'pending', ?, ?, ?)`
    ).run(
      row.orderId,
      store.id,
      customerId,
      row.orderNumber,
      toNaira(Number(group.itemsKobo)),
      toNaira(row.deliveryFeeKobo),
      toNaira(Number(row.total)),
      JSON.stringify({
        lga: dropoffLga ?? null,
        address: dropoffAddress ?? null,
        logistics_method: logisticsMethod,
        delivery_method: deliveryMethodDb,
      }),
      nowIso(),
      nowIso()
    );
    for (const item of group.items) {
      const line = item.unit_price_kobo * item.quantity;
      db.prepare(
        `INSERT INTO order_items
          (id, order_id, product_id, name, quantity, unit_price, total_price, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        newId('oi'),
        row.orderId,
        item.product_id,
        item.name,
        item.quantity,
        item.unit_price_kobo / 100,
        line / 100,
        nowIso()
      );
    }
    createOrderLogistics(db, {
      orderId: row.orderId,
      storeId: store.id,
      method: logisticsMethod,
      dropoffLga,
      dropoffAddress,
      dropoffLat: Number.isFinite(dropoffLat) ? dropoffLat : undefined,
      dropoffLng: Number.isFinite(dropoffLng) ? dropoffLng : undefined,
      deliveryFeeKobo: row.deliveryFeeKobo,
      feePayer: logisticsMethod === 'walk_in' ? 'none' : 'buyer',
      status: 'awaiting_payment',
    });
  }

  const primary = created[0]!;
  const reference =
    created.length === 1
      ? `pay_${primary.orderId}`
      : `payg_${newId('og')}`;
  const env = getEnv();
  const orderLabel = created.map((c) => `*${c.orderNumber}*`).join(', ');

  if (method === 'wallet') {
    if (!identity.user) {
      await sendText(
        chatId,
        'Wallet checkout requires a registered Pas2me account linked to this phone.'
      );
      return;
    }
    const { requireReadyWalletOrPromptKyc } = await import('./wallet');
    const wallet = await requireReadyWalletOrPromptKyc(db, identity, chatId);
    if (!wallet) return;

    try {
      applyLedgerEntry(db, {
        userId: identity.user.id,
        direction: 'debit',
        amount: total,
        type: 'purchase',
        idempotencyKey: `purchase_${primary.orderId}`,
        storeId: primary.store.id,
        orderId: primary.orderId,
        metadata: {
          order_numbers: created.map((c) => c.orderNumber),
          delivery_fee_kobo: deliveryFeeKobo,
        },
        actorPhone: identity.phone,
      });

      const { getReadyWallet } = await import('../../services/monnifyWallet');
      for (const row of created) {
        if (getReadyWallet(db, row.store.user_id)) {
          applyLedgerEntry(db, {
            userId: row.store.user_id,
            direction: 'credit',
            amount: row.itemsTotal,
            type: 'purchase',
            idempotencyKey: `vendor_credit_${row.orderId}`,
            storeId: row.store.id,
            orderId: row.orderId,
            metadata: {
              order_number: row.orderNumber,
              location_store_id: row.store.id,
            },
          });
          if (row.deliveryFeeKobo > 0 && logisticsMethod === 'vendor_delivery') {
            lockDeliveryFee(db, {
              payerUserId: identity.user.id,
              recipientUserId: row.store.user_id,
              amount: kobo(row.deliveryFeeKobo),
              orderId: row.orderId,
              actorPhone: identity.phone,
            });
          }
          if (row.deliveryFeeKobo > 0 && logisticsMethod === 'dispatch_pickup') {
            db.prepare(
              `UPDATE order_logistics SET fee_hold_status = 'held', updated_at = ? WHERE order_id = ?`
            ).run(nowIso(), row.orderId);
          }
        }
        db.prepare(
          `UPDATE orders SET payment_status = 'paid', payment_method = 'wallet', payment_reference = ?, status = 'confirmed', updated_at = ? WHERE id = ?`
        ).run(reference, nowIso(), row.orderId);
        markLogisticsPaidReady(db, row.orderId);
        applyPaidOrderToInventory(db, row.orderId);
      }

      updateConversation(db, identity.phone, {
        cart_json: '[]',
        state: 'idle',
        context_json: JSON.stringify({}),
      });

      for (const row of created) {
        const tip =
          logisticsMethod === 'dispatch_pickup'
            ? `When ready, reply *waybill ${row.orderNumber}* to request a dispatch rider.`
            : logisticsMethod === 'vendor_delivery'
              ? 'The store will arrange dispatch. Delivery funds stay locked until delivery.'
              : 'Show this order number in-store for pickup.';
        await sendWalletOrderReceipts(db, {
          chatId,
          identity,
          store: row.store,
          cart: row.items,
          orderId: row.orderId,
          orderNumber: row.orderNumber,
          itemsTotal: row.itemsTotal,
          deliveryFeeKobo: row.deliveryFeeKobo,
          total: row.total,
          logisticsMethod,
          tip,
        });
      }
    } catch (err) {
      await sendText(
        chatId,
        `Wallet payment failed: ${err instanceof Error ? err.message : 'error'}`
      );
    }
    return;
  }

  for (const row of created) {
    db.prepare(
      `UPDATE orders SET payment_reference = ?, updated_at = ? WHERE id = ?`
    ).run(reference, nowIso(), row.orderId);
  }

  db.prepare(
    `INSERT INTO payment_links
      (id, store_id, order_id, amount, currency, description, reference, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'NGN', ?, ?, 'active', ?, ?)`
  ).run(
    newId('plink'),
    primary.store.id,
    primary.orderId,
    toNaira(Number(total)),
    `Orders ${created.map((c) => c.orderNumber).join(', ')}`,
    reference,
    nowIso(),
    nowIso()
  );

  updateConversation(db, identity.phone, { cart_json: '[]', state: 'idle' });

  if (method === 'bank') {
    const charge = await createBankTransferCharge({
      amount: total,
      customerPhone: identity.phone,
      customerName: identity.user
        ? `${identity.user.first_name} ${identity.user.last_name}`.trim()
        : undefined,
      description: `Pas2me ${created.length > 1 ? 'orders' : 'order'} ${created.map((c) => c.orderNumber).join(', ')}`,
      reference,
      callbackUrl: `${env.BOT_PUBLIC_URL}/webhooks/monnify/payment`,
    });
    await sendText(
      chatId,
      describeBankTransferInstructions(reference, total, charge) +
        `\n\nOrder(s) ${orderLabel} created (awaiting payment).`
    );
    return;
  }

  const checkout = await createCheckout({
    amount: total,
    customerPhone: identity.phone,
    customerName: identity.user
      ? `${identity.user.first_name} ${identity.user.last_name}`.trim()
      : undefined,
    description: `Pas2me ${created.length > 1 ? 'orders' : 'order'} ${created.map((c) => c.orderNumber).join(', ')}`,
    reference,
    callbackUrl: `${env.BOT_PUBLIC_URL}/webhooks/monnify/payment`,
  });

  await sendText(
    chatId,
    `${created.length > 1 ? 'Orders' : 'Order'} ${orderLabel} created.\nPay here:\n${checkout.checkoutUrl}`
  );
}

async function showCustomerOrders(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  const rows = db
    .prepare(
      `SELECT o.order_number, o.status, o.payment_status, o.total_amount, o.created_at
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       WHERE c.whatsapp_number = ?
       ORDER BY o.created_at DESC
       LIMIT 5`
    )
    .all(identity.phone) as Array<{
    order_number: string;
    status: string;
    payment_status: string;
    total_amount: number | string;
    created_at: string;
  }>;

  if (rows.length === 0) {
    await sendText(chatId, 'No orders yet.');
    return;
  }

  const lines = rows.map(
    (r) =>
      `• *${r.order_number}* — ${r.status}/${r.payment_status} — ${formatNgn(decimalToKobo(r.total_amount))}`
  );
  lines.push(
    '',
    'Commands:',
    'status ORDER_NO',
    'cancel ORDER_NO',
    'reorder ORDER_NO'
  );
  await sendText(chatId, lines.join('\n'));
}

async function showOrderStatus(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  orderNumber: string
): Promise<void> {
  const row = db
    .prepare(
      `SELECT o.* FROM orders o
       JOIN customers c ON c.id = o.customer_id
       WHERE o.order_number = ? AND c.whatsapp_number = ?`
    )
    .get(orderNumber, identity.phone) as
    | {
        status: string;
        payment_status: string;
        total_amount: number | string;
      }
    | undefined;
  if (!row) {
    await sendText(chatId, 'Order not found.');
    return;
  }
  await sendText(
    chatId,
    `Order *${orderNumber}*\nStatus: ${row.status}\nPayment: ${row.payment_status}\nTotal: ${formatNgn(decimalToKobo(row.total_amount))}`
  );
}

async function cancelOrder(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  orderNumber: string
): Promise<void> {
  const row = db
    .prepare(
      `SELECT o.id, o.status, o.payment_status FROM orders o
       JOIN customers c ON c.id = o.customer_id
       WHERE o.order_number = ? AND c.whatsapp_number = ?`
    )
    .get(orderNumber, identity.phone) as
    | { id: string; status: string; payment_status: string }
    | undefined;

  if (!row) {
    await sendText(chatId, 'Order not found.');
    return;
  }
  if (row.payment_status === 'paid') {
    await sendText(
      chatId,
      'Paid orders cannot be cancelled here. Contact the store for a refund.'
    );
    return;
  }
  if (row.status === 'cancelled') {
    await sendText(chatId, 'Order already cancelled.');
    return;
  }
  db.prepare(
    `UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ?`
  ).run(nowIso(), row.id);
  await sendText(chatId, `Order *${orderNumber}* cancelled.`);
}

async function reorder(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  orderNumber: string
): Promise<void> {
  const order = db
    .prepare(
      `SELECT o.id, o.store_id FROM orders o
       JOIN customers c ON c.id = o.customer_id
       WHERE o.order_number = ? AND c.whatsapp_number = ?`
    )
    .get(orderNumber, identity.phone) as
    | { id: string; store_id: string }
    | undefined;
  if (!order) {
    await sendText(chatId, 'Order not found.');
    return;
  }
  const items = db
    .prepare(
      `SELECT product_id, name, quantity, unit_price FROM order_items WHERE order_id = ?`
    )
    .all(order.id) as Array<{
    product_id: string;
    name: string;
    quantity: number;
    unit_price: number | string;
  }>;

  const cart: CartItem[] = items.map((i) => ({
    product_id: i.product_id,
    store_id: order.store_id,
    name: i.name,
    unit_price_kobo: Number(decimalToKobo(i.unit_price)),
    quantity: i.quantity,
  }));

  updateConversation(db, identity.phone, {
    cart_json: JSON.stringify(cart),
    selected_store_id: order.store_id,
  });
  await sendText(
    chatId,
    `Reordered items from *${orderNumber}* into your cart. Reply *cart* or *checkout*.`
  );
}
