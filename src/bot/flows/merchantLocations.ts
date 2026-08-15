import type { Db } from '../../db/client';
import {
  getContext,
  getOrCreateConversation,
  getStore,
  updateConversation,
  writeBotAudit,
} from '../../db/repos';
import { newId, nowIso } from '../../domain/ids';
import {
  sendImage,
  sendMenuMessage,
  sendText,
  type IncomingWahaMessage,
} from '../../services/whatsapp';
import {
  downloadInboundImage,
  loadCoverBytes,
  saveStoreCover,
} from '../../services/media';
import {
  getStorePickupLocation,
  setStorePickupLocation,
} from '../../services/logistics';
import {
  assertWithinLimit,
  getPlanFeatures,
  type SubscriptionPlan,
} from '../../guardrails/plans';
import {
  canEditLocation,
  canManageLocations,
  type ResolvedIdentity,
} from '../identity';
import { resolveCommand, type MenuOption } from '../command';

async function goMerchantHome(
  chatId: string,
  identity: ResolvedIdentity,
  db: Db
): Promise<void> {
  const { openInventoryHub } = await import('./merchantInventory');
  await openInventoryHub(db, identity, chatId);
}

type LocRoles = {
  isOwner: boolean;
  roles: Array<'business_admin' | 'location_manager' | 'cashier'>;
};

function rolesForStore(
  identity: ResolvedIdentity,
  storeId: string
): LocRoles {
  if (identity.isSuperAdmin) {
    return { isOwner: true, roles: ['business_admin'] };
  }
  const isOwner = identity.ownedStoreIds.includes(storeId);
  const roles = identity.staffRoles
    .filter((r) => r.storeId === storeId)
    .map((r) => r.role);
  return { isOwner, roles };
}

function rememberMenu(db: Db, phone: string, options: MenuOption[]): void {
  const conv = getOrCreateConversation(db, phone);
  const ctx = getContext(conv);
  updateConversation(db, phone, {
    context_json: JSON.stringify({ ...ctx, last_menu: options }),
  });
}

function lastMenu(db: Db, phone: string): MenuOption[] {
  const conv = getOrCreateConversation(db, phone);
  const ctx = getContext(conv);
  const menu = ctx.last_menu;
  if (!Array.isArray(menu)) return [];
  return menu.filter(
    (m): m is MenuOption =>
      typeof m === 'object' &&
      m !== null &&
      typeof (m as MenuOption).id === 'string' &&
      typeof (m as MenuOption).label === 'string'
  );
}

function accessibleStoreIds(identity: ResolvedIdentity): string[] {
  return [
    ...new Set([
      ...identity.ownedStoreIds,
      ...identity.staffRoles.map((s) => s.storeId),
    ]),
  ];
}

function clearCreateCtx(ctx: Record<string, unknown>): Record<string, unknown> {
  return {
    ...ctx,
    new_store_name: null,
    new_store_description: null,
    new_store_banner_url: null,
    new_store_pickup_lat: null,
    new_store_pickup_lng: null,
    new_store_pickup_address: null,
    manage_store_id: null,
    edit_field: null,
  };
}

async function sendCoverPreview(
  chatId: string,
  bannerUrl: string | null | undefined,
  caption: string
): Promise<void> {
  if (!bannerUrl) {
    await sendText(chatId, caption);
    return;
  }
  const bytes = await loadCoverBytes(bannerUrl);
  if (bytes) {
    await sendImage(chatId, bytes, caption);
  } else {
    await sendText(chatId, caption);
  }
}

/** Any signed-up user can create their own store. */
export function canCreateStore(identity: ResolvedIdentity): boolean {
  return Boolean(identity.user) || identity.isSuperAdmin;
}

