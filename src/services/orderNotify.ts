import type { Db } from '../db/client';
import { findUserById, type CartItem } from '../db/repos';
import { decimalToKobo, formatNgn, kobo, type Kobo } from '../domain/money';
import { normalizePhone } from '../domain/ids';
import { sendDocumentToPhone } from './whatsapp';
import { buildOrderReceiptPdf } from './receiptPdf';
import { getOrderLogistics } from './logistics';

export function listVendorNotifyPhones(
  db: Db,
  store: { id: string; user_id: string; whatsapp_number?: string | null }
): string[] {
  const phones = new Set<string>();
  const add = (raw?: string | null) => {
    if (!raw) return;
    const n = normalizePhone(raw);
    if (n.length >= 11) phones.add(n);
  };

  const owner = findUserById(db, store.user_id);
  add(owner?.phone);
  add(store.whatsapp_number);

  try {
    const storeRow = db
      .prepare(`SELECT whatsapp_number FROM stores WHERE id = ?`)
      .get(store.id) as { whatsapp_number?: string | null } | undefined;
    add(storeRow?.whatsapp_number);
  } catch {
    /* column may be missing */
  }

  try {
    const ops = db
      .prepare(
        `SELECT phone, normalized_phone FROM store_whatsapp_operators WHERE store_id = ?`
      )
      .all(store.id) as Array<{
      phone: string | null;
      normalized_phone: string | null;
    }>;
    for (const op of ops) add(op.normalized_phone || op.phone);
  } catch {
    /* ignore */
  }

  try {
    const staff = db
      .prepare(
        `SELECT u.phone FROM staff_assignments sa
         JOIN users u ON u.id = sa.user_id
         WHERE sa.store_id = ? AND sa.is_active = 1`
      )
      .all(store.id) as Array<{ phone: string | null }>;
    for (const row of staff) add(row.phone);
  } catch {
    /* ignore */
  }

  return [...phones];
}

