import { createHash, randomInt } from 'node:crypto';
import { getEnv } from '../config/env';
import type { Db } from '../db/client';
import { newId, nowIso } from '../domain/ids';

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export async function sendSms(
  phone: string,
  message: string
): Promise<void> {
  const env = getEnv();
  if (env.SMS_PROVIDER === 'mock' || !env.SMS_API_KEY) {
    console.log(`[SMS mock] to=${phone} msg=${message}`);
    return;
  }

  const res = await fetch(`${env.SMS_BASE_URL}/api/sms/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.SMS_API_KEY}`,
    },
    body: JSON.stringify({
      to: phone.startsWith('+') ? phone : `+${phone}`,
      from: env.SMS_SENDER_ID,
      sms: message,
      type: 'plain',
      channel: 'generic',
      api_key: env.SMS_API_KEY,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`SMS send failed: ${res.status} ${body}`);
  }
}

export async function createOtpChallenge(
  db: Db,
  phone: string,
  purpose: string
): Promise<{ code: string; expiresAt: string }> {
  const env = getEnv();
  const code = String(randomInt(100000, 999999));
  const expiresAt = new Date(
    Date.now() + env.SMS_OTP_TTL_SECONDS * 1000
  ).toISOString();

  db.prepare(
    `INSERT INTO sms_otp_challenges (id, phone, code_hash, purpose, attempts, expires_at, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`
  ).run(newId('otp'), phone, hashCode(code), purpose, expiresAt, nowIso());

  await sendSms(
    phone,
    `Pas2me verification code: ${code}. Valid for ${Math.floor(env.SMS_OTP_TTL_SECONDS / 60)} minutes.`
  );

  return { code, expiresAt };
}

export function verifyOtp(
  db: Db,
  phone: string,
  purpose: string,
  code: string
): { ok: true } | { ok: false; message: string } {
  const row = db
    .prepare(
      `SELECT * FROM sms_otp_challenges
       WHERE phone = ? AND purpose = ? AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(phone, purpose) as
    | {
        id: string;
        code_hash: string;
        attempts: number;
        expires_at: string;
      }
    | undefined;

  if (!row) return { ok: false, message: 'No active verification code. Request a new one.' };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, message: 'Code expired. Request a new one.' };
  }
  if (row.attempts >= 5) {
    return { ok: false, message: 'Too many attempts. Request a new code.' };
  }

  db.prepare(
    `UPDATE sms_otp_challenges SET attempts = attempts + 1 WHERE id = ?`
  ).run(row.id);

  if (hashCode(code) !== row.code_hash) {
    return { ok: false, message: 'Invalid code.' };
  }

  db.prepare(
    `UPDATE sms_otp_challenges SET consumed_at = ? WHERE id = ?`
  ).run(nowIso(), row.id);

  return { ok: true };
}
