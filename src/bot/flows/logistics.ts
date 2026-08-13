import type { Db } from '../../db/client';
import {
  getContext,
  getOrCreateConversation,
  updateConversation,
} from '../../db/repos';
import { formatNgn, kobo, nairaToKobo } from '../../domain/money';
import { sendMenuMessage, sendText } from '../../services/whatsapp';
import {
  getDeliveryRate,
  listPaidReadyByLga,
  normalizeLga,
  requestWaybillForOrders,
  setStorePickupLocation,
  splitBatch,
  suggestCabmeEstimate,
  syncWaybillFromCabme,
  upsertDeliveryRate,
} from '../../services/logistics';
import { linkCabmeAccount } from '../../services/cabmeLink';
import type { ResolvedIdentity } from '../identity';
import { resolveCommand, type MenuOption } from '../command';

const MERCH_LOGISTICS_MENU: MenuOption[] = [
  { id: 'merch_rates', label: 'Delivery rates (LGA)' },
  { id: 'merch_set_pickup', label: 'Set pickup location' },
  { id: 'merch_link_cabme', label: 'Link Cabme account' },
  { id: 'merch_waybill', label: 'Request waybill' },
  { id: 'merch_batch', label: 'Batch by LGA' },
  { id: 'merch_sync_waybill', label: 'Sync Cabme status' },
  { id: 'merch_home', label: 'Merchant menu' },
];

function remember(db: Db, phone: string, options: MenuOption[]): void {
  const conv = getOrCreateConversation(db, phone);
  const ctx = getContext(conv);
  updateConversation(db, phone, {
    context_json: JSON.stringify({ ...ctx, last_menu: options }),
  });
}

export async function sendMerchantLogisticsMenu(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  remember(db, identity.phone, MERCH_LOGISTICS_MENU);
  updateConversation(db, identity.phone, { state: 'merch_logistics_menu' });
  await sendMenuMessage(
    chatId,
    `*Logistics*\nSet LGA rates from Cabme estimates, batch same-LGA paid orders, and request dispatch riders.`,
    MERCH_LOGISTICS_MENU.map((o) => ({ id: o.id, text: o.label }))
  );
}

