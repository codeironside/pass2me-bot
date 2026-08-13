import type { Db } from '../db/client';
import { getWalletByUserId, writeBotAudit } from '../db/repos';
import { newId, nowIso } from '../domain/ids';
import type { Kobo } from '../domain/money';
import { addKobo, kobo, subKobo } from '../domain/money';

export type WalletTxType =
  | 'topup'
  | 'purchase'
  | 'refund'
  | 'payout'
  | 'airtime'
  | 'fee'
  | 'delivery_fee'
  | 'hold'
  | 'release'
  | 'manual_credit'
  | 'manual_debit'
  | 'auto_topup'
  | 'transfer_out'
  | 'transfer_in'
  | 'bank_transfer';

export interface LedgerParams {
  userId: string;
  direction: 'credit' | 'debit';
  amount: Kobo;
  type: WalletTxType;
  idempotencyKey: string;
  provider?: string;
  providerReference?: string;
  storeId?: string;
  orderId?: string;
  metadata?: Record<string, unknown>;
  actorUserId?: string;
  actorPhone?: string;
}

function availableBalance(wallet: {
  balance_kobo: number;
  locked_kobo?: number | null;
}): Kobo {
  const locked = Number(wallet.locked_kobo ?? 0);
  return kobo(Math.max(0, wallet.balance_kobo - locked));
}

export function applyLedgerEntry(
  db: Db,
  params: LedgerParams
): { balanceAfter: Kobo; txId: string } {
  const existing = db
    .prepare(
      `SELECT id, balance_after_kobo FROM wallet_transactions WHERE idempotency_key = ?`
    )
    .get(params.idempotencyKey) as
    | { id: string; balance_after_kobo: number }
    | undefined;

  if (existing) {
    return {
      balanceAfter: kobo(existing.balance_after_kobo),
      txId: existing.id,
    };
  }

  const wallet = getWalletByUserId(db, params.userId);
  if (!wallet) throw new Error('Wallet not found');
  if (!wallet.monnify_account_number?.trim()) {
    throw new Error(
      'Wallet not ready. Open *wallet* and provide your BVN or NIN to create it.'
    );
  }
  if (wallet.status !== 'active') throw new Error('Wallet is not active');

  const current = kobo(wallet.balance_kobo);
  if (params.direction === 'debit') {
    const available = availableBalance(wallet);
    if (params.amount > available) {
      throw new Error('Insufficient available wallet balance (funds may be locked)');
    }
  }

  const balanceAfter =
    params.direction === 'credit'
      ? addKobo(current, params.amount)
      : subKobo(current, params.amount);

  const txId = newId('wtx');

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE wallets SET balance_kobo = ?, updated_at = ? WHERE id = ?`
    ).run(balanceAfter, nowIso(), wallet.id);

    db.prepare(
      `INSERT INTO wallet_transactions
        (id, wallet_id, direction, amount_kobo, balance_after_kobo, type, currency,
         provider, provider_reference, idempotency_key, store_id, order_id, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'NGN', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      txId,
      wallet.id,
      params.direction,
      params.amount,
      balanceAfter,
      params.type,
      params.provider ?? null,
      params.providerReference ?? null,
      params.idempotencyKey,
      params.storeId ?? null,
      params.orderId ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      nowIso()
    );

    writeBotAudit(db, {
      actor_user_id: params.actorUserId ?? params.userId,
      actor_phone: params.actorPhone,
      action: `wallet_${params.direction}`,
      resource_type: 'wallet_transaction',
      resource_id: txId,
      details: {
        type: params.type,
        amount_kobo: params.amount,
        balance_after_kobo: balanceAfter,
        store_id: params.storeId,
        order_id: params.orderId,
      },
    });
  });

  run();
  return { balanceAfter, txId };
}

/**
 * Atomic Pas2me → Pas2me wallet transfer (ledger only; no Monnify).
 * Both users must have ready (Monnify VA) wallets.
 */