export async function startCreateStore(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  if (!canCreateStore(identity) || !identity.user) {
    await sendText(
      chatId,
      [
        'To create a store you need a Pas2me account.',
        'Sign up at https://www.pas2me.com with this WhatsApp number,',
        'then reply *create store*.',
      ].join('\n')
    );
    return;
  }

  const ownedCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM stores WHERE user_id = ? AND IFNULL(is_archived, 0) = 0`
      )
      .get(identity.user.id) as { c: number }
  ).c;
  const plan: SubscriptionPlan = identity.isSuperAdmin ? 'enterprise' : 'starter';
  const features = getPlanFeatures(plan);
  const gate = assertWithinLimit(ownedCount, features.max_stores, 'Stores');
  if (!gate.ok) {
    await sendText(chatId, gate.message);
    return;
  }

  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  updateConversation(db, identity.phone, {
    mode: 'merchant',
    state: 'merch_store_name',
    context_json: JSON.stringify(clearCreateCtx(ctx)),
  });
  await sendText(
    chatId,
    'Add location — step 1/5\nEnter the *store / location name*:\n(or reply *cancel*)'
  );
}

export async function continueCreateStore(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  text: string,
  lower: string,
  inbound?: IncomingWahaMessage,
  location?: { latitude: number; longitude: number; description?: string }
): Promise<void> {
  const phone = identity.phone;
  const conv = getOrCreateConversation(db, phone);
  const ctx = getContext(conv);

  if (lower === 'cancel') {
    updateConversation(db, phone, {
      state: 'idle',
      context_json: JSON.stringify(clearCreateCtx(ctx)),
    });
    await sendText(chatId, 'Location creation cancelled.');
    await goMerchantHome(chatId, identity, db);
    return;
  }

  if (!identity.user) {
    await sendText(chatId, 'Account required.');
    return;
  }

  if (conv.state === 'merch_store_name') {
    const name = text.trim();
    if (name.length < 2) {
      await sendText(chatId, 'Name is too short. Enter a location name:');
      return;
    }
    if (name.length > 80) {
      await sendText(chatId, 'Name is too long (max 80). Try again:');
      return;
    }
    updateConversation(db, phone, {
      state: 'merch_store_desc',
      context_json: JSON.stringify({ ...ctx, new_store_name: name }),
    });
    await sendText(
      chatId,
      `Location: *${name}*\nStep 2/5 — Enter a *description*, or reply *-* to skip:`
    );
    return;
  }

  if (conv.state === 'merch_store_desc') {
    const name = String(ctx.new_store_name ?? '').trim();
    if (!name) {
      await sendText(chatId, 'Session expired. Reply *add location* to start again.');
      updateConversation(db, phone, { state: 'idle' });
      return;
    }
    const description =
      lower === '-' || lower === 'skip' || lower === 'none'
        ? null
        : text.trim().slice(0, 500);

    updateConversation(db, phone, {
      state: 'merch_store_cover',
      context_json: JSON.stringify({
        ...ctx,
        new_store_name: name,
        new_store_description: description,
        new_store_banner_url: null,
      }),
    });
    await sendText(
      chatId,
      [
        `Location: *${name}*`,
        `Step 3/5 — Add a *cover image* (optional):`,
        `• Send a photo here`,
        `• Or paste an https image URL`,
        `• Or reply *-* to skip`,
      ].join('\n')
    );
    return;
  }

  if (conv.state === 'merch_store_cover') {
    const name = String(ctx.new_store_name ?? '').trim();
    if (!name) {
      await sendText(chatId, 'Session expired. Reply *add location* to start again.');
      updateConversation(db, phone, { state: 'idle' });
      return;
    }

    let bannerUrl: string | null = null;
    const skip =
      lower === '-' || lower === 'skip' || lower === 'none' || lower === 'no';

    if (!skip) {
      const urlCandidate = text.trim();
      if (/^https?:\/\//i.test(urlCandidate)) {
        bannerUrl = urlCandidate.slice(0, 500);
      } else if (inbound?.hasMedia) {
        const image = await downloadInboundImage(inbound);
        if (!image) {
          await sendText(
            chatId,
            'Could not download that image. Send a photo, paste an https URL, or reply *-* to skip:'
          );
          return;
        }
        bannerUrl = await saveStoreCover(image.buffer, image.ext);
      } else {
        await sendText(
          chatId,
          'Send a *photo*, paste an *https* image URL, or reply *-* to skip:'
        );
        return;
      }
    }

    updateConversation(db, phone, {
      state: 'merch_store_pin',
      context_json: JSON.stringify({
        ...ctx,
        new_store_banner_url: bannerUrl,
        new_store_pickup_lat: null,
        new_store_pickup_lng: null,
        new_store_pickup_address: null,
      }),
    });
    await sendText(
      chatId,
      [
        `Location: *${name}*`,
        `Step 4/5 — Share this location’s *map pin* for logistics (riders collect here).`,
        `Attach → *Location* → send your pin.`,
        `Or reply *-* to skip (you can set it later under Manage locations / Logistics).`,
      ].join('\n')
    );
    return;
  }

  if (conv.state === 'merch_store_pin') {
    const name = String(ctx.new_store_name ?? '').trim();
    if (!name) {
      await sendText(chatId, 'Session expired. Reply *add location* to start again.');
      updateConversation(db, phone, { state: 'idle' });
      return;
    }

    const skip =
      lower === '-' || lower === 'skip' || lower === 'none' || lower === 'no';

    if (!skip && !location) {
      await sendText(
        chatId,
        'Waiting for a WhatsApp *location pin*.\nAttach → Location → Send, or reply *-* to skip.'
      );
      return;
    }

    const nextCtx: Record<string, unknown> = {
      ...ctx,
      new_store_pickup_lat: skip ? null : location!.latitude,
      new_store_pickup_lng: skip ? null : location!.longitude,
      new_store_pickup_address: skip
        ? null
        : location!.description?.slice(0, 200) ?? null,
    };

    updateConversation(db, phone, {
      state: 'merch_store_confirm',
      context_json: JSON.stringify(nextCtx),
    });

    const desc =
      nextCtx.new_store_description == null
        ? '(none)'
        : String(nextCtx.new_store_description);
    const hasCover = Boolean(nextCtx.new_store_banner_url);
    const hasPin =
      nextCtx.new_store_pickup_lat != null &&
      nextCtx.new_store_pickup_lng != null;

    const summary = [
      `*Are you sure?* Create this location:`,
      `*${name}*`,
      `Description: ${desc}`,
      `Cover: ${hasCover ? 'yes (photo)' : 'none'}`,
      `Map pin: ${
        hasPin
          ? `${Number(nextCtx.new_store_pickup_lat).toFixed(5)}, ${Number(nextCtx.new_store_pickup_lng).toFixed(5)}`
          : 'none'
      }`,
      ``,
      `Reply *YES* to create or *NO* to cancel.`,
    ].join('\n');

    await sendCoverPreview(
      chatId,
      nextCtx.new_store_banner_url
        ? String(nextCtx.new_store_banner_url)
        : null,
      summary
    );
    return;
  }

  if (conv.state === 'merch_store_confirm') {
    if (lower === 'no' || lower === 'n') {
      updateConversation(db, phone, {
        state: 'idle',
        context_json: JSON.stringify(clearCreateCtx(ctx)),
      });
      await sendText(chatId, 'Location creation cancelled.');
      await goMerchantHome(chatId, identity, db);
      return;
    }
    if (lower !== 'yes' && lower !== 'y') {
      await sendText(chatId, 'Reply *YES* to create or *NO* to cancel.');
      return;
    }
    await finalizeCreateStore(db, identity, chatId, ctx);
  }
}

async function finalizeCreateStore(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  ctx: Record<string, unknown>
): Promise<void> {
  const phone = identity.phone;
  if (!identity.user) {
    await sendText(chatId, 'Account required.');
    return;
  }

  const name = String(ctx.new_store_name ?? '').trim();
  const description =
    ctx.new_store_description == null
      ? null
      : String(ctx.new_store_description);
  const bannerUrl =
    ctx.new_store_banner_url == null
      ? null
      : String(ctx.new_store_banner_url);
  const lat = ctx.new_store_pickup_lat;
  const lng = ctx.new_store_pickup_lng;
  const address =
    ctx.new_store_pickup_address == null
      ? undefined
      : String(ctx.new_store_pickup_address);

  if (!name) {
    await sendText(chatId, 'Session expired. Reply *add location* to start again.');
    updateConversation(db, phone, { state: 'idle' });
    return;
  }

  const ownedCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM stores WHERE user_id = ? AND IFNULL(is_archived, 0) = 0`
      )
      .get(identity.user.id) as { c: number }
  ).c;
  const plan: SubscriptionPlan = identity.isSuperAdmin ? 'enterprise' : 'starter';
  const features = getPlanFeatures(plan);
  const gate = assertWithinLimit(ownedCount, features.max_stores, 'Stores');
  if (!gate.ok) {
    await sendText(chatId, gate.message);
    updateConversation(db, phone, { state: 'idle' });
    return;
  }

  const storeId = newId('str');
  const ts = nowIso();
  try {
    db.prepare(
      `INSERT INTO stores
        (id, user_id, name, description, banner_url, whatsapp_number, subscription_plan,
         subscription_status, is_archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`
    ).run(
      storeId,
      identity.user.id,
      name,
      description,
      bannerUrl,
      identity.phone,
      plan,
      ts,
      ts
    );

    if (
      typeof lat === 'number' &&
      typeof lng === 'number' &&
      Number.isFinite(lat) &&
      Number.isFinite(lng)
    ) {
      setStorePickupLocation(db, storeId, {
        lat,
        lng,
        address,
      });
    }

    if (identity.user.role !== 'admin') {
      db.prepare(
        `UPDATE users SET role = 'merchant', updated_at = ? WHERE id = ?`
      ).run(ts, identity.user.id);
      identity.user.role = 'merchant';
    }

    writeBotAudit(db, {
      actor_user_id: identity.user.id,
      actor_phone: phone,
      action: 'store_create',
      resource_type: 'store',
      resource_id: storeId,
      details: {
        name,
        plan,
        has_banner: Boolean(bannerUrl),
        has_pickup: typeof lat === 'number',
      },
    });
  } catch (err) {
    console.error('[merchant] create store failed', err);
    await sendText(
      chatId,
      err instanceof Error ? err.message : 'Could not create location.'
    );
    return;
  }

  updateConversation(db, phone, {
    state: 'idle',
    selected_store_id: storeId,
    context_json: JSON.stringify(clearCreateCtx(ctx)),
  });

  if (!identity.ownedStoreIds.includes(storeId)) {
    identity.ownedStoreIds.push(storeId);
  }

  const caption = [
    `*Location created*`,
    `*${name}*`,
    `Plan: ${plan}`,
    `ID: \`${storeId}\``,
    typeof lat === 'number'
      ? `Map pin saved for logistics ✅`
      : `Map pin: not set (add later via Manage locations)`,
    ``,
    `This location is now active.`,
    `Next: reply *add product* to list items for sale.`,
  ].join('\n');

  await sendCoverPreview(chatId, bannerUrl, caption);
  await goMerchantHome(chatId, identity, db);
}