export async function handleMerchantLogisticsMessage(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  text: string,
  interactiveId: string | undefined,
  storeId: string,
  location?: { latitude: number; longitude: number; description?: string }
): Promise<boolean> {
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  const lastMenu = Array.isArray(ctx.last_menu)
    ? (ctx.last_menu as MenuOption[])
    : [];
  const cmd = resolveCommand({
    text,
    interactiveId,
    lastMenu,
  });
  const lower = text.trim().toLowerCase();

  if (cmd === 'merch_logistics' || lower === 'logistics' || lower === 'waybill') {
    await sendMerchantLogisticsMenu(db, identity, chatId);
    return true;
  }

  // Only claim logistics submenu commands / states — never swallow other merch_* menu picks
  const logisticsCmds = new Set([
    'merch_rates',
    'merch_set_pickup',
    'merch_link_cabme',
    'merch_waybill',
    'merch_batch',
    'merch_sync_waybill',
  ]);
  const inLogisticsState =
    conv.state === 'merch_logistics_menu' ||
    conv.state === 'merch_set_pickup' ||
    conv.state === 'merch_set_pickup_confirm' ||
    conv.state === 'merch_rate_lga' ||
    conv.state === 'merch_waybill_order' ||
    conv.state === 'merch_batch_lga' ||
    conv.state === 'merch_batch_confirm' ||
    conv.state === 'merch_sync_waybill';

  if (cmd === 'merch_home' && inLogisticsState) {
    return false;
  }

  if (!inLogisticsState && !logisticsCmds.has(cmd)) {
    return false;
  }

  if (conv.state === 'merch_logistics_menu' || logisticsCmds.has(cmd)) {
    if (cmd === 'merch_home') return false;

    if (cmd === 'merch_rates') {
      updateConversation(db, identity.phone, {
        state: 'merch_rate_lga',
      });
      await sendText(
        chatId,
        'Set a delivery rate.\nSend: <LGA> <fee_naira> [optional_distance_km_for_Cabme_estimate]\nExample: `ikeja 2500 8`'
      );
      return true;
    }

    if (cmd === 'merch_set_pickup' || lower === 'set pickup') {
      updateConversation(db, identity.phone, { state: 'merch_set_pickup' });
      await sendText(
        chatId,
        'Share this store’s *pickup location* via WhatsApp:\nAttach → Location → Send pin for where riders should collect parcels.'
      );
      return true;
    }

    if (cmd === 'merch_link_cabme' || lower === 'link cabme') {
      if (!identity.user) return true;
      const result = await linkCabmeAccount(db, identity.user.id, identity.phone);
      await sendText(
        chatId,
        result.status === 'linked'
          ? `Cabme linked ✅ (id ${result.cabmeUserId}).`
          : result.message
      );
      return true;
    }

    if (cmd === 'merch_waybill') {
      updateConversation(db, identity.phone, {
        state: 'merch_waybill_order',
      });
      await sendText(
        chatId,
        'Request waybill for one paid order.\nSend the *order number* (e.g. P2MABC123).'
      );
      return true;
    }

    if (cmd === 'merch_batch') {
      updateConversation(db, identity.phone, {
        state: 'merch_batch_lga',
      });
      await sendText(
        chatId,
        'Batch paid orders by dropoff LGA.\nSend the LGA name (e.g. `surulere`).'
      );
      return true;
    }

    if (cmd === 'merch_sync_waybill') {
      updateConversation(db, identity.phone, {
        state: 'merch_sync_waybill',
      });
      await sendText(chatId, 'Send waybill id to sync from Cabme (starts with wbl).');
      return true;
    }

    // In logistics menu but unrecognized — re-show logistics help
    if (conv.state === 'merch_logistics_menu') {
      await sendText(
        chatId,
        'Pick a logistics option by *number* or name, or reply *menu* for the merchant home.'
      );
      await sendMerchantLogisticsMenu(db, identity, chatId);
      return true;
    }
  }

  if (conv.state === 'merch_set_pickup') {
    if (!location) {
      await sendText(
        chatId,
        'Waiting for a WhatsApp location pin.\nAttach → Location → Send location.'
      );
      return true;
    }
    const conv2 = getOrCreateConversation(db, identity.phone);
    const ctx2 = getContext(conv2);
    updateConversation(db, identity.phone, {
      state: 'merch_set_pickup_confirm',
      context_json: JSON.stringify({
        ...ctx2,
        pending_pickup_lat: location.latitude,
        pending_pickup_lng: location.longitude,
        pending_pickup_address: location.description ?? null,
      }),
    });
    await sendText(
      chatId,
      `*Are you sure?* Save pickup pin ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}?\nReply *YES* or *NO*.`
    );
    return true;
  }

  if (conv.state === 'merch_set_pickup_confirm') {
    if (lower === 'no' || lower === 'n') {
      updateConversation(db, identity.phone, { state: 'merch_logistics_menu' });
      await sendText(chatId, 'Pickup update cancelled.');
      await sendMerchantLogisticsMenu(db, identity, chatId);
      return true;
    }
    if (lower !== 'yes' && lower !== 'y') {
      await sendText(chatId, 'Reply *YES* or *NO*.');
      return true;
    }
    const lat = Number(ctx.pending_pickup_lat);
    const lng = Number(ctx.pending_pickup_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      await sendText(chatId, 'Session expired. Set pickup again.');
      updateConversation(db, identity.phone, { state: 'merch_logistics_menu' });
      return true;
    }
    setStorePickupLocation(db, storeId, {
      lat,
      lng,
      address:
        ctx.pending_pickup_address == null
          ? undefined
          : String(ctx.pending_pickup_address),
    });
    updateConversation(db, identity.phone, { state: 'merch_logistics_menu' });
    await sendText(
      chatId,
      `Pickup location saved ✅\n${lat.toFixed(5)}, ${lng.toFixed(5)}`
    );
    await sendMerchantLogisticsMenu(db, identity, chatId);
    return true;
  }

  if (conv.state === 'merch_rate_lga') {
    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
      await sendText(chatId, 'Format: <LGA> <fee_naira> [distance_km]');
      return true;
    }
    const lga = parts.slice(0, -1).join(' ');
    // If last is number and second-last is number, fee is second-last
    let feeStr = parts[parts.length - 1]!;
    let distanceKm: number | undefined;
    let lgaName = parts.slice(0, -1).join(' ');
    if (parts.length >= 3 && !Number.isNaN(Number(parts[parts.length - 1]))) {
      const maybeFee = Number(parts[parts.length - 2]);
      const maybeDist = Number(parts[parts.length - 1]);
      if (!Number.isNaN(maybeFee) && maybeDist > 0) {
        feeStr = parts[parts.length - 2]!;
        distanceKm = maybeDist;
        lgaName = parts.slice(0, -2).join(' ');
      }
    }
    void lga;
    try {
      const fee = nairaToKobo(feeStr);
      let estimate: number | undefined;
      let estimateNote = '';
      if (distanceKm) {
        const sug = await suggestCabmeEstimate(distanceKm);
        if (sug.ok) {
          estimate = sug.amountKobo;
          estimateNote = `\n${sug.message}`;
        }
      }
      upsertDeliveryRate(db, storeId, lgaName, fee, estimate);
      updateConversation(db, identity.phone, { state: 'merch_logistics_menu' });
      await sendText(
        chatId,
        `Saved rate for *${normalizeLga(lgaName)}*: ${formatNgn(fee)}.${estimateNote}`
      );
      await sendMerchantLogisticsMenu(db, identity, chatId);
    } catch {
      await sendText(chatId, 'Invalid fee. Example: ikeja 2500');
    }
    return true;
  }

  if (conv.state === 'merch_waybill_order') {
    const orderNumber = text.trim();
    const order = db
      .prepare(
        `SELECT o.id, o.payment_status, ol.logistics_status, ol.method
         FROM orders o
         LEFT JOIN order_logistics ol ON ol.order_id = o.id
         WHERE o.store_id = ? AND o.order_number = ?`
      )
      .get(storeId, orderNumber) as
      | {
          id: string;
          payment_status: string;
          logistics_status: string | null;
          method: string | null;
        }
      | undefined;
    if (!order) {
      await sendText(chatId, 'Order not found at this location.');
      return true;
    }
    if (order.payment_status !== 'paid') {
      await sendText(chatId, 'Only paid orders can be waybilled.');
      return true;
    }
    if (order.method === 'walk_in') {
      await sendText(chatId, 'This order is walk-in pickup — no waybill needed.');
      return true;
    }
    if (!identity.user) return true;

    const result = await requestWaybillForOrders(db, {
      storeId,
      orderIds: [order.id],
      requesterRole: 'vendor',
      requesterUserId: identity.user.id,
    });
    updateConversation(db, identity.phone, { state: 'merch_logistics_menu' });
    await sendText(chatId, result.message);
    return true;
  }

  if (conv.state === 'merch_batch_lga') {
    const lga = normalizeLga(text);
    const rows = listPaidReadyByLga(db, storeId, lga);
    if (rows.length === 0) {
      await sendText(
        chatId,
        `No paid, ready orders for LGA *${lga}*.`
      );
      return true;
    }
    if (!identity.user) return true;

    const ctxNext = {
      ...getContext(conv),
      pending_batch_lga: lga,
      pending_batch_orders: rows.map((r) => r.order_id),
    };
    updateConversation(db, identity.phone, {
      state: 'merch_batch_confirm',
      context_json: JSON.stringify(ctxNext),
    });
    const listing = rows
      .map((r, i) => `${i + 1}. ${r.order_number}`)
      .join('\n');
    await sendText(
      chatId,
      `Found *${rows.length}* paid order(s) for *${lga}*:\n${listing}\n\nReply *YES* to request one Cabme dispatch for the batch, or *NO* to cancel.`
    );
    return true;
  }

  if (conv.state === 'merch_batch_confirm') {
    if (lower === 'no') {
      updateConversation(db, identity.phone, { state: 'merch_logistics_menu' });
      await sendText(chatId, 'Batch cancelled.');
      return true;
    }
    if (lower !== 'yes') {
      await sendText(chatId, 'Reply *YES* or *NO*.');
      return true;
    }
    if (!identity.user) return true;
    const orderIds = Array.isArray(ctx.pending_batch_orders)
      ? (ctx.pending_batch_orders as string[])
      : [];
    const result = await requestWaybillForOrders(db, {
      storeId,
      orderIds,
      requesterRole: 'vendor',
      requesterUserId: identity.user.id,
      batch: true,
    });
    updateConversation(db, identity.phone, {
      state: 'merch_logistics_menu',
      context_json: JSON.stringify({
        ...ctx,
        pending_batch_orders: undefined,
        pending_batch_lga: undefined,
      }),
    });
    await sendText(
      chatId,
      result.ok
        ? `${result.message}\nIf the rider declines multi-drop, reply *split <batch_id>* or re-request singles.`
        : result.message
    );
    return true;
  }

  if (conv.state === 'merch_sync_waybill') {
    const waybillId = text.trim();
    const synced = await syncWaybillFromCabme(db, waybillId);
    updateConversation(db, identity.phone, { state: 'merch_logistics_menu' });
    await sendText(
      chatId,
      synced.ok
        ? `Synced. Status: *${synced.status.replace(/_/g, ' ')}*`
        : synced.message
    );
    return true;
  }

  if (lower.startsWith('split ')) {
    const batchId = text.trim().slice(6).trim();
    if (!identity.user) return true;
    const result = await splitBatch(db, batchId, identity.user.id);
    await sendText(chatId, result.message);
    return true;
  }

  return false;
}

