import type { Db } from '../db/client';
import { getEnv } from '../config/env';
import { newId, nowIso, phoneToWahaChatId } from '../domain/ids';
import type { Kobo } from '../domain/money';
import { formatNgn, kobo } from '../domain/money';
import {
  createCabmeParcel,
  estimateCabmeFare,
  getCabmeParcelDetail,
  haversineKm,
  mapCabmeStatusToLogistics,
} from './cabme';
import { requireCabmeLink, cabmeRegisterPrompt } from './cabmeLink';
import { applyLedgerEntry, holdFunds, releaseHold } from './wallet';
import { sendText } from './whatsapp';

export type LogisticsMethod = 'vendor_delivery' | 'dispatch_pickup' | 'walk_in';

export type LogisticsStatus =
  | 'logistics_selected'
  | 'awaiting_payment'
  | 'paid_ready'
  | 'waybill_draft'
  | 'batched'
  | 'dispatch_requested'
  | 'rider_assigned'
  | 'en_route_to_pickup'
  | 'picked_up'
  | 'en_route_to_dropoff'
  | 'delivered'
  | 'closed'
  | 'dispatch_failed'
  | 'returned'
  | 'cancelled';

export interface OrderLogisticsRow {
  id: string;
  order_id: string;
  store_id: string;
  method: LogisticsMethod;
  logistics_status: LogisticsStatus;
  dropoff_lga: string | null;
  dropoff_address: string | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  pickup_address: string | null;
  pickup_lat: number | null;
  pickup_lng: number | null;
  delivery_fee_kobo: number;
  fee_payer: 'buyer' | 'vendor' | 'none';
  fee_hold_status: 'none' | 'held' | 'released' | 'refunded';
  waybill_id: string | null;
  batch_id: string | null;
}

export interface StorePickupLocation {
  lat: number;
  lng: number;
  address?: string;
}

