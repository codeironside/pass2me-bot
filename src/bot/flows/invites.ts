import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from '../../db/client';
import {
  getOrCreateConversation,
  updateConversation,
  writeBotAudit,
} from '../../db/repos';
import { getEnv } from '../../config/env';
import { newId, nowIso } from '../../domain/ids';
import { sendButtons, sendText } from '../../services/whatsapp';
import { canInviteRole, type ResolvedIdentity } from '../identity';
import type { StaffRole } from '../../db/repos';

function signToken(token: string): string {
  return createHmac('sha256', getEnv().JWT_INVITE_SECRET)
    .update(token)
    .digest('hex');
}

export function verifyInviteTokenSignature(
  token: string,
  signature: string
): boolean {
  const expected = signToken(token);
  try {
    return timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

export async function startInviteFlow(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string
): Promise<void> {
  const isOwner =
    identity.isSuperAdmin || identity.ownedStoreIds.includes(storeId);
  const roles = identity.isSuperAdmin
    ? (['business_admin'] as StaffRole[])
    : identity.staffRoles
        .filter((r) => r.storeId === storeId)
        .map((r) => r.role);

  if (!canInviteRole(roles, isOwner, 'cashier', identity.isSuperAdmin)) {
    await sendText(chatId, 'You cannot invite staff for this location.');
    return;
  }

  updateConversation(db, identity.phone, {
    state: 'invite_pick_role',
    selected_store_id: storeId,
  });

  const buttons = [{ id: 'inv_role_cashier', text: 'Cashier' }];
  if (isOwner || roles.includes('business_admin') || identity.isSuperAdmin) {
    buttons.unshift(
      { id: 'inv_role_business_admin', text: 'Business admin' },
      { id: 'inv_role_location_manager', text: 'Location manager' }
    );
  }

  await sendButtons(chatId, 'Invite staff — choose a role:', buttons);
}

export async function continueInviteFlow(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  text: string,
  interactiveId?: string
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);

  if (conv.state === 'invite_pick_role') {
    let role: StaffRole | null = null;
    if (interactiveId === 'inv_role_cashier') role = 'cashier';
    if (interactiveId === 'inv_role_location_manager')
      role = 'location_manager';
    if (interactiveId === 'inv_role_business_admin') role = 'business_admin';

    if (!role) {
      await sendText(chatId, 'Pick a role from the buttons.');
      return;
    }

    const isOwner =
      identity.isSuperAdmin || identity.ownedStoreIds.includes(storeId);
    const roles = identity.isSuperAdmin
      ? (['business_admin'] as StaffRole[])
      : identity.staffRoles
          .filter((r) => r.storeId === storeId)
          .map((r) => r.role);
    if (!canInviteRole(roles, isOwner, role, identity.isSuperAdmin)) {
      await sendText(chatId, 'You cannot invite that role.');
      return;
    }

    updateConversation(db, identity.phone, {
      state: 'invite_await_phone',
      context_json: JSON.stringify({ invite_role: role }),
    });
    await sendText(
      chatId,
      'Send the invitee phone number (e.g. 0803… or 234…).'
    );
    return;
  }

  if (conv.state === 'invite_await_phone') {
    const { normalizePhone } = await import('../../domain/ids');
    const phone = normalizePhone(text.trim());
    if (phone.length < 11) {
      await sendText(chatId, 'Invalid phone number.');
      return;
    }

    const ctx = JSON.parse(conv.context_json || '{}') as {
      invite_role?: StaffRole;
    };
    const role = ctx.invite_role;
    if (!role || !identity.user) {
      updateConversation(db, identity.phone, { state: 'idle' });
      await sendText(chatId, 'Invite session expired. Start again with *invite*.');
      return;
    }

    const token = newId('inv');
    const expiresAt = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
    db.prepare(
      `INSERT INTO staff_invites
        (id, token, store_id, role, invited_phone, invited_by_user_id, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(
      newId('sinv'),
      token,
      storeId,
      role,
      phone,
      identity.user.id,
      expiresAt,
      nowIso(),
      nowIso()
    );

    const env = getEnv();
    const sig = signToken(token);
    const link = `${env.BOT_PUBLIC_URL}/invite/${token}?s=${sig}`;

    updateConversation(db, identity.phone, { state: 'idle', context_json: '{}' });

    writeBotAudit(db, {
      actor_user_id: identity.user.id,
      actor_phone: identity.phone,
      action: 'staff_invite_created',
      resource_type: 'staff_invite',
      resource_id: token,
      details: { role, invited_phone: phone, store_id: storeId },
    });

    await sendText(
      chatId,
      `Invite created for ${phone} as *${role}*.\nShare this onboarding link:\n${link}\n\nExpires in 72 hours.`
    );
  }
}

export function acceptInvite(
  db: Db,
  token: string,
  userId: string,
  phone: string
): { ok: true } | { ok: false; message: string } {
  const invite = db
    .prepare(`SELECT * FROM staff_invites WHERE token = ?`)
    .get(token) as
    | {
        id: string;
        store_id: string;
        role: StaffRole;
        status: string;
        expires_at: string;
      }
    | undefined;

  if (!invite) return { ok: false, message: 'Invite not found' };
  if (invite.status !== 'pending')
    return { ok: false, message: 'Invite is no longer pending' };
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    db.prepare(
      `UPDATE staff_invites SET status = 'expired', updated_at = ? WHERE id = ?`
    ).run(nowIso(), invite.id);
    return { ok: false, message: 'Invite expired' };
  }

  const run = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO staff_assignments
        (id, user_id, store_id, role, is_active, invited_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
    ).run(
      newId('sa'),
      userId,
      invite.store_id,
      invite.role,
      null,
      nowIso(),
      nowIso()
    );

    // Upsert if conflict on unique — activate
    db.prepare(
      `UPDATE staff_assignments SET is_active = 1, role = ?, updated_at = ?
       WHERE user_id = ? AND store_id = ?`
    ).run(invite.role, nowIso(), userId, invite.store_id);

    db.prepare(
      `UPDATE staff_invites SET status = 'accepted', accepted_user_id = ?, invited_phone = ?, updated_at = ?
       WHERE id = ?`
    ).run(userId, phone, nowIso(), invite.id);

    // Keep operators table in sync loosely for platform compatibility
    db.prepare(
      `INSERT OR IGNORE INTO store_whatsapp_operators
        (id, store_id, user_id, phone, normalized_phone, role, is_primary, is_verified, verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'staff', 0, 1, ?, ?, ?)`
    ).run(
      newId('op'),
      invite.store_id,
      userId,
      phone,
      phone,
      nowIso(),
      nowIso(),
      nowIso()
    );
  });
  run();

  return { ok: true };
}