export function transferToUserWallet(
  db: Db,
  params: {
    fromUserId: string;
    toUserId: string;
    amount: Kobo;
    idempotencyKey: string;
    actorPhone?: string;
    note?: string;
  }
): { outTxId: string; inTxId: string } {
  if (params.fromUserId === params.toUserId) {
    throw new Error('You cannot send money to yourself.');
  }
  if (Number(params.amount) <= 0) {
    throw new Error('Amount must be greater than zero.');
  }

  const existingOut = db
    .prepare(
      `SELECT id FROM wallet_transactions WHERE idempotency_key = ?`
    )
    .get(`${params.idempotencyKey}_out`);
  if (existingOut) {
    const existingIn = db
      .prepare(
        `SELECT id FROM wallet_transactions WHERE idempotency_key = ?`
      )
      .get(`${params.idempotencyKey}_in`) as { id: string } | undefined;
    return {
      outTxId: (existingOut as { id: string }).id,
      inTxId: existingIn?.id ?? '',
    };
  }

  const fromWallet = getWalletByUserId(db, params.fromUserId);
  const toWallet = getWalletByUserId(db, params.toUserId);
  if (!fromWallet?.monnify_account_number?.trim()) {
    throw new Error('Your wallet is not ready. Open *wallet* and complete BVN/NIN setup.');
  }
  if (!toWallet?.monnify_account_number?.trim()) {
    throw new Error('Recipient does not have a Pas2me wallet yet.');
  }
  if (fromWallet.status !== 'active' || toWallet.status !== 'active') {
    throw new Error('Wallet is not active.');
  }

  const available = availableBalance(fromWallet);
  if (params.amount > available) {
    throw new Error('Insufficient available wallet balance (funds may be locked)');
  }

  let outTxId = '';
  let inTxId = '';

  const run = db.transaction(() => {
    const out = applyLedgerEntry(db, {
      userId: params.fromUserId,
      direction: 'debit',
      amount: params.amount,
      type: 'transfer_out',
      idempotencyKey: `${params.idempotencyKey}_out`,
      actorPhone: params.actorPhone,
      metadata: {
        to_user_id: params.toUserId,
        note: params.note ?? 'p2p_transfer',
      },
    });
    const inn = applyLedgerEntry(db, {
      userId: params.toUserId,
      direction: 'credit',
      amount: params.amount,
      type: 'transfer_in',
      idempotencyKey: `${params.idempotencyKey}_in`,
      actorPhone: params.actorPhone,
      metadata: {
        from_user_id: params.fromUserId,
        note: params.note ?? 'p2p_transfer',
      },
    });
    outTxId = out.txId;
    inTxId = inn.txId;
  });

  run();
  return { outTxId, inTxId };
}

/** Increase locked_kobo so credited delivery fees stay unavailable until delivery. */
export function holdFunds(
  db: Db,
  params: {
    userId: string;
    amount: Kobo;
    idempotencyKey: string;
    orderId?: string;
  }
): void {
  if (Number(params.amount) <= 0) return;
  const existing = db
    .prepare(
      `SELECT id FROM wallet_transactions WHERE idempotency_key = ?`
    )
    .get(params.idempotencyKey);
  if (existing) return;

  const wallet = getWalletByUserId(db, params.userId);
  if (!wallet) throw new Error('Wallet not found');

  const locked = Number(wallet.locked_kobo ?? 0) + Number(params.amount);
  db.prepare(
    `UPDATE wallets SET locked_kobo = ?, updated_at = ? WHERE id = ?`
  ).run(locked, nowIso(), wallet.id);

  db.prepare(
    `INSERT INTO wallet_transactions
      (id, wallet_id, direction, amount_kobo, balance_after_kobo, type, currency,
       idempotency_key, order_id, metadata, created_at)
     VALUES (?, ?, 'debit', ?, ?, 'hold', 'NGN', ?, ?, ?, ?)`
  ).run(
    newId('wtx'),
    wallet.id,
    params.amount,
    wallet.balance_kobo,
    params.idempotencyKey,
    params.orderId ?? null,
    JSON.stringify({ locked_after: locked }),
    nowIso()
  );
}

/** Release previously locked funds (become spendable). */
export function releaseHold(
  db: Db,
  params: {
    userId: string;
    amount: Kobo;
    idempotencyKey: string;
    orderId?: string;
  }
): void {
  if (Number(params.amount) <= 0) return;
  const existing = db
    .prepare(
      `SELECT id FROM wallet_transactions WHERE idempotency_key = ?`
    )
    .get(params.idempotencyKey);
  if (existing) return;

  const wallet = getWalletByUserId(db, params.userId);
  if (!wallet) throw new Error('Wallet not found');

  const locked = Math.max(0, Number(wallet.locked_kobo ?? 0) - Number(params.amount));
  db.prepare(
    `UPDATE wallets SET locked_kobo = ?, updated_at = ? WHERE id = ?`
  ).run(locked, nowIso(), wallet.id);

  db.prepare(
    `INSERT INTO wallet_transactions
      (id, wallet_id, direction, amount_kobo, balance_after_kobo, type, currency,
       idempotency_key, order_id, metadata, created_at)
     VALUES (?, ?, 'credit', ?, ?, 'release', 'NGN', ?, ?, ?, ?)`
  ).run(
    newId('wtx'),
    wallet.id,
    params.amount,
    wallet.balance_kobo,
    params.idempotencyKey,
    params.orderId ?? null,
    JSON.stringify({ locked_after: locked }),
    nowIso()
  );
}