/** Manage locations hub — list / view / edit / archive / switch. */
export async function handleManageLocationsEntry(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  await listManageLocations(db, identity, chatId);
}

export async function continueManageLocations(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  text: string,
  interactiveId: string | undefined,
  inbound?: IncomingWahaMessage,
  location?: { latitude: number; longitude: number; description?: string }
): Promise<boolean> {
  const phone = identity.phone;
  const conv = getOrCreateConversation(db, phone);
  const ctx = getContext(conv);
  const cmd = resolveCommand({
    text,
    interactiveId,
    lastMenu: lastMenu(db, phone),
  });
  const lower = text.trim().toLowerCase();

  if (
    !conv.state.startsWith('merch_loc_') &&
    cmd !== 'merch_locations' &&
    !cmd.startsWith('mloc_') &&
    !cmd.startsWith('locact_')
  ) {
    return false;
  }

  if (lower === 'cancel') {
    updateConversation(db, phone, {
      state: 'idle',
      context_json: JSON.stringify(clearCreateCtx(ctx)),
    });
    await goMerchantHome(chatId, identity, db);
    return true;
  }

  if (cmd === 'merch_locations' || lower === 'manage locations' || lower === 'locations') {
    await listManageLocations(db, identity, chatId);
    return true;
  }

  if (cmd.startsWith('mloc_')) {
    const storeId = cmd.slice('mloc_'.length);
    await showLocationActions(db, identity, chatId, storeId);
    return true;
  }

  if (cmd.startsWith('locact_')) {
    // locact_<action>_<storeId>
    const rest = cmd.slice('locact_'.length);
    const action = rest.split('_')[0] ?? '';
    const storeId = rest.slice(action.length + 1);
    await startLocationAction(db, identity, chatId, storeId, action);
    return true;
  }

  if (conv.state === 'merch_loc_edit_name') {
    await applyEditName(db, identity, chatId, text, lower);
    return true;
  }
  if (conv.state === 'merch_loc_edit_desc') {
    await applyEditDesc(db, identity, chatId, text, lower);
    return true;
  }
  if (conv.state === 'merch_loc_edit_cover') {
    await applyEditCover(db, identity, chatId, text, lower, inbound);
    return true;
  }
  if (conv.state === 'merch_loc_edit_pin') {
    await applyEditPin(db, identity, chatId, lower, location);
    return true;
  }
  if (conv.state === 'merch_loc_archive_confirm') {
    await applyArchiveConfirm(db, identity, chatId, lower);
    return true;
  }
  if (conv.state === 'merch_loc_edit_confirm') {
    await applyEditConfirm(db, identity, chatId, lower);
    return true;
  }

  return false;
}

