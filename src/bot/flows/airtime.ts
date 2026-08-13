import type { Db } from '../../db/client';
import {
  getOrCreateConversation,
  updateConversation,
} from '../../db/repos';
import { formatNgn, kobo, nairaToKobo } from '../../domain/money';
import { newId, normalizePhone, nowIso } from '../../domain/ids';
import { sendText } from '../../services/whatsapp';
import { purchaseAirtime } from '../../services/flutterwave';
import { applyLedgerEntry } from '../../services/wallet';
import type { ResolvedIdentity } from '../identity';
import { requireReadyWalletOrPromptKyc } from './wallet';

export async function startAirtimeFlow(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  if (!identity.user) {
    await sendText(chatId, 'Registered account required to buy airtime.');
    return;
  }
  if (!(await requireReadyWalletOrPromptKyc(db, identity, chatId))) return;
  updateConversation(db, identity.phone, { state: 'airtime_phone' });
  await sendText(
    chatId,
    'Buy airtime (Flutterwave).\nSend beneficiary phone (or ME for yourself):'
  );
}

export async function handleAirtimeMessage(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  text: string
): Promise<boolean> {
  const conv = getOrCreateConversation(db, identity.phone);

  if (conv.state === 'airtime_phone') {
    const raw = text.trim().toLowerCase() === 'me' ? identity.phone : text.trim();
    const phone = normalizePhone(raw);
    updateConversation(db, identity.phone, {
      state: 'airtime_amount',
      context_json: JSON.stringify({ airtime_phone: phone }),
    });
    await sendText(chatId, 'Enter airtime amount in Naira (min 50):');
    return true;
  }

  if (conv.state === 'airtime_amount') {
    if (!identity.user) return true;
    let amount;
    try {
      amount = nairaToKobo(text.trim());
    } catch {
      await sendText(chatId, 'Invalid amount.');
      return true;
    }
    if (Number(amount) < 5000) {
      await sendText(chatId, 'Minimum airtime is ₦50.');
      return true;
    }

    const ctx = JSON.parse(conv.context_json || '{}') as {
      airtime_phone?: string;
    };
    const beneficiary = ctx.airtime_phone ?? identity.phone;
    if (!(await requireReadyWalletOrPromptKyc(db, identity, chatId))) return true;

    const orderId = newId('air');
    const idem = `airtime_${orderId}`;

    try {
      applyLedgerEntry(db, {
        userId: identity.user.id,
        direction: 'debit',
        amount,
        type: 'airtime',
        idempotencyKey: idem,
        provider: 'flutterwave',
        metadata: { beneficiary },
        actorPhone: identity.phone,
      });
    } catch (err) {
      await sendText(
        chatId,
        err instanceof Error ? err.message : 'Insufficient wallet balance'
      );
      updateConversation(db, identity.phone, { state: 'idle' });
      return true;
    }

    db.prepare(
      `INSERT INTO airtime_orders
        (id, user_id, beneficiary_phone, amount_kobo, status, provider, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'processing', 'flutterwave', ?, ?, ?)`
    ).run(
      orderId,
      identity.user.id,
      beneficiary,
      amount,
      idem,
      nowIso(),
      nowIso()
    );

    const result = await purchaseAirtime({
      beneficiaryPhone: beneficiary,
      amount,
      reference: orderId,
    });

    db.prepare(
      `UPDATE airtime_orders
       SET status = ?, provider_reference = ?, error_message = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      result.success ? 'successful' : 'failed',
      result.providerReference ?? null,
      result.success ? null : result.message,
      nowIso(),
      orderId
    );

    if (!result.success) {
      // refund wallet
      applyLedgerEntry(db, {
        userId: identity.user.id,
        direction: 'credit',
        amount,
        type: 'refund',
        idempotencyKey: `airtime_refund_${orderId}`,
        provider: 'flutterwave',
        metadata: { reason: result.message },
      });
      await sendText(chatId, `Airtime failed: ${result.message}. Wallet refunded.`);
    } else {
      await sendText(
        chatId,
        `Airtime ${formatNgn(amount)} sent to ${beneficiary}.\n${result.message}`
      );
    }

    updateConversation(db, identity.phone, { state: 'idle', context_json: '{}' });
    return true;
  }

  void kobo;
  return false;
}
