import { syncSharedTablesFromSiblingD1, type Db } from '../db/client';
import {
  findUserByPhone,
  getOrCreateConversation,
  listOwnedStores,
  listStaffAssignments,
  updateConversation,
  writeBotAudit,
  type BotMode,
  type StaffRole,
  type UserRow,
} from '../db/repos';
import { createOtpChallenge } from '../services/sms';

export interface ResolvedIdentity {
  phone: string;
  user: UserRow | null;
  mode: BotMode;
  staffRoles: Array<{ storeId: string; role: StaffRole }>;
  ownedStoreIds: string[];
  /** Platform developer / admin backroom */
  isDeveloper: boolean;
  developerLevel: number;
  /**
   * Superadmin: users.role === 'admin' or developer_access.level >= 4.
   * Full merchant access on every store + all privileged ops.
   */
  isSuperAdmin: boolean;
}

export function resolveIdentity(db: Db, phone: string): ResolvedIdentity {
  syncSharedTablesFromSiblingD1(db);
  const user = findUserByPhone(db, phone) ?? null;
  const staff = user ? listStaffAssignments(db, user.id) : [];
  const owned = user ? listOwnedStores(db, user.id) : [];

  let isDeveloper = false;
  let developerLevel = 0;
  if (user) {
    const dev = db
      .prepare('SELECT level FROM developer_access WHERE user_id = ?')
      .get(user.id) as { level: number } | undefined;
    if (dev) {
      isDeveloper = true;
      developerLevel = Number(dev.level) || 0;
    } else if (user.role === 'admin') {
      isDeveloper = true;
      developerLevel = 4;
    }
  }

  const isSuperAdmin = Boolean(
    user?.role === 'admin' || (isDeveloper && developerLevel >= 4)
  );

  // Superadmins implicitly "own" every active store for merchant tooling
  let ownedStoreIds = owned.map((s) => s.id);
  if (isSuperAdmin) {
    const all = db
      .prepare(
        `SELECT id FROM stores WHERE IFNULL(is_archived, 0) = 0 ORDER BY name`
      )
      .all() as Array<{ id: string }>;
    ownedStoreIds = [...new Set([...ownedStoreIds, ...all.map((s) => s.id)])];
  }

  let mode: BotMode = 'customer';
  // Developers default to customer (shop/pay like everyone).
  // Reply *dev* / *merchant* to switch. Superadmins can use all modes.
  if (!isDeveloper && !isSuperAdmin && (staff.length > 0 || owned.length > 0)) {
    mode = 'merchant';
  }

  return {
    phone,
    user,
    mode,
    staffRoles: staff.map((s) => ({ storeId: s.store_id, role: s.role })),
    ownedStoreIds,
    isDeveloper: isDeveloper || isSuperAdmin,
    developerLevel: isSuperAdmin ? Math.max(developerLevel, 4) : developerLevel,
    isSuperAdmin,
  };
}

/** First WhatsApp touch: link conversation to user. Wallet is created later with Monnify VA + KYC. */
export async function onFirstTouch(
  db: Db,
  phone: string
): Promise<ResolvedIdentity> {
  const conv = getOrCreateConversation(db, phone);
  const identity = resolveIdentity(db, phone);

  if (identity.user) {
    const firstLink = !conv.user_id;
    // Never overwrite an explicit mode switch (merchant / developer) on later messages
    updateConversation(db, phone, {
      user_id: identity.user.id,
      ...(firstLink ? { mode: identity.mode } : {}),
    });

    if (firstLink) {
      writeBotAudit(db, {
        actor_user_id: identity.user.id,
        actor_phone: phone,
        action: 'bot_first_touch',
        resource_type: 'user',
        resource_id: identity.user.id,
      });
    }
  }

  return identity;
}

export async function startPhoneVerification(
  db: Db,
  phone: string,
  purpose: string
): Promise<void> {
  await createOtpChallenge(db, phone, purpose);
}

export function canInviteRole(
  actorRoles: StaffRole[],
  isOwner: boolean,
  target: StaffRole,
  isSuperAdmin = false
): boolean {
  if (isSuperAdmin) return true;
  if (isOwner || actorRoles.includes('business_admin')) {
    return (
      target === 'business_admin' ||
      target === 'location_manager' ||
      target === 'cashier'
    );
  }
  if (actorRoles.includes('location_manager')) {
    return target === 'cashier';
  }
  return false;
}

export function canManageRefunds(
  roles: StaffRole[],
  isOwner: boolean,
  isSuperAdmin = false
): boolean {
  if (isSuperAdmin) return true;
  return (
    isOwner ||
    roles.includes('business_admin') ||
    roles.includes('location_manager')
  );
}

export function canAdjustStock(
  roles: StaffRole[],
  isOwner: boolean,
  isSuperAdmin = false
): boolean {
  if (isSuperAdmin) return true;
  return (
    isOwner ||
    roles.includes('business_admin') ||
    roles.includes('location_manager')
  );
}

export function canRecordSale(
  roles: StaffRole[],
  isOwner: boolean,
  isSuperAdmin = false
): boolean {
  if (isSuperAdmin) return true;
  return isOwner || roles.length > 0;
}

/** Create / archive locations — owner, business_admin, or superadmin. */
export function canManageLocations(
  roles: StaffRole[],
  isOwner: boolean,
  isSuperAdmin = false
): boolean {
  if (isSuperAdmin) return true;
  return isOwner || roles.includes('business_admin');
}

/** Edit name/desc/cover/pickup for a location. */
export function canEditLocation(
  roles: StaffRole[],
  isOwner: boolean,
  isSuperAdmin = false
): boolean {
  if (isSuperAdmin) return true;
  return (
    isOwner ||
    roles.includes('business_admin') ||
    roles.includes('location_manager')
  );
}

/** True when identity may use merchant mode (any signed-up user can sell). */
export function canAccessMerchant(identity: ResolvedIdentity): boolean {
  return Boolean(identity.user) || identity.isSuperAdmin;
}