async function listManageLocations(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  const ids = accessibleStoreIds(identity);
  const rows = ids
    .map((id) => getStore(db, id))
    .filter(
      (s): s is NonNullable<typeof s> =>
        Boolean(s) && !Number(s!.is_archived ?? 0)
    );

  if (rows.length === 0) {
    if (canCreateStore(identity)) {
      await sendText(
        chatId,
        'No locations yet.\nReply *add location* to create one.'
      );
    } else {
      await sendText(chatId, 'No locations assigned to this phone.');
    }
    await goMerchantHome(chatId, identity, db);
    return;
  }

  const options: MenuOption[] = rows.slice(0, 10).map((s) => ({
    id: `mloc_${s.id}`,
    label: s.name.slice(0, 28),
  }));
  options.push({ id: 'merch_home', label: 'Merchant menu' });
  rememberMenu(db, identity.phone, options);
  updateConversation(db, identity.phone, { state: 'merch_loc_list' });
  await sendMenuMessage(
    chatId,
    `*Manage locations*\nPick a location to view, edit, set map pin, change cover, or archive.`,
    options.map((o) => ({ id: o.id, text: o.label }))
  );
}

async function showLocationActions(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string
): Promise<void> {
  const store = getStore(db, storeId);
  if (!store || Number(store.is_archived ?? 0)) {
    await sendText(chatId, 'Location not found.');
    await listManageLocations(db, identity, chatId);
    return;
  }
  if (!accessibleStoreIds(identity).includes(storeId) && !identity.isSuperAdmin) {
    await sendText(chatId, 'No access to that location.');
    return;
  }

  const { isOwner, roles } = rolesForStore(identity, storeId);
  const canEdit = canEditLocation(roles, isOwner, identity.isSuperAdmin);
  const canManage = canManageLocations(roles, isOwner, identity.isSuperAdmin);
  const pickup = getStorePickupLocation(db, storeId);

  const options: MenuOption[] = [
    { id: `locact_switch_${storeId}`, label: 'Make active' },
  ];
  if (canEdit) {
    options.push(
      { id: `locact_name_${storeId}`, label: 'Edit name' },
      { id: `locact_desc_${storeId}`, label: 'Edit description' },
      { id: `locact_cover_${storeId}`, label: 'Change cover' },
      { id: `locact_pin_${storeId}`, label: 'Set map pin' }
    );
  }
  if (canManage) {
    options.push({ id: `locact_archive_${storeId}`, label: 'Archive location' });
  }
  options.push({ id: 'merch_locations', label: 'Back to list' });

  const ctx = getContext(getOrCreateConversation(db, identity.phone));
  updateConversation(db, identity.phone, {
    state: 'merch_loc_actions',
    context_json: JSON.stringify({ ...ctx, manage_store_id: storeId }),
  });
  rememberMenu(db, identity.phone, options);

  const caption = [
    `*${store.name}*`,
    store.description ? store.description.slice(0, 120) : 'No description',
    `Plan: ${store.subscription_plan}`,
    pickup
      ? `Map pin: ${pickup.lat.toFixed(5)}, ${pickup.lng.toFixed(5)}`
      : 'Map pin: not set',
    `ID: \`${store.id}\``,
    ``,
    'Choose an action:',
  ].join('\n');

  await sendCoverPreview(chatId, store.banner_url, caption);
  await sendMenuMessage(
    chatId,
    'Location actions:',
    options.map((o) => ({ id: o.id, text: o.label }))
  );
}