function formatPhoneDisplay(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.startsWith('234') && digits.length === 13) {
    return `+234 ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
  }
  return phone?.trim() || '—';
}

function fulfillmentLabel(method: string | null | undefined): string {
  if (method === 'dispatch_pickup') return 'Dispatch pickup';
  if (method === 'vendor_delivery') return 'Vendor delivery';
  return 'In-store pickup';
}

/** WhatsApp the store owner/staff that a customer payment succeeded. */
export async function notifyVendorsOfPaidOrder(
  db: Db,
  orderId: string,
  paidVia: string
): Promise<void> {
  const order = db
    .prepare(
      `SELECT o.id, o.store_id, o.order_number, o.total_amount, o.shipping_amount,
              o.subtotal, o.customer_id, o.shipping_address
       FROM orders o WHERE o.id = ?`
    )
    .get(orderId) as
    | {
        id: string;
        store_id: string;
        order_number: string;
        total_amount: number | string;
        shipping_amount?: number | string | null;
        subtotal?: number | string | null;
        customer_id: string | null;
        shipping_address?: string | null;
      }
    | undefined;
  if (!order) {
    console.warn(`[order] vendor notify skipped — order ${orderId} not found`);
    return;
  }

  const store = db
    .prepare(`SELECT id, user_id, name, whatsapp_number, description, settings FROM stores WHERE id = ?`)
    .get(order.store_id) as
    | {
        id: string;
        user_id: string;
        name?: string | null;
        whatsapp_number?: string | null;
        description?: string | null;
        settings?: string | null;
      }
    | undefined;
  if (!store) {
    console.warn(`[order] vendor notify skipped — store missing for ${order.order_number}`);
    return;
  }

  const phones = listVendorNotifyPhones(db, store);
  if (phones.length === 0) {
    console.warn(
      `[order] vendor notify skipped — no WhatsApp on store=${store.id} (${store.name ?? ''})`
    );
    return;
  }

  const items = db
    .prepare(
      `SELECT product_id, name, quantity, unit_price FROM order_items WHERE order_id = ?`
    )
    .all(orderId) as Array<{
    product_id: string;
    name: string;
    quantity: number;
    unit_price: number | string;
  }>;
  const cart: CartItem[] = items.map((item) => ({
    product_id: item.product_id,
    store_id: order.store_id,
    name: item.name,
    unit_price_kobo: Number(decimalToKobo(item.unit_price)),
    quantity: item.quantity,
  }));

  const customer = order.customer_id
    ? (db
        .prepare(`SELECT name, whatsapp_number FROM customers WHERE id = ?`)
        .get(order.customer_id) as
        | { name?: string | null; whatsapp_number?: string | null }
        | undefined)
    : undefined;

  const logistics = getOrderLogistics(db, orderId);
  const deliveryFeeKobo = Number(logistics?.delivery_fee_kobo ?? 0);
  const itemsTotal = kobo(
    Math.round(Number(order.subtotal ?? 0) * 100) ||
      cart.reduce((s, i) => s + i.unit_price_kobo * i.quantity, 0)
  );
  const total = kobo(Math.round(Number(order.total_amount) * 100));
  const storeName = store.name?.trim() || 'Pas2me store';
  const buyerName = customer?.name?.trim() || 'Customer';
  const buyerPhone = formatPhoneDisplay(customer?.whatsapp_number);
  const method =
    logistics?.method ||
    (() => {
      try {
        const addr = order.shipping_address
          ? (JSON.parse(order.shipping_address) as { logistics_method?: string })
          : {};
        return addr.logistics_method || 'walk_in';
      } catch {
        return 'walk_in';
      }
    })();

  const itemLines = cart
    .map((i) => `• ${i.quantity}× ${i.name}`)
    .join('\n');
  const caption = [
    `*PAYMENT RECEIVED*`,
    `Order *${order.order_number}*`,
    `Store: ${storeName}`,
    `Buyer: ${buyerName} (${buyerPhone})`,
    itemLines,
    `Total: *${formatNgn(total)}*`,
    `Paid via ${paidVia}`,
    `Fulfillment: ${fulfillmentLabel(method)}`,
    '',
    'Reply *merchant* to manage this order.',
  ]
    .filter((line) => line !== '')
    .join('\n');

  let pdf: Buffer | null = null;
  try {
    let storeAddress = store.description?.trim() || null;
    if (!storeAddress && store.settings) {
      try {
        const settings = JSON.parse(store.settings) as Record<string, unknown>;
        storeAddress =
          (typeof settings.address === 'string' && settings.address) ||
          (typeof settings.pickup_address === 'string' &&
            settings.pickup_address) ||
          null;
      } catch {
        /* ignore */
      }
    }
    pdf = await buildOrderReceiptPdf(db, {
      orderNumber: order.order_number,
      storeName,
      storeAddress,
      storePhone: store.whatsapp_number,
      buyerName,
      buyerPhone,
      cart,
      itemsTotal,
      deliveryFeeKobo,
      total,
      fulfillment: fulfillmentLabel(method),
      paidVia,
      audience: 'vendor',
      issuedAt: new Date(),
    });
  } catch (err) {
    console.error('[order] vendor PDF failed', err);
  }

  const fileName = `Pas2me-receipt-${order.order_number}.pdf`;
  let sent = 0;
  for (const phone of phones) {
    if (pdf) {
      const result = await sendDocumentToPhone(db, phone, pdf, {
        fileName,
        caption,
      });
      if (result.ok) {
        sent += 1;
        console.log(
          `[order] vendor payment notice sent ${order.order_number} → ${phone} (${result.jid})`
        );
        continue;
      }
    }
    const { sendText } = await import('./whatsapp');
    const { resolveOutboundChatIds } = await import('./whatsapp');
    const targets = await resolveOutboundChatIds(db, phone);
    for (const chatId of targets) {
      try {
        await sendText(chatId, caption);
        sent += 1;
        console.log(
          `[order] vendor payment text sent ${order.order_number} → ${chatId}`
        );
        break;
      } catch (err) {
        console.warn(`[order] vendor text failed ${chatId}`, err);
      }
    }
  }

  if (sent === 0) {
    console.warn(
      `[order] vendor payment notice not delivered for ${order.order_number} (${phones.length} phone(s) on file)`
    );
  }
}

export type { Kobo };
