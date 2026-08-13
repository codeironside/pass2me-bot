import type { Db } from '../../db/client';
import {
  getContext,
  getOrCreateConversation,
  getWalletByUserId,
  updateConversation,
  writeBotAudit,
} from '../../db/repos';
import { formatNgn, kobo, nairaToKobo } from '../../domain/money';
import { newId } from '../../domain/ids';
import { sendMenuMessage, sendText } from '../../services/whatsapp';
import { applyLedgerEntry } from '../../services/wallet';
import type { ResolvedIdentity } from '../identity';
import { resolveCommand, type MenuOption } from '../command';

const DEV_MENU: MenuOption[] = [
  { id: 'dev_lookup_user', label: 'Lookup user' },
  { id: 'dev_lookup_order', label: 'Lookup order' },
  { id: 'dev_ledger', label: 'View ledger' },
  { id: 'dev_credit', label: 'Manual credit' },
  { id: 'mode_customer', label: 'Customer mode' },
  { id: 'mode_merchant', label: 'Merchant mode' },
];

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

export async function sendDeveloperHome(
  chatId: string,
  identity: ResolvedIdentity,
  db?: Db
): Promise<void> {
  if (db) rememberMenu(db, identity.phone, DEV_MENU);
  await sendMenuMessage(
    chatId,
    `*Developer backroom* (level ${identity.developerLevel}${identity.isSuperAdmin ? ' · superadmin' : ''})\nPrivileged ops — use carefully.`,
    DEV_MENU.map((o) => ({ id: o.id, text: o.label }))
  );
}