async function startLocationAction(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  storeId: string,
  action: string
): Promise<void> {
  const store = getStore(db, storeId);
  if (!store) {
    await sendText(chatId, 'Location not found.');
    return;
  }
  const { isOwner, roles } = rolesForStore(identity, storeId);
  const ctx = getContext(getOrCreateConversation(db, identity.phone));

  if (action === 'switch') {
    updateConversation(db, identity.phone, {
      selected_store_id: storeId,
      state: 'idle',
    });
    await sendText(chatId, `Active location set to *${store.name}*.`);
    await goMerchantHome(chatId, identity, db);
    return;
  }

  if (action === 'name') {
    if (!canEditLocation(roles, isOwner, identity.isSuperAdmin)) {
      await sendText(chatId, 'You cannot edit this location.');
      return;
    }
    updateConversation(db, identity.phone, {
      state: 'merch_loc_edit_name',
      context_json: JSON.stringify({
        ...ctx,
        manage_store_id: storeId,
        edit_field: 'name',
      }),
    });
    await sendText(
      chatId,
      `Current name: *${store.name}*\nEnter the *new name* (or *cancel*):`
    );
    return;
  }

  if (action === 'desc') {
    if (!canEditLocation(roles, isOwner, identity.isSuperAdmin)) {
      await sendText(chatId, 'You cannot edit this location.');
      return;
    }
    updateConversation(db, identity.phone, {
      state: 'merch_loc_edit_desc',
      context_json: JSON.stringify({
        ...ctx,
        manage_store_id: storeId,
        edit_field: 'description',
      }),
    });
    await sendText(
      chatId,
      `Enter a *new description*, or *-* to clear (or *cancel*):`
    );
    return;
  }

  if (action === 'cover') {
    if (!canEditLocation(roles, isOwner, identity.isSuperAdmin)) {
      await sendText(chatId, 'You cannot edit this location.');
      return;
    }
    updateConversation(db, identity.phone, {
      state: 'merch_loc_edit_cover',
      context_json: JSON.stringify({
        ...ctx,
        manage_store_id: storeId,
        edit_field: 'cover',
      }),
    });
    await sendText(
      chatId,
      'Send a *new cover photo*, paste an https URL, *-* to remove, or *cancel*:'
    );
    return;
  }

  if (action === 'pin') {
    if (!canEditLocation(roles, isOwner, identity.isSuperAdmin)) {
      await sendText(chatId, 'You cannot edit this location.');
      return;
    }
    updateConversation(db, identity.phone, {
      state: 'merch_loc_edit_pin',
      context_json: JSON.stringify({
        ...ctx,
        manage_store_id: storeId,
        edit_field: 'pin',
      }),
    });
    await sendText(
      chatId,
      'Share WhatsApp *Location* pin for this store (logistics pickup), or *cancel*:'
    );
    return;
  }

  if (action === 'archive') {
    if (!canManageLocations(roles, isOwner, identity.isSuperAdmin)) {
      await sendText(chatId, 'Only owners/admins can archive locations.');
      return;
    }
    updateConversation(db, identity.phone, {
      state: 'merch_loc_archive_confirm',
      context_json: JSON.stringify({
        ...ctx,
        manage_store_id: storeId,
      }),
    });
    await sendText(
      chatId,
      `*Are you sure?* Archive *${store.name}*?\nIt will hide from shopping.\nReply *YES* to archive or *NO* to cancel.`
    );
    return;
  }

  await showLocationActions(db, identity, chatId, storeId);
}

