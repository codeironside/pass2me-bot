import { Router } from 'express';
import type { Db } from '../db/client';
import { getEnv } from '../config/env';
import {
  acceptInvite,
  verifyInviteTokenSignature,
} from '../bot/flows/invites';
import {
  creditTopupFromWebhook,
  notifyWalletTopup,
} from '../bot/flows/wallet';
import { applyPaidOrderToInventory, findUserByPhone, writeBotAudit } from '../db/repos';
import { kobo, nairaToKobo } from '../domain/money';
import { newId, normalizePhone, nowIso } from '../domain/ids';
import { createOtpChallenge, verifyOtp } from '../services/sms';
import { verifyMonnifyWebhookHash } from '../services/monnify';
import { getReadyWallet } from '../services/monnifyWallet';
import { applyLedgerEntry } from '../services/wallet';
import {
  getOrderLogistics,
  lockDeliveryFee,
  markLogisticsPaidReady,
} from '../services/logistics';
import { getSessionStatus } from '../services/whatsapp';

export function createHttpRouter(db: Db): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'pas2me-bot',
      env: getEnv().NODE_ENV,
      time: nowIso(),
    });
  });

  /** Diagnostics: Baileys connection + QR state */
  router.get('/debug/whatsapp', (_req, res) => {
    const env = getEnv();
    const status = getSessionStatus();
    res.json({
      bot: {
        publicUrl: env.BOT_PUBLIC_URL,
        transport: 'baileys',
        hint: 'Scan QR printed in the bot console (WhatsApp → Linked Devices). Auth persists in WA_AUTH_DIR.',
      },
      env: {
        WA_AUTH_DIR: env.WA_AUTH_DIR,
        WA_INTERACTIVE_MODE: env.WA_INTERACTIVE_MODE,
        WA_JITTER_MIN_MS: env.WA_JITTER_MIN_MS,
        WA_JITTER_MAX_MS: env.WA_JITTER_MAX_MS,
        OUTBOUND_RATE_LIMIT_PER_MINUTE: env.OUTBOUND_RATE_LIMIT_PER_MINUTE,
      },
      session: status,
    });
  });

  // Alias for old bookmarks
  router.get('/debug/waha', (_req, res) => {
    res.redirect(302, '/debug/whatsapp');
  });

  router.get(['/webhooks/monnify', '/webhooks/monnify/payment'], (_req, res) => {
    const env = getEnv();
    res.json({
      ok: true,
      hint: 'Monnify must POST here. Set this URL as Transaction Completion in the Monnify dashboard.',
      urls: {
        payment: `${env.BOT_PUBLIC_URL}/webhooks/monnify/payment`,
        alias: `${env.BOT_PUBLIC_URL}/webhooks/monnify`,
      },
    });
  });

  router.post('/webhooks/monnify/payment', (req, res) => {
    console.log(
      '[Monnify webhook] /payment hit keys=',
      Object.keys((req.body as object) ?? {}),
      'eventType=',
      String((req.body as Record<string, unknown>)?.eventType ?? '?')
    );
    // Ack immediately — Monnify times out slow handlers
    res.json({ ok: true });
    void handleMonnifyPaymentWebhook(db, req.body).catch((err) => {
      console.error('Monnify payment webhook error', err);
    });
  });

  // Alias kept for dashboard configs that point at a single Monnify URL
  router.post('/webhooks/monnify', (req, res) => {
    console.log(
      '[Monnify webhook] /monnify hit keys=',
      Object.keys((req.body as object) ?? {}),
      'eventType=',
      String((req.body as Record<string, unknown>)?.eventType ?? '?')
    );
    res.json({ ok: true });
    void handleMonnifyPaymentWebhook(db, req.body).catch((err) => {
      console.error('Monnify webhook error', err);
    });
  });

  router.post('/webhooks/flutterwave', (req, res) => {
    writeBotAudit(db, {
      action: 'flutterwave_webhook',
      resource_type: 'airtime',
      details: req.body as Record<string, unknown>,
    });
    res.json({ ok: true });
  });

  // Minimal invite onboarding page (not a full web app)
  router.get('/invite/:token', (req, res) => {
    const token = req.params.token;
    const sig = String(req.query.s ?? '');
    if (!verifyInviteTokenSignature(token, sig)) {
      res.status(400).send('Invalid invite link');
      return;
    }
    const invite = db
      .prepare(`SELECT role, status, expires_at FROM staff_invites WHERE token = ?`)
      .get(token) as
      | { role: string; status: string; expires_at: string }
      | undefined;
    if (!invite || invite.status !== 'pending') {
      res.status(400).send('Invite unavailable');
      return;
    }
    res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Pas2me Staff Invite</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;background:#f6f7f9;color:#111}
 card{display:block;background:#fff;border-radius:12px;padding:24px;box-shadow:0 8px 24px rgba(0,0,0,.06)}
 input,button{width:100%;padding:12px;margin:8px 0;border-radius:8px;border:1px solid #ddd;font-size:16px}
 button{background:#0b6e4f;color:#fff;border:none;font-weight:600}
</style></head><body>
<card>
<h1>Join Pas2me staff</h1>
<p>Role: <strong>${invite.role}</strong></p>
<p>Enter the phone that will use WhatsApp, request SMS code, then verify.</p>
<form method="POST" action="/invite/${token}/request-otp?s=${encodeURIComponent(sig)}">
  <input name="phone" placeholder="0803..." required />
  <button type="submit">Send SMS code</button>
</form>
<form method="POST" action="/invite/${token}/accept?s=${encodeURIComponent(sig)}">
  <input name="phone" placeholder="Same phone" required />
  <input name="code" placeholder="6-digit code" required />
  <button type="submit">Complete onboarding</button>
</form>
</card>
</body></html>`);
  });

  router.post('/invite/:token/request-otp', async (req, res) => {
    const token = req.params.token;
    const sig = String(req.query.s ?? '');
    if (!verifyInviteTokenSignature(token, sig)) {
      res.status(400).send('Invalid invite');
      return;
    }
    const phone = normalizePhone(String(req.body.phone ?? ''));
    try {
      await createOtpChallenge(db, phone, `invite_${token}`);
      res.send('SMS code sent. Return and submit the verification form.');
    } catch (err) {
      res
        .status(500)
        .send(err instanceof Error ? err.message : 'Failed to send SMS');
    }
  });

  router.post('/invite/:token/accept', (req, res) => {
    const token = req.params.token;
    const sig = String(req.query.s ?? '');
    if (!verifyInviteTokenSignature(token, sig)) {
      res.status(400).send('Invalid invite');
      return;
    }
    const phone = normalizePhone(String(req.body.phone ?? ''));
    const code = String(req.body.code ?? '');
    const otp = verifyOtp(db, phone, `invite_${token}`, code);
    if (!otp.ok) {
      res.status(400).send(otp.message);
      return;
    }

    let user = findUserByPhone(db, phone);
    if (!user) {
      const id = newId('usr');
      db.prepare(
        `INSERT INTO users (id, email, password_hash, first_name, last_name, phone, role, status, created_at, updated_at)
         VALUES (?, ?, 'bot-invite-pending', 'Staff', 'Member', ?, 'merchant', 'active', ?, ?)`
      ).run(id, `${phone}@staff.pas2me.local`, phone, nowIso(), nowIso());
      user = findUserByPhone(db, phone);
    }
    if (!user) {
      res.status(500).send('Could not resolve user');
      return;
    }

    const result = acceptInvite(db, token, user.id, phone);
    if (!result.ok) {
      res.status(400).send(result.message);
      return;
    }
    res.send(
      'Onboarding complete. Open WhatsApp and message the Pas2me bot, then reply *merchant*.'
    );
  });

  // Simple pay page placeholder for mock Monnify
  router.get('/pay/:reference', (req, res) => {
    res.type('html').send(`<!doctype html>
<html><body style="font-family:system-ui;padding:2rem">
<h1>Pas2me payment</h1>
<p>Reference: <code>${req.params.reference}</code></p>
<p>Configure Monnify for live checkout. This page is a development placeholder.</p>
<form method="POST" action="/pay/${req.params.reference}/simulate">
<button>Simulate successful payment (dev)</button>
</form>
</body></html>`);
  });

  router.post('/pay/:reference/simulate', (req, res) => {
    if (getEnv().NODE_ENV === 'production') {
      res.status(403).send('Disabled in production');
      return;
    }
    void handleMonnifyPaymentWebhook(db, {
      paymentStatus: 'PAID',
      paymentReference: req.params.reference,
      amountPaid: '0',
    }).catch((err) => console.error(err));
    res.send('Simulated. Check WhatsApp / DB for updates.');
  });

  return router;
}

/** Monnify amountPaid is Naira (number or string). Never treat large ints as kobo. */
function monnifyAmountToKobo(amountField: unknown): number {
  if (typeof amountField === 'number' && Number.isFinite(amountField) && amountField > 0) {
    return Number(nairaToKobo(amountField));
  }
  if (typeof amountField === 'string' && amountField.trim()) {
    try {
      return Number(nairaToKobo(amountField.trim()));
    } catch {
      const n = Number(amountField);
      if (Number.isFinite(n) && n > 0) return Number(nairaToKobo(n));
    }
  }
  return 0;
}

function destinationAccountNumber(eventData: Record<string, unknown>): string {
  const nested = eventData.destinationAccountInformation as
    | Record<string, unknown>
    | undefined;
  return String(
    nested?.accountNumber ??
      eventData.destinationAccountNumber ??
      eventData.accountNumber ??
      ''
  ).trim();
}

async function handleMonnifyPaymentWebhook(db: Db, body: unknown): Promise<void> {
  const data = body as Record<string, unknown>;
  const eventType = String(data.eventType ?? '');
  const eventData = (data.eventData ?? data.data ?? data) as Record<
    string,
    unknown
  >;

  console.log(
    `[Monnify webhook] processing eventType=${eventType || '(none)'} paymentStatus=${String(eventData.paymentStatus ?? eventData.status ?? '')} product.type=${String((eventData.product as Record<string, unknown> | undefined)?.type ?? '')}`
  );

  if (
    getEnv().NODE_ENV === 'production' &&
    !verifyMonnifyWebhookHash(eventData)
  ) {
    console.warn('Monnify webhook hash mismatch — ignoring');
    return;
  }

  writeBotAudit(db, {
    action: 'monnify_payment_webhook',
    resource_type: 'payment',
    details: { eventType, ...eventData },
  });

  // Ignore non-collection events when Monnify sends an eventType
  if (
    eventType &&
    eventType !== 'SUCCESSFUL_TRANSACTION' &&
    !eventType.toUpperCase().includes('SUCCESS')
  ) {
    console.log(`[Monnify webhook] ignoring eventType=${eventType}`);
    return;
  }

  const reference = String(
    eventData.paymentReference ??
      eventData.reference ??
      eventData.orderId ??
      ''
  );
  const status = String(
    eventData.paymentStatus ?? eventData.status ?? ''
  ).toLowerCase();

  const product = (eventData.product ?? {}) as Record<string, unknown>;
  const productType = String(product.type ?? '').toUpperCase();
  const accountReference = String(product.reference ?? '');
  const destAccount = destinationAccountNumber(eventData);

  const success =
    status.includes('success') ||
    status === 'successful' ||
    status === 'paid' ||
    status === '';

  if (!success) {
    console.log(`[Monnify webhook] non-success status=${status} — skip`);
    return;
  }

  // Reserved-account wallet funding
  if (productType === 'RESERVED_ACCOUNT') {
    const wallet = db
      .prepare(
        `SELECT user_id FROM wallets
         WHERE monnify_account_reference = ?
            OR (? != '' AND monnify_account_number = ?)
         LIMIT 1`
      )
      .get(accountReference, destAccount, destAccount) as
      | { user_id: string }
      | undefined;

    const amountKobo = monnifyAmountToKobo(
      eventData.amountPaid ?? eventData.amount
    );

    console.log(
      `[Monnify VA] ref=${accountReference} dest=${destAccount} amountKobo=${amountKobo} walletUser=${wallet?.user_id ?? 'NONE'}`
    );

    if (wallet?.user_id && amountKobo > 0) {
      const providerRef = String(
        eventData.transactionReference ?? reference ?? accountReference
      );
      const applied = creditTopupFromWebhook(
        db,
        `topup_va_${providerRef}`,
        wallet.user_id,
        amountKobo
      );
      if (applied) await notifyWalletTopup(db, wallet.user_id, amountKobo);
    } else if (!wallet?.user_id) {
      console.warn(
        `[Monnify VA] no wallet matched accountReference=${accountReference} destAccount=${destAccount}`
      );
    }
    return;
  }

  if (!reference) return;

  // Order payment (single pay_{orderId} or grouped payg_{id})
  if (reference.startsWith('pay_') || reference.startsWith('payg_')) {
    const orders = reference.startsWith('payg_')
      ? (db
          .prepare(`SELECT * FROM orders WHERE payment_reference = ?`)
          .all(reference) as Array<{
          id: string;
          store_id: string;
          total_amount: number | string;
          payment_status: string;
        }>)
      : (() => {
          const orderId = reference.slice(4);
          const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as
            | {
                id: string;
                store_id: string;
                total_amount: number | string;
                payment_status: string;
              }
            | undefined;
          return order ? [order] : [];
        })();

    db.prepare(
      `UPDATE payment_links SET status = 'used', used_at = ?, updated_at = ? WHERE reference = ?`
    ).run(nowIso(), nowIso(), reference);

    for (const order of orders) {
      if (order.payment_status === 'paid') continue;

      db.prepare(
        `UPDATE orders SET payment_status = 'paid', payment_method = 'monnify', payment_reference = ?, status = 'confirmed', updated_at = ? WHERE id = ?`
      ).run(reference, nowIso(), order.id);
      applyPaidOrderToInventory(db, order.id);

      try {
        markLogisticsPaidReady(db, order.id);
        const logistics = getOrderLogistics(db, order.id);
        const store = db
          .prepare(`SELECT user_id FROM stores WHERE id = ?`)
          .get(order.store_id) as { user_id: string } | undefined;

        if (logistics && store && getReadyWallet(db, store.user_id)) {
          const shippingKobo = logistics.delivery_fee_kobo;
          const totalKobo = Math.round(Number(order.total_amount) * 100);
          const itemsKobo = Math.max(0, totalKobo - shippingKobo);
          applyLedgerEntry(db, {
            userId: store.user_id,
            direction: 'credit',
            amount: kobo(itemsKobo),
            type: 'purchase',
            idempotencyKey: `vendor_credit_monnify_${order.id}`,
            storeId: order.store_id,
            orderId: order.id,
          });
          if (
            logistics.method === 'vendor_delivery' &&
            logistics.delivery_fee_kobo > 0
          ) {
            lockDeliveryFee(db, {
              payerUserId: store.user_id,
              recipientUserId: store.user_id,
              amount: kobo(logistics.delivery_fee_kobo),
              orderId: order.id,
            });
          }
          if (
            logistics.method === 'dispatch_pickup' &&
            logistics.delivery_fee_kobo > 0
          ) {
            db.prepare(
              `UPDATE order_logistics SET fee_hold_status = 'held', updated_at = ? WHERE order_id = ?`
            ).run(nowIso(), order.id);
          }
        }
      } catch (err) {
        console.error('post-payment logistics settle error', err);
      }

      writeBotAudit(db, {
        action: 'payment_confirmed',
        resource_type: 'order',
        resource_id: order.id,
        details: { reference },
      });
    }
    return;
  }

  // Wallet top-up (checkout link)
  if (reference.startsWith('topup_') || reference.startsWith('autotopup_')) {
    const phoneRaw = String(
      eventData.phone ??
        (eventData.customer as Record<string, unknown> | undefined)?.phone ??
        (eventData.customer as Record<string, unknown> | undefined)?.email ??
        ''
    );
    let userId: string | undefined;
    if (phoneRaw) {
      const digits = phoneRaw.replace(/\D/g, '');
      if (digits.length >= 10) {
        const user = findUserByPhone(db, normalizePhone(digits));
        userId = user?.id;
      }
    }
    if (!userId) {
      const conv = db
        .prepare(
          `SELECT user_id, context_json FROM bot_conversations WHERE context_json LIKE ? LIMIT 1`
        )
        .get(`%${reference}%`) as
        | { user_id: string | null; context_json: string }
        | undefined;
      userId = conv?.user_id ?? undefined;
    }

    let amountKobo = monnifyAmountToKobo(
      eventData.amountPaid ?? eventData.amount
    );

    if (!amountKobo) {
      const conv = db
        .prepare(
          `SELECT user_id, context_json FROM bot_conversations WHERE context_json LIKE ? LIMIT 1`
        )
        .get(`%${reference}%`) as
        | { user_id: string | null; context_json: string }
        | undefined;
      if (conv?.context_json) {
        const ctx = JSON.parse(conv.context_json) as {
          pending_topup_kobo?: number;
        };
        amountKobo = ctx.pending_topup_kobo ?? 0;
        userId = userId ?? conv.user_id ?? undefined;
      }
    }

    if (userId && amountKobo > 0) {
      const applied = creditTopupFromWebhook(db, reference, userId, amountKobo);
      if (applied) await notifyWalletTopup(db, userId, amountKobo);
    }
  }
}
