import type { Db } from '../db/client';
import { getEnv } from '../config/env';
import {
  getWalletByUserId,
  type WalletRow,
} from '../db/repos';
import { newId, nowIso } from '../domain/ids';
import { createReservedAccount } from './monnify';

export type ProvisionWalletResult =
  | { status: 'ready'; wallet: WalletRow }
  | { status: 'needs_kyc' }
  | { status: 'unconfigured' }
  | { status: 'failed'; message: string };

function accountReferenceForUser(userId: string): string {
  return `pas2me_${userId}`;
}

function emailForPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `${digits || 'user'}@wallet.pas2me.local`;
}

/** Wallet is usable only when Monnify VA account number is present. */
export function getReadyWallet(
  db: Db,
  userId: string
): WalletRow | undefined {
  const wallet = getWalletByUserId(db, userId);
  if (!wallet?.monnify_account_number?.trim()) return undefined;
  return wallet;
}

/** Drop incomplete wallet rows (no VA). Keeps rows that already hold a balance. */
export function purgeIncompleteWallet(db: Db, userId: string): void {
  db.prepare(
    `DELETE FROM wallets
     WHERE user_id = ?
       AND IFNULL(TRIM(monnify_account_number), '') = ''
       AND balance_kobo = 0`
  ).run(userId);
}

/**
 * Create / complete a wallet only after Monnify returns a virtual account.
 * Never inserts a local wallet row without monnify_account_number.
 */
export async function provisionMonnifyWallet(
  db: Db,
  userId: string,
  phone: string,
  opts: {
    customerName?: string;
    bvn?: string;
    nin?: string;
  }
): Promise<ProvisionWalletResult> {
  const ready = getReadyWallet(db, userId);
  if (ready) return { status: 'ready', wallet: ready };

  const bvn = opts.bvn?.trim();
  const nin = opts.nin?.trim();
  if (!bvn && !nin) {
    return { status: 'needs_kyc' };
  }

  const env = getEnv();
  if (!env.MONNIFY_API_KEY || !env.MONNIFY_SECRET_KEY || !env.MONNIFY_CONTRACT_CODE) {
    return { status: 'unconfigured' };
  }

  purgeIncompleteWallet(db, userId);

  const existing = getWalletByUserId(db, userId);
  const accountReference =
    existing?.monnify_account_reference || accountReferenceForUser(userId);

  try {
    const result = await createReservedAccount({
      accountReference,
      customerName: opts.customerName?.trim() || `Pas2me ${phone}`,
      customerEmail: emailForPhone(phone),
      bvn,
      nin,
    });

    if (!result.ok || !result.accountNumber) {
      const raw = result.raw as Record<string, unknown> | undefined;
      const apiMessage = String(
        raw?.responseMessage ?? raw?.message ?? ''
      ).trim();
      console.error('[Monnify] VA provision failed', result.raw);
      return {
        status: 'failed',
        message:
          apiMessage ||
          'Could not create your Monnify virtual account. Check BVN/NIN and try again.',
      };
    }

    const now = nowIso();
    if (existing) {
      db.prepare(
        `UPDATE wallets
         SET phone = ?,
             monnify_account_number = ?,
             monnify_account_reference = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(
        phone,
        result.accountNumber,
        result.accountReference || accountReference,
        now,
        existing.id
      );
    } else {
      db.prepare(
        `INSERT INTO wallets
          (id, user_id, phone, currency, balance_kobo, status,
           monnify_account_number, monnify_account_reference, created_at, updated_at)
         VALUES (?, ?, ?, 'NGN', 0, 'active', ?, ?, ?, ?)`
      ).run(
        newId('wal'),
        userId,
        phone,
        result.accountNumber,
        result.accountReference || accountReference,
        now,
        now
      );
    }

    const wallet = getReadyWallet(db, userId);
    if (!wallet) {
      return {
        status: 'failed',
        message: 'Wallet was created at Monnify but could not be saved locally.',
      };
    }

    console.log(
      `[Monnify] wallet provisioned user=${userId} account=${result.accountNumber}`
    );
    return { status: 'ready', wallet };
  } catch (err) {
    console.error('[Monnify] wallet provision error', err);
    return {
      status: 'failed',
      message: err instanceof Error ? err.message : 'Wallet creation failed',
    };
  }
}