async function applyEditName(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  text: string,
  lower: string
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  const storeId = String(ctx.manage_store_id ?? '');
  const name = text.trim();
  if (name.length < 2) {
    await sendText(chatId, 'Name too short. Try again or *cancel*:');
    return;
  }
  updateConversation(db, identity.phone, {
    state: 'merch_loc_edit_confirm',
    context_json: JSON.stringify({
      ...ctx,
      pending_edit_value: name.slice(0, 80),
      edit_field: 'name',
    }),
  });
  await sendText(
    chatId,
    `*Are you sure?* Rename location to *${name.slice(0, 80)}*?\nReply *YES* or *NO*.`
  );
  void lower;
  void storeId;
}

async function applyEditDesc(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  text: string,
  lower: string
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  const description =
    lower === '-' || lower === 'skip' || lower === 'none'
      ? ''
      : text.trim().slice(0, 500);
  updateConversation(db, identity.phone, {
    state: 'merch_loc_edit_confirm',
    context_json: JSON.stringify({
      ...ctx,
      pending_edit_value: description,
      edit_field: 'description',
    }),
  });
  await sendText(
    chatId,
    `*Are you sure?* Update description to:\n${description || '(cleared)'}\nReply *YES* or *NO*.`
  );
}

async function applyEditCover(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  text: string,
  lower: string,
  inbound?: IncomingWahaMessage
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  let bannerUrl: string | null = null;
  const clear =
    lower === '-' || lower === 'skip' || lower === 'none' || lower === 'remove';

  if (!clear) {
    if (/^https?:\/\//i.test(text.trim())) {
      bannerUrl = text.trim().slice(0, 500);
    } else if (inbound?.hasMedia) {
      const image = await downloadInboundImage(inbound);
      if (!image) {
        await sendText(chatId, 'Could not download image. Try again or *cancel*.');
        return;
      }
      bannerUrl = await saveStoreCover(image.buffer, image.ext);
    } else {
      await sendText(
        chatId,
        'Send a photo, https URL, *-* to remove, or *cancel*.'
      );
      return;
    }
  }

  updateConversation(db, identity.phone, {
    state: 'merch_loc_edit_confirm',
    context_json: JSON.stringify({
      ...ctx,
      pending_edit_value: bannerUrl,
      edit_field: 'cover',
    }),
  });

  await sendCoverPreview(
    chatId,
    bannerUrl,
    `*Are you sure?* ${bannerUrl ? 'Update cover to this image?' : 'Remove cover image?'}\nReply *YES* or *NO*.`
  );
}

