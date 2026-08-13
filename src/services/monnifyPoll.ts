import type { Db } from '../db/client';
import {
  creditTopupFromWebhook,
  notifyWalletTopup,
} from '../bot/flows/wallet';
import { nairaToKobo } from '../domain/money';
import { listReservedAccountTransactions } from './monnify';
import { getEnv } from '../config/env';

/** How often to look for deposits the webhook never delivered. */
const POLL_MS = 120_000;
/** Give the webhook this long before treating a paid VA transfer as hanging. */
const HANG_AFTER_MS = 90_000;

function amountToKobo(amountField: unknown): number {
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

function isPaid(status: string, completed: boolean): boolean {
  const s = status.toLowerCase();
  return (
    completed ||
    s.includes('success') ||
    s === 'paid' ||
    s === 'successful'
  );
}

function isHanging(completedOn: string | undefined): boolean {
  if (!completedOn?.trim()) return true;
  const ts = Date.parse(completedOn);
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts >= HANG_AFTER_MS;
}

/** Credits only deposits the webhook missed (older than HANG_AFTER_MS). */
export function startMonnifyDepositPoller(db: Db): void {
  const env = getEnv();
  if (!env.MONNIFY_API_KEY || !env.MONNIFY_SECRET_KEY) return;

  const tick = async (): Promise<void> => {
    const wallets = db
      .prepare(
        `SELECT user_id, monnify_account_reference
         FROM wallets
         WHERE IFNULL(TRIM(monnify_account_reference), '') != ''
           AND IFNULL(TRIM(monnify_account_number), '') != ''`
      )
      .all() as Array<{ user_id: string; monnify_account_reference: string }>;

    for (const wallet of wallets) {
      const txs = await listReservedAccountTransactions(
        wallet.monnify_account_reference,
        0,
        10
      );
      for (const tx of txs) {
        if (!isPaid(tx.paymentStatus, tx.completed)) continue;
        if (!isHanging(tx.completedOn)) continue;
        const ref = tx.transactionReference || tx.paymentReference;
        if (!ref) continue;
        const amountKobo = amountToKobo(tx.amountPaid);
        if (amountKobo <= 0) continue;
        const applied = creditTopupFromWebhook(
          db,
          `topup_va_${ref}`,
          wallet.user_id,
          amountKobo
        );
        if (applied) {
          console.log(
            `[Monnify poll] hanging deposit credited user=${wallet.user_id} ref=${ref} amountKobo=${amountKobo}`
          );
          await notifyWalletTopup(db, wallet.user_id, amountKobo);
        }
      }
    }
  };

  console.log(
    `[Monnify] hanging-deposit poller every ${POLL_MS / 1000}s (after ${HANG_AFTER_MS / 1000}s webhook grace)`
  );
  setInterval(() => {
    void tick().catch((err) => console.error('[Monnify poll] tick failed:', err));
  }, POLL_MS);
}