export async function handleDeveloperMessage(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  text: string,
  interactiveId?: string
): Promise<void> {
  if (!identity.isDeveloper) {
    await sendText(chatId, 'Developer access required.');
    return;
  }

  const cmd = resolveCommand({
    text,
    interactiveId,
    lastMenu: lastMenu(db, identity.phone),
  });
  const lower = text.trim().toLowerCase();

  if (
    cmd === 'dev_home' ||
    lower === 'dev' ||
    lower === 'backroom' ||
    lower === 'menu' ||
    lower === 'help'
  ) {
    await sendDeveloperHome(chatId, identity, db);
    return;
  }

  // Mode switches are normally handled in the router; keep aliases here as backup
  if (cmd === 'mode_customer' || lower === 'customer') {
    updateConversation(db, identity.phone, { mode: 'customer', state: 'idle' });
    const { sendCustomerHome } = await import('./customer');
    await sendCustomerHome(db, chatId, identity);
    return;
  }
  if (cmd === 'mode_merchant' || lower === 'merchant') {
    const { canAccessMerchant } = await import('../identity');
    if (!canAccessMerchant(identity)) {
      await sendText(chatId, 'No merchant access on this phone.');
      return;
    }
    updateConversation(db, identity.phone, { mode: 'merchant', state: 'idle' });
    const { sendMerchantHome } = await import('./merchant');
    await sendMerchantHome(chatId, identity, db);
    return;
  }

  if (cmd === 'dev_lookup_user' || lower.startsWith('user ')) {
    const phoneOrId =
      cmd === 'dev_lookup_user' && !lower.startsWith('user ')
        ? null
        : text.trim().replace(/^user\s+/i, '');
    if (!phoneOrId) {
      await sendText(chatId, 'Send: user <phone_or_id>');
      return;
    }
    const user =
      (db
        .prepare('SELECT * FROM users WHERE id = ? OR phone LIKE ? LIMIT 1')
        .get(phoneOrId, `%${phoneOrId.slice(-10)}`) as
        | {
            id: string;
            email: string;
            phone: string | null;
            role: string;
            status: string;
          }
        | undefined) ?? undefined;
    if (!user) {
      await sendText(chatId, 'User not found.');
      return;
    }
    const wallet = getWalletByUserId(db, user.id);
    await sendText(
      chatId,
      [
        `*User* ${user.id}`,
        `Email: ${user.email}`,
        `Phone: ${user.phone ?? '—'}`,
        `Role: ${user.role} / ${user.status}`,
        wallet
          ? `Wallet: ${formatNgn(kobo(wallet.balance_kobo))} (${wallet.status})`
          : 'Wallet: none',
      ].join('\n')
    );
    return;
  }

  if (cmd === 'dev_lookup_order' || lower.startsWith('order ')) {
    const orderNo =
      cmd === 'dev_lookup_order' && !lower.startsWith('order ')
        ? null
        : text.trim().replace(/^order\s+/i, '');
    if (!orderNo) {
      await sendText(chatId, 'Send: order <order_number>');
      return;
    }
    const order = db
      .prepare('SELECT * FROM orders WHERE order_number = ? OR id = ?')
      .get(orderNo, orderNo) as
      | {
          id: string;
          order_number: string;
          status: string;
          payment_status: string;
          total_amount: number | string;
          store_id: string;
        }
      | undefined;
    if (!order) {
      await sendText(chatId, 'Order not found.');
      return;
    }
    await sendText(
      chatId,
      [
        `*Order* ${order.order_number}`,
        `ID: ${order.id}`,
        `Store: ${order.store_id}`,
        `Status: ${order.status}/${order.payment_status}`,
        `Total: ${order.total_amount}`,
      ].join('\n')
    );
    return;
  }

  if (cmd === 'dev_ledger' || lower.startsWith('ledger ')) {
    const userId =
      cmd === 'dev_ledger' && !lower.startsWith('ledger ')
        ? identity.user?.id
        : text.trim().replace(/^ledger\s+/i, '');
    if (!userId) {
      await sendText(chatId, 'Send: ledger <user_id>');
      return;
    }
    const wallet = getWalletByUserId(db, userId);
    if (!wallet) {
      await sendText(chatId, 'No wallet.');
      return;
    }
    const txs = db
      .prepare(
        `SELECT direction, amount_kobo, type, balance_after_kobo, created_at
         FROM wallet_transactions WHERE wallet_id = ?
         ORDER BY created_at DESC LIMIT 10`
      )
      .all(wallet.id) as Array<{
      direction: string;
      amount_kobo: number;
      type: string;
      balance_after_kobo: number;
      created_at: string;
    }>;
    const lines = txs.map(
      (t) =>
        `• ${t.created_at.slice(0, 19)} ${t.direction} ${formatNgn(kobo(t.amount_kobo))} ${t.type} → ${formatNgn(kobo(t.balance_after_kobo))}`
    );
    await sendText(chatId, lines.join('\n') || 'No transactions.');
    return;
  }

  if (cmd === 'dev_credit' || lower.startsWith('credit ')) {
    const access = db
      .prepare(
        `SELECT can_manual_credit FROM developer_access WHERE user_id = ?`
      )
      .get(identity.user?.id ?? '') as
      | { can_manual_credit: number }
      | undefined;

    const allowed =
      identity.isSuperAdmin ||
      (access?.can_manual_credit ?? 0) === 1 ||
      identity.developerLevel >= 4;
    if (!allowed) {
      await sendText(chatId, 'Manual credit not permitted at your level.');
      return;
    }

    if (cmd === 'dev_credit' && !lower.startsWith('credit ')) {
      await sendText(chatId, 'Send: credit <user_id> <amount_naira>');
      return;
    }

    const parts = text.trim().split(/\s+/);
    const userId = parts[1];
    const amountRaw = parts[2];
    if (!userId || !amountRaw) {
      await sendText(chatId, 'Usage: credit <user_id> <amount_naira>');
      return;
    }

    try {
      const amount = nairaToKobo(amountRaw);
      applyLedgerEntry(db, {
        userId,
        direction: 'credit',
        amount,
        type: 'manual_credit',
        idempotencyKey: `manual_credit_${newId()}`,
        actorUserId: identity.user?.id,
        actorPhone: identity.phone,
        metadata: { developer_level: identity.developerLevel },
      });
      writeBotAudit(db, {
        actor_user_id: identity.user?.id,
        actor_phone: identity.phone,
        action: 'manual_credit',
        resource_type: 'wallet',
        resource_id: userId,
        details: { amount_kobo: amount },
      });
      await sendText(chatId, `Credited ${formatNgn(amount)} to ${userId}`);
    } catch (err) {
      await sendText(
        chatId,
        err instanceof Error ? err.message : 'Credit failed'
      );
    }
    return;
  }

  await sendText(
    chatId,
    'Pick a developer option by *number* or name, or reply *menu*.'
  );
  await sendDeveloperHome(chatId, identity, db);
}