async function applyEditPin(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  lower: string,
  location?: { latitude: number; longitude: number; description?: string }
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  if (!location) {
    await sendText(
      chatId,
      'Send a WhatsApp *location pin*, or *cancel*.'
    );
    return;
  }
  updateConversation(db, identity.phone, {
    state: 'merch_loc_edit_confirm',
    context_json: JSON.stringify({
      ...ctx,
      pending_edit_value: JSON.stringify({
        lat: location.latitude,
        lng: location.longitude,
        address: location.description ?? null,
      }),
      edit_field: 'pin',
    }),
  });
  await sendText(
    chatId,
    `*Are you sure?* Save map pin ${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)} for logistics?\nReply *YES* or *NO*.`
  );
  void lower;
}

async function applyEditConfirm(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  lower: string
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  const storeId = String(ctx.manage_store_id ?? '');
  const field = String(ctx.edit_field ?? '');

  if (lower === 'no' || lower === 'n') {
    await sendText(chatId, 'Cancelled.');
    await showLocationActions(db, identity, chatId, storeId);
    return;
  }
  if (lower !== 'yes' && lower !== 'y') {
    await sendText(chatId, 'Reply *YES* or *NO*.');
    return;
  }

  const store = getStore(db, storeId);
  if (!store) {
    await sendText(chatId, 'Location not found.');
    return;
  }
  const { isOwner, roles } = rolesForStore(identity, storeId);
  if (!canEditLocation(roles, isOwner, identity.isSuperAdmin)) {
    await sendText(chatId, 'You cannot edit this location.');
    return;
  }

  const ts = nowIso();
  const value = ctx.pending_edit_value;

  if (field === 'name') {
    db.prepare(`UPDATE stores SET name = ?, updated_at = ? WHERE id = ?`).run(
      String(value).slice(0, 80),
      ts,
      storeId
    );
  } else if (field === 'description') {
    db.prepare(
      `UPDATE stores SET description = ?, updated_at = ? WHERE id = ?`
    ).run(String(value) || null, ts, storeId);
  } else if (field === 'cover') {
    db.prepare(
      `UPDATE stores SET banner_url = ?, updated_at = ? WHERE id = ?`
    ).run(value == null ? null : String(value), ts, storeId);
  } else if (field === 'pin') {
    try {
      const pin = JSON.parse(String(value)) as {
        lat: number;
        lng: number;
        address?: string | null;
      };
      setStorePickupLocation(db, storeId, {
        lat: pin.lat,
        lng: pin.lng,
        address: pin.address ?? undefined,
      });
    } catch {
      await sendText(chatId, 'Could not save pin.');
      return;
    }
  }

  writeBotAudit(db, {
    actor_user_id: identity.user?.id,
    actor_phone: identity.phone,
    action: 'store_update',
    resource_type: 'store',
    resource_id: storeId,
    details: { field },
  });

  updateConversation(db, identity.phone, {
    state: 'merch_loc_actions',
    context_json: JSON.stringify({
      ...ctx,
      pending_edit_value: null,
      edit_field: null,
    }),
  });
  await sendText(chatId, 'Location updated ✅');
  await showLocationActions(db, identity, chatId, storeId);
}