export function getStorePickupLocation(
  db: Db,
  storeId: string
): StorePickupLocation | undefined {
  const store = db
    .prepare(`SELECT settings FROM stores WHERE id = ?`)
    .get(storeId) as { settings: string | null } | undefined;
  if (!store?.settings) return undefined;
  try {
    const settings = JSON.parse(store.settings) as Record<string, unknown>;
    const lat = Number(settings.pickup_lat);
    const lng = Number(settings.pickup_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
    return {
      lat,
      lng,
      address:
        typeof settings.pickup_address === 'string'
          ? settings.pickup_address
          : undefined,
    };
  } catch {
    return undefined;
  }
}

export function setStorePickupLocation(
  db: Db,
  storeId: string,
  loc: StorePickupLocation
): void {
  const store = db
    .prepare(`SELECT settings FROM stores WHERE id = ?`)
    .get(storeId) as { settings: string | null } | undefined;
  let settings: Record<string, unknown> = {};
  if (store?.settings) {
    try {
      settings = JSON.parse(store.settings) as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }
  settings.pickup_lat = loc.lat;
  settings.pickup_lng = loc.lng;
  if (loc.address) settings.pickup_address = loc.address;
  db.prepare(
    `UPDATE stores SET settings = ?, updated_at = ? WHERE id = ?`
  ).run(JSON.stringify(settings), nowIso(), storeId);
}

export function normalizeLga(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function logisticsMethodLabel(method: LogisticsMethod): string {
  switch (method) {
    case 'vendor_delivery':
      return 'Vendor delivery';
    case 'dispatch_pickup':
      return 'Dispatch pickup';
    case 'walk_in':
      return 'I will pick it up';
  }
}

export function getDeliveryRate(
  db: Db,
  storeId: string,
  lga: string
): { fee_kobo: number; cabme_estimate_kobo: number | null } | undefined {
  return db
    .prepare(
      `SELECT fee_kobo, cabme_estimate_kobo FROM store_delivery_rates
       WHERE store_id = ? AND lga = ? AND is_active = 1`
    )
    .get(storeId, normalizeLga(lga)) as
    | { fee_kobo: number; cabme_estimate_kobo: number | null }
    | undefined;
}

export function upsertDeliveryRate(
  db: Db,
  storeId: string,
  lga: string,
  feeKobo: Kobo,
  cabmeEstimateKobo?: number
): void {
  const id = newId('sdr');
  db.prepare(
    `INSERT INTO store_delivery_rates
      (id, store_id, lga, fee_kobo, cabme_estimate_kobo, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(store_id, lga) DO UPDATE SET
       fee_kobo = excluded.fee_kobo,
       cabme_estimate_kobo = COALESCE(excluded.cabme_estimate_kobo, store_delivery_rates.cabme_estimate_kobo),
       is_active = 1,
       updated_at = excluded.updated_at`
  ).run(
    id,
    storeId,
    normalizeLga(lga),
    feeKobo,
    cabmeEstimateKobo ?? null,
    nowIso(),
    nowIso()
  );
}

export function getOrderLogistics(
  db: Db,
  orderId: string
): OrderLogisticsRow | undefined {
  return db
    .prepare(`SELECT * FROM order_logistics WHERE order_id = ?`)
    .get(orderId) as OrderLogisticsRow | undefined;
}

export function createOrderLogistics(
  db: Db,
  params: {
    orderId: string;
    storeId: string;
    method: LogisticsMethod;
    dropoffLga?: string;
    dropoffAddress?: string;
    dropoffLat?: number;
    dropoffLng?: number;
    pickupAddress?: string;
    pickupLat?: number;
    pickupLng?: number;
    deliveryFeeKobo: number;
    feePayer: 'buyer' | 'vendor' | 'none';
    status?: LogisticsStatus;
  }
): OrderLogisticsRow {
  const id = newId('olg');
  const status =
    params.status ??
    (params.method === 'walk_in' ? 'closed' : 'logistics_selected');
  db.prepare(
    `INSERT INTO order_logistics
      (id, order_id, store_id, method, logistics_status, dropoff_lga, dropoff_address,
       dropoff_lat, dropoff_lng, pickup_address, pickup_lat, pickup_lng,
       delivery_fee_kobo, fee_payer, fee_hold_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?)`
  ).run(
    id,
    params.orderId,
    params.storeId,
    params.method,
    status,
    params.dropoffLga ? normalizeLga(params.dropoffLga) : null,
    params.dropoffAddress ?? null,
    params.dropoffLat ?? null,
    params.dropoffLng ?? null,
    params.pickupAddress ?? null,
    params.pickupLat ?? null,
    params.pickupLng ?? null,
    params.deliveryFeeKobo,
    params.feePayer,
    nowIso(),
    nowIso()
  );
  return getOrderLogistics(db, params.orderId)!;
}

export function markLogisticsPaidReady(db: Db, orderId: string): void {
  db.prepare(
    `UPDATE order_logistics
     SET logistics_status = CASE
           WHEN method = 'walk_in' THEN 'closed'
           ELSE 'paid_ready'
         END,
         updated_at = ?
     WHERE order_id = ?`
  ).run(nowIso(), orderId);
}

/** Lock delivery fee on recipient wallet until goods are delivered. */
export function lockDeliveryFee(
  db: Db,
  params: {
    payerUserId: string;
    recipientUserId: string;
    amount: Kobo;
    orderId: string;
    actorPhone?: string;
  }
): void {
  if (Number(params.amount) <= 0) return;

  // Buyer already paid (wallet debit / Monnify). Credit vendor as locked funds.
  applyLedgerEntry(db, {
    userId: params.recipientUserId,
    direction: 'credit',
    amount: params.amount,
    type: 'delivery_fee',
    idempotencyKey: `delivery_fee_credit_${params.orderId}`,
    orderId: params.orderId,
    actorPhone: params.actorPhone,
    metadata: { locked: true },
  });
  holdFunds(db, {
    userId: params.recipientUserId,
    amount: params.amount,
    idempotencyKey: `delivery_fee_hold_${params.orderId}`,
    orderId: params.orderId,
  });

  db.prepare(
    `UPDATE order_logistics SET fee_hold_status = 'held', updated_at = ? WHERE order_id = ?`
  ).run(nowIso(), params.orderId);
}

export function unlockDeliveryFeeOnDelivered(db: Db, orderId: string): void {
  const logistics = getOrderLogistics(db, orderId);
  if (!logistics || logistics.fee_hold_status !== 'held') return;

  const store = db
    .prepare(`SELECT user_id FROM stores WHERE id = ?`)
    .get(logistics.store_id) as { user_id: string } | undefined;
  if (!store) return;

  if (logistics.delivery_fee_kobo > 0) {
    releaseHold(db, {
      userId: store.user_id,
      amount: kobo(logistics.delivery_fee_kobo),
      idempotencyKey: `delivery_fee_release_${orderId}`,
      orderId,
    });
  }

  db.prepare(
    `UPDATE order_logistics
     SET fee_hold_status = 'released', logistics_status = 'delivered', updated_at = ?
     WHERE order_id = ?`
  ).run(nowIso(), orderId);

  db.prepare(
    `UPDATE orders SET status = 'delivered', updated_at = ? WHERE id = ?`
  ).run(nowIso(), orderId);
}

export async function suggestCabmeEstimate(
  distanceKm: number
): Promise<{ ok: boolean; amountKobo: number; message: string }> {
  const est = await estimateCabmeFare(distanceKm);
  if (!est.ok) return { ok: false, amountKobo: 0, message: est.message };
  return {
    ok: true,
    amountKobo: Math.round(est.amountNaira * 100),
    message: `Cabme estimate ~${formatNgn(kobo(Math.round(est.amountNaira * 100)))} for ${distanceKm}km`,
  };
}

export function listPaidReadyByLga(
  db: Db,
  storeId: string,
  lga: string
): Array<{ order_id: string; order_number: string; dropoff_address: string | null }> {
  return db
    .prepare(
      `SELECT ol.order_id, o.order_number, ol.dropoff_address
       FROM order_logistics ol
       JOIN orders o ON o.id = ol.order_id
       WHERE ol.store_id = ?
         AND ol.dropoff_lga = ?
         AND o.payment_status = 'paid'
         AND ol.method IN ('vendor_delivery', 'dispatch_pickup')
         AND ol.logistics_status IN ('paid_ready', 'waybill_draft')
       ORDER BY o.created_at ASC`
    )
    .all(storeId, normalizeLga(lga)) as Array<{
    order_id: string;
    order_number: string;
    dropoff_address: string | null;
  }>;
}

export async function requestWaybillForOrders(
  db: Db,
  params: {
    storeId: string;
    orderIds: string[];
    requesterRole: 'vendor' | 'buyer';
    requesterUserId: string;
    batch?: boolean;
  }
): Promise<{ ok: boolean; waybillId?: string; message: string }> {
  if (params.orderIds.length === 0) {
    return { ok: false, message: 'No orders selected' };
  }

  const env = getEnv();
  if (!env.CABME_PAYMENT_METHOD_ID || !env.CABME_PARCEL_CATEGORY_ID) {
    return {
      ok: false,
      message:
        'Cabme dispatch is not fully configured (CABME_PAYMENT_METHOD_ID / CABME_PARCEL_CATEGORY_ID).',
    };
  }

  const cabmeLink = await requireCabmeLink(
    db,
    params.requesterUserId,
    (
      db
        .prepare(`SELECT phone FROM users WHERE id = ?`)
        .get(params.requesterUserId) as { phone: string | null } | undefined
    )?.phone ??
      (
        db
          .prepare(
            `SELECT whatsapp_number AS phone FROM customers c
             JOIN orders o ON o.customer_id = c.id WHERE o.id = ?`
          )
          .get(params.orderIds[0]!) as { phone: string | null } | undefined
      )?.phone ??
      ''
  );
  if (cabmeLink.status !== 'linked') {
    return {
      ok: false,
      message:
        cabmeLink.status === 'needs_registration'
          ? cabmeLink.message
          : cabmeLink.message || cabmeRegisterPrompt(),
    };
  }

  const logisticsRows = params.orderIds.map((id) => getOrderLogistics(db, id));
  if (logisticsRows.some((r) => !r)) {
    return { ok: false, message: 'One or more orders have no logistics record' };
  }

  for (const row of logisticsRows) {
    const paid = db
      .prepare(`SELECT payment_status FROM orders WHERE id = ?`)
      .get(row!.order_id) as { payment_status: string } | undefined;
    if (paid?.payment_status !== 'paid') {
      return { ok: false, message: 'All logistics waybills require paid orders' };
    }
  }

  const lgas = new Set(logisticsRows.map((r) => r!.dropoff_lga));
  if (lgas.size !== 1 || ![...lgas][0]) {
    return { ok: false, message: 'Batch waybills must share the same dropoff LGA' };
  }
  const lga = [...lgas][0]!;

  const store = db
    .prepare(`SELECT * FROM stores WHERE id = ?`)
    .get(params.storeId) as
    | { id: string; user_id: string; name: string; settings: string | null }
    | undefined;
  if (!store) return { ok: false, message: 'Store not found' };

  const firstOrder = db
    .prepare(
      `SELECT o.*, c.whatsapp_number, c.name AS customer_name
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.id = ?`
    )
    .get(params.orderIds[0]!) as
    | {
        id: string;
        order_number: string;
        whatsapp_number: string | null;
        customer_name: string | null;
      }
    | undefined;

  const primary = logisticsRows[0]!;
  const feePayer =
    primary.method === 'dispatch_pickup' ? 'buyer' : 'vendor';
  const amountKobo = logisticsRows.reduce(
    (sum, r) => sum + (r?.delivery_fee_kobo ?? 0),
    0
  );

  let batchId: string | null = null;
  if (params.batch && params.orderIds.length > 1) {
    batchId = newId('wbb');
    db.prepare(
      `INSERT INTO waybill_batches
        (id, store_id, dropoff_lga, status, requested_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, 'requested', ?, ?, ?)`
    ).run(batchId, params.storeId, lga, params.requesterUserId, nowIso(), nowIso());
  }

  const waybillId = newId('wbl');
  const storePickup = getStorePickupLocation(db, params.storeId);
  if (!storePickup) {
    return {
      ok: false,
      message:
        'Store pickup location missing. Merchant must open *Logistics* and reply *set pickup*, then share WhatsApp location.',
    };
  }

  const dropLat = primary.dropoff_lat;
  const dropLng = primary.dropoff_lng;
  if (
    dropLat === null ||
    dropLng === null ||
    !Number.isFinite(Number(dropLat)) ||
    !Number.isFinite(Number(dropLng))
  ) {
    return {
      ok: false,
      message:
        'Buyer dropoff location missing. Customer must share WhatsApp location during checkout.',
    };
  }

  const pickupAddress =
    storePickup.address || primary.pickup_address || `${store.name} pickup`;
  const dropoffAddress =
    logisticsRows
      .map((r) => r!.dropoff_address)
      .filter(Boolean)
      .join(' | ') || `LGA: ${lga}`;

  const owner = db
    .prepare(`SELECT first_name, last_name, phone FROM users WHERE id = ?`)
    .get(store.user_id) as
    | { first_name: string; last_name: string; phone: string | null }
    | undefined;

  const senderName = owner
    ? `${owner.first_name} ${owner.last_name}`.trim()
    : store.name;
  const senderPhone = owner?.phone ?? '';
  const receiverName = firstOrder?.customer_name ?? 'Customer';
  const receiverPhone = firstOrder?.whatsapp_number ?? '';

  const distanceKm = Math.max(
    0.5,
    Number(
      haversineKm(
        storePickup.lat,
        storePickup.lng,
        Number(dropLat),
        Number(dropLng)
      ).toFixed(2)
    )
  );

  const cabme = await createCabmeParcel({
    userId: cabmeLink.cabmeUserId,
    lat1: storePickup.lat,
    lng1: storePickup.lng,
    lat2: Number(dropLat),
    lng2: Number(dropLng),
    sourceCity: storePickup.address?.split(',')[0]?.trim() || 'Pickup',
    destinationCity: lga,
    distance: distanceKm,
    paymentMethodId: env.CABME_PAYMENT_METHOD_ID!,
    sourceAddress: pickupAddress,
    destinationAddress: dropoffAddress,
    senderName,
    senderPhone,
    receiverName,
    receiverPhone,
    note: `Pas2me waybill ${waybillId} orders=${params.orderIds.join(',')}`,
    parcelType: env.CABME_PARCEL_CATEGORY_ID!,
    amount: amountKobo / 100,
  });

  if (!cabme.ok || !cabme.parcelId) {
    return { ok: false, message: cabme.message };
  }

  db.prepare(
    `INSERT INTO waybills
      (id, store_id, batch_id, order_id, requester_role, requester_user_id, dropoff_lga,
       status, cabme_parcel_id, cabme_status, amount_kobo, fee_payer,
       sender_name, sender_phone, receiver_name, receiver_phone,
       pickup_address, dropoff_address, raw_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    waybillId,
    params.storeId,
    batchId,
    params.orderIds[0]!,
    params.requesterRole,
    params.requesterUserId,
    lga,
    cabme.parcelId,
    cabme.status ?? 'new',
    amountKobo,
    feePayer,
    senderName,
    senderPhone,
    receiverName,
    receiverPhone,
    pickupAddress,
    dropoffAddress,
    JSON.stringify(cabme.raw),
    nowIso(),
    nowIso()
  );

  for (const orderId of params.orderIds) {
    db.prepare(
      `INSERT OR IGNORE INTO waybill_orders (waybill_id, order_id, created_at) VALUES (?, ?, ?)`
    ).run(waybillId, orderId, nowIso());
    db.prepare(
      `UPDATE order_logistics
       SET logistics_status = 'dispatch_requested',
           waybill_id = ?,
           batch_id = COALESCE(?, batch_id),
           updated_at = ?
       WHERE order_id = ?`
    ).run(waybillId, batchId, nowIso(), orderId);
  }

  await notifyLogisticsParties(db, {
    orderIds: params.orderIds,
    eventType: 'dispatch_requested',
    buyerMessage: (orderNumber) =>
      `Your order *${orderNumber}* is out for dispatch.\nA rider has been requested for dropoff LGA *${lga}*.\nWe will update you as it moves.`,
    vendorMessage: (orderNumber) =>
      `Waybill requested for order *${orderNumber}* (LGA *${lga}*).\nCabme parcel #${cabme.parcelId}.`,
  });

  return {
    ok: true,
    waybillId,
    message: `Waybill created. Cabme parcel #${cabme.parcelId}`,
  };
}

export async function syncWaybillFromCabme(
  db: Db,
  waybillId: string
): Promise<{ ok: boolean; status: string; message: string }> {
  const waybill = db
    .prepare(`SELECT * FROM waybills WHERE id = ?`)
    .get(waybillId) as
    | {
        id: string;
        cabme_parcel_id: string | null;
        status: string;
      }
    | undefined;
  if (!waybill?.cabme_parcel_id) {
    return { ok: false, status: 'unknown', message: 'No Cabme parcel linked' };
  }

  const detail = await getCabmeParcelDetail(waybill.cabme_parcel_id);
  if (!detail.ok) return { ok: false, status: waybill.status, message: detail.message };

  const logisticsStatus = mapCabmeStatusToLogistics(detail.status ?? '');
  const waybillStatus =
    logisticsStatus === 'delivered'
      ? 'delivered'
      : logisticsStatus === 'cancelled'
        ? 'cancelled'
        : logisticsStatus === 'dispatch_failed'
          ? 'failed'
          : logisticsStatus === 'rider_assigned'
            ? 'rider_assigned'
            : logisticsStatus === 'en_route_to_dropoff'
              ? 'en_route_to_dropoff'
              : logisticsStatus === 'picked_up'
                ? 'picked_up'
                : 'requested';

  db.prepare(
    `UPDATE waybills SET status = ?, cabme_status = ?, updated_at = ? WHERE id = ?`
  ).run(waybillStatus, detail.status ?? null, nowIso(), waybillId);

  const linked = db
    .prepare(`SELECT order_id FROM waybill_orders WHERE waybill_id = ?`)
    .all(waybillId) as Array<{ order_id: string }>;

  for (const { order_id } of linked) {
    db.prepare(
      `UPDATE order_logistics SET logistics_status = ?, updated_at = ? WHERE order_id = ?`
    ).run(logisticsStatus, nowIso(), order_id);

    if (logisticsStatus === 'delivered') {
      unlockDeliveryFeeOnDelivered(db, order_id);
    }
  }

  if (linked.length) {
    await notifyLogisticsParties(db, {
      orderIds: linked.map((l) => l.order_id),
      eventType: logisticsStatus,
      buyerMessage: (orderNumber) =>
        statusBuyerCopy(orderNumber, logisticsStatus),
      vendorMessage: (orderNumber) =>
        statusVendorCopy(orderNumber, logisticsStatus),
    });
  }

  return { ok: true, status: logisticsStatus, message: 'Synced' };
}

export async function splitBatch(
  db: Db,
  batchId: string,
  requesterUserId: string
): Promise<{ ok: boolean; message: string }> {
  const batch = db
    .prepare(`SELECT * FROM waybill_batches WHERE id = ?`)
    .get(batchId) as
    | { id: string; store_id: string; dropoff_lga: string; status: string }
    | undefined;
  if (!batch) return { ok: false, message: 'Batch not found' };

  db.prepare(
    `UPDATE waybill_batches SET status = 'split', updated_at = ? WHERE id = ?`
  ).run(nowIso(), batchId);

  const orders = db
    .prepare(
      `SELECT order_id FROM order_logistics WHERE batch_id = ?`
    )
    .all(batchId) as Array<{ order_id: string }>;

  for (const { order_id } of orders) {
    db.prepare(
      `UPDATE order_logistics
       SET logistics_status = 'paid_ready', batch_id = NULL, waybill_id = NULL, updated_at = ?
       WHERE order_id = ?`
    ).run(nowIso(), order_id);
  }

  await notifyLogisticsParties(db, {
    orderIds: orders.map((o) => o.order_id),
    eventType: 'batch_split',
    buyerMessage: (orderNumber) =>
      `Dispatch for order *${orderNumber}* is being re-arranged. You will get a fresh update shortly.`,
    vendorMessage: (orderNumber) =>
      `Batch split for order *${orderNumber}*. You can re-request single waybills.`,
  });

  void requesterUserId;
  return {
    ok: true,
    message: `Batch split. ${orders.length} order(s) returned to paid_ready for re-request.`,
  };
}

function statusBuyerCopy(orderNumber: string, status: string): string {
  switch (status) {
    case 'rider_assigned':
      return `Good news — a dispatch rider has been assigned to order *${orderNumber}*.`;
    case 'en_route_to_pickup':
      return `Rider is heading to pick up order *${orderNumber}*.`;
    case 'picked_up':
      return `Order *${orderNumber}* has been picked up and is on the way to you.`;
    case 'en_route_to_dropoff':
      return `Order *${orderNumber}* is en route to your dropoff.`;
    case 'delivered':
      return `Order *${orderNumber}* has been delivered. Thank you for shopping on Pas2me.`;
    case 'dispatch_failed':
      return `Dispatch for order *${orderNumber}* could not be completed. The store will rearrange delivery.`;
    case 'cancelled':
      return `Dispatch for order *${orderNumber}* was cancelled. Contact the store if you need help.`;
    default:
      return `Order *${orderNumber}* logistics update: *${status.replace(/_/g, ' ')}*.`;
  }
}

function statusVendorCopy(orderNumber: string, status: string): string {
  switch (status) {
    case 'rider_assigned':
      return `Rider assigned for order *${orderNumber}*. Please have the parcel ready for pickup.`;
    case 'picked_up':
      return `Rider picked up order *${orderNumber}*.`;
    case 'delivered':
      return `Order *${orderNumber}* delivered. Locked delivery funds are now available in your wallet.`;
    case 'dispatch_failed':
      return `Dispatch failed for order *${orderNumber}*. Split the batch or re-request a waybill.`;
    default:
      return `Order *${orderNumber}* logistics: *${status.replace(/_/g, ' ')}*.`;
  }
}

async function notifyLogisticsParties(
  db: Db,
  params: {
    orderIds: string[];
    eventType: string;
    buyerMessage: (orderNumber: string) => string;
    vendorMessage: (orderNumber: string) => string;
  }
): Promise<void> {
  for (const orderId of params.orderIds) {
    const row = db
      .prepare(
        `SELECT o.order_number, o.store_id, c.whatsapp_number, s.user_id AS vendor_user_id
         FROM orders o
         LEFT JOIN customers c ON c.id = o.customer_id
         JOIN stores s ON s.id = o.store_id
         WHERE o.id = ?`
      )
      .get(orderId) as
      | {
          order_number: string;
          store_id: string;
          whatsapp_number: string | null;
          vendor_user_id: string;
        }
      | undefined;
    if (!row) continue;

    const buyerMsg = params.buyerMessage(row.order_number);
    const vendorMsg = params.vendorMessage(row.order_number);

    db.prepare(
      `INSERT INTO logistics_events
        (id, order_id, event_type, message, notify_buyer, notify_vendor, created_at)
       VALUES (?, ?, ?, ?, 1, 1, ?)`
    ).run(
      newId('lge'),
      orderId,
      params.eventType,
      JSON.stringify({ buyer: buyerMsg, vendor: vendorMsg }),
      nowIso()
    );

    if (row.whatsapp_number) {
      await sendText(phoneToWahaChatId(row.whatsapp_number), buyerMsg).catch(
        (err) => console.error('buyer notify failed', err)
      );
    }

    const vendor = db
      .prepare(`SELECT phone FROM users WHERE id = ?`)
      .get(row.vendor_user_id) as { phone: string | null } | undefined;
    if (vendor?.phone) {
      await sendText(phoneToWahaChatId(vendor.phone), vendorMsg).catch((err) =>
        console.error('vendor notify failed', err)
      );
    }
  }
}