/** Buyer requests dispatch for their paid dispatch_pickup order */
export async function handleBuyerWaybillRequest(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  orderNumber: string
): Promise<void> {
  if (!identity.user) {
    await sendText(chatId, 'Registered account required.');
    return;
  }
  const order = db
    .prepare(
      `SELECT o.id, o.store_id, o.payment_status, ol.method, ol.logistics_status
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       LEFT JOIN order_logistics ol ON ol.order_id = o.id
       WHERE o.order_number = ? AND c.whatsapp_number = ?`
    )
    .get(orderNumber, identity.phone) as
    | {
        id: string;
        store_id: string;
        payment_status: string;
        method: string | null;
        logistics_status: string | null;
      }
    | undefined;

  if (!order) {
    await sendText(chatId, 'Order not found.');
    return;
  }
  if (order.payment_status !== 'paid') {
    await sendText(chatId, 'Pay for the order first, then request dispatch.');
    return;
  }
  if (order.method !== 'dispatch_pickup') {
    await sendText(
      chatId,
      'This order is not set to *Dispatch pickup*. Vendor delivery is handled by the store.'
    );
    return;
  }

  const result = await requestWaybillForOrders(db, {
    storeId: order.store_id,
    orderIds: [order.id],
    requesterRole: 'buyer',
    requesterUserId: identity.user.id,
  });
  await sendText(chatId, result.message);
}

export function lookupVendorDeliveryFee(
  db: Db,
  storeId: string,
  lga: string
): number {
  return getDeliveryRate(db, storeId, lga)?.fee_kobo ?? 0;
}

export { kobo };