async function applyArchiveConfirm(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  lower: string
): Promise<void> {
  const conv = getOrCreateConversation(db, identity.phone);
  const ctx = getContext(conv);
  const storeId = String(ctx.manage_store_id ?? '');

  if (lower === 'no' || lower === 'n') {
    await sendText(chatId, 'Archive cancelled.');
    await showLocationActions(db, identity, chatId, storeId);
    return;
  }
  if (lower !== 'yes' && lower !== 'y') {
    await sendText(chatId, 'Reply *YES* or *NO*.');
    return;
  }

  const { isOwner, roles } = rolesForStore(identity, storeId);
  if (!canManageLocations(roles, isOwner, identity.isSuperAdmin)) {
    await sendText(chatId, 'Not allowed.');
    return;
  }

  const ts = nowIso();
  db.prepare(
    `UPDATE stores SET is_archived = 1, archived_at = ?, updated_at = ? WHERE id = ?`
  ).run(ts, ts, storeId);

  writeBotAudit(db, {
    actor_user_id: identity.user?.id,
    actor_phone: identity.phone,
    action: 'store_archive',
    resource_type: 'store',
    resource_id: storeId,
  });

  const conv2 = getOrCreateConversation(db, identity.phone);
  if (conv2.selected_store_id === storeId) {
    updateConversation(db, identity.phone, { selected_store_id: null });
  }

  updateConversation(db, identity.phone, {
    state: 'idle',
    context_json: JSON.stringify(clearCreateCtx(ctx)),
  });
  await sendText(chatId, 'Location archived.');
  await goMerchantHome(chatId, identity, db);
}
