import type { Db } from '../db/client';
import { getEnv } from '../config/env';
import { newId, nowIso } from '../domain/ids';
import { findCabmeCustomerByPhone } from './cabme';

export type CabmeLinkResult =
  | { status: 'linked'; cabmeUserId: string }
  | { status: 'needs_registration'; message: string }
  | { status: 'failed'; message: string };

export function getCabmeLink(
  db: Db,
  userId: string
): { cabme_user_id: string; phone: string | null } | undefined {
  return db
    .prepare(
      `SELECT cabme_user_id, phone FROM cabme_user_links WHERE user_id = ?`
    )
    .get(userId) as { cabme_user_id: string; phone: string | null } | undefined;
}

/**
 * Link Pas2me user → existing Cabme customer by phone.
 * Does NOT create Cabme accounts — user must register in Cabme first.
 */
export async function linkCabmeAccount(
  db: Db,
  userId: string,
  phone: string
): Promise<CabmeLinkResult> {
  const existing = getCabmeLink(db, userId);
  if (existing?.cabme_user_id) {
    return { status: 'linked', cabmeUserId: existing.cabme_user_id };
  }

  const found = await findCabmeCustomerByPhone(phone);
  if (!found.ok) {
    const registerUrl = getEnv().CABME_REGISTER_URL;
    return {
      status: 'needs_registration',
      message: [
        found.message,
        registerUrl ? `Register here / in app: ${registerUrl}` : null,
        'Use the *same phone number* as this WhatsApp chat, then reply *link cabme*.',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  db.prepare(
    `INSERT INTO cabme_user_links (id, user_id, cabme_user_id, phone, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       cabme_user_id = excluded.cabme_user_id,
       phone = excluded.phone,
       updated_at = excluded.updated_at`
  ).run(newId('cbl'), userId, found.cabmeUserId, phone, nowIso(), nowIso());

  return { status: 'linked', cabmeUserId: found.cabmeUserId };
}

export async function requireCabmeLink(
  db: Db,
  userId: string,
  phone: string
): Promise<CabmeLinkResult> {
  return linkCabmeAccount(db, userId, phone);
}

export function cabmeRegisterPrompt(): string {
  const url = getEnv().CABME_REGISTER_URL;
  return [
    'To request dispatch you need a *Cabme customer* account.',
    '1. Register in the Cabme customer app with this WhatsApp number.',
    url ? `2. Or open: ${url}` : '2. Install/open Cabme and sign up.',
    '3. Come back here and reply *link cabme*.',
  ].join('\n');
}
