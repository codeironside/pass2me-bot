import type { Db } from '../db/client';
import {
  chatIdToPhone,
  isGroupChatId,
  phoneToWahaChatId,
  shouldIgnoreChatId,
  newId,
} from '../domain/ids';
import {
  getContext,
  getOrCreateConversation,
  updateConversation,
} from '../db/repos';
import {
  resolvePhoneFromChatId,
  sendSeen,
  sendText,
  type IncomingWahaMessage,
} from '../services/whatsapp';
import { onFirstTouch, resolveIdentity, canAccessMerchant } from './identity';
import { handleCustomerMessage, sendCustomerHome } from './flows/customer';
import { handleMerchantMessage, sendMerchantHome } from './flows/merchant';
import {
  handleDeveloperMessage,
  sendDeveloperHome,
} from './flows/developer';
import {
  handleWalletMessage,
  maybeTriggerAutoTopup,
} from './flows/wallet';
import { handleAirtimeMessage } from './flows/airtime';
import { verifyOtp } from '../services/sms';
import {
  isRestartHomeCommand,
  isWebsiteSignupContinue,
  resolveCommand,
  type MenuOption,
} from './command';

function conversationLastMenu(db: Db, phone: string): MenuOption[] {
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

/** Entry point for Baileys inbound messages */
export async function handleIncomingWhatsAppMessage(
  db: Db,
  msg: IncomingWahaMessage
): Promise<void> {
  console.log(
    `[WA] msg from=${msg.from} fromMe=${msg.fromMe} body=${JSON.stringify(msg.body ?? '')} id=${msg.id}`
  );
  await handleIncomingMessage(db, msg);
}

async function handleIncomingMessage(
  db: Db,
  msg: IncomingWahaMessage
): Promise<void> {
  if (msg.fromMe) return;

  const chatId = msg.from.includes('@')
    ? msg.from
    : phoneToWahaChatId(msg.from);

  if (shouldIgnoreChatId(chatId) || isGroupChatId(chatId)) {
    console.log(`[WA] ignored non-chat source: ${chatId}`);
    return;
  }

  // Prefer real MSISDN (resolve @lid via Baileys). Keep chatId for replies.
  const resolved =
    (await resolvePhoneFromChatId(db, chatId)) ?? chatIdToPhone(chatId);
  if (!resolved) {
    console.warn(`[WA] could not resolve phone for ${chatId}`);
    return;
  }
  const phone = resolved;
  console.log(`[WA] identity phone=${phone} chatId=${chatId}`);

  const text = (msg.body ?? '').trim();
  const interactiveId = msg.buttonOrListId;

  // Deduplicate by message id (use full id in resource_id)
  const seen = db
    .prepare(
      `SELECT id FROM bot_audit_logs WHERE action = 'wa_message' AND resource_id = ? LIMIT 1`
    )
    .get(msg.id) as { id: string } | undefined;
  if (seen) {
    console.log(`[WA] duplicate message skipped: ${msg.id}`);
    return;
  }

  db.prepare(
    `INSERT INTO bot_audit_logs (id, actor_phone, action, resource_type, resource_id, details, created_at)
     VALUES (?, ?, 'wa_message', 'whatsapp_message', ?, ?, datetime('now'))`
  ).run(
    newId('msg'),
    phone,
    msg.id,
    JSON.stringify({ text, interactiveId })
  );

  let identity = await onFirstTouch(db, phone);
  getOrCreateConversation(db, phone);

  // Manual link when @lid cannot resolve: "link 0813..."
  if (text.toLowerCase().startsWith('link ')) {
    const rawPhone = text.slice(5).trim();
    const { normalizePhone: norm } = await import('../domain/ids');
    const linkPhone = norm(rawPhone);
    const user = (
      await import('../db/repos')
    ).findUserByPhone(db, linkPhone);
    if (!user) {
      await sendText(
        chatId,
        'No Pas2me account found for that phone. Sign up at https://www.pas2me.com first.'
      );
      return;
    }
    if (chatId.endsWith('@lid')) {
      db.prepare(
        `INSERT INTO whatsapp_lid_map (id, lid, phone, chat_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(lid) DO UPDATE SET phone = excluded.phone, updated_at = datetime('now')`
      ).run(newId('lid'), chatId, linkPhone, chatId);
    }
    identity = await onFirstTouch(db, linkPhone);
    updateConversation(db, linkPhone, {
      user_id: user.id,
      mode: 'customer',
    });
    await sendText(
      chatId,
      `Linked to *${user.first_name} ${user.last_name}*. Reply *hi* for your account menu.`
    );
    await sendCustomerHome(db, chatId, identity);
    return;
  }

  // Double blue ticks before reply (ban-safer on unofficial engines)
  await sendSeen(chatId);

  // hi / hello / start / menu — drop any in-progress flow and open home
  if (isRestartHomeCommand(text, interactiveId)) {
    updateConversation(db, phone, {
      mode: 'customer',
      state: 'idle',
      context_json: '{}',
    });
    await sendCustomerHome(db, chatId, identity);
    return;
  }

  // Quantity / typed replies must not be treated as a numbered menu pick
  const convEarly = getOrCreateConversation(db, phone);
  const typedInputState =
    convEarly.state === 'awaiting_cart_qty' ||
    convEarly.state === 'merch_inv_sell_qty' ||
    convEarly.state === 'merch_inv_sell_phone' ||
    convEarly.state === 'merch_inv_receive' ||
    convEarly.state === 'merch_inv_set' ||
    convEarly.state === 'merch_inv_edit_price';
  if (typedInputState && /^\d{1,15}$/.test(text.trim()) && !interactiveId) {
    if (convEarly.state.startsWith('merch_inv_')) {
      await handleMerchantMessage(
        db,
        identity,
        chatId,
        text,
        interactiveId,
        msg.location,
        msg
      );
      return;
    }
    await handleCustomerMessage(
      db,
      identity,
      chatId,
      text,
      interactiveId,
      msg.location
    );
    return;
  }

  // Resolve numbered picks against last menu so mode switches work (e.g. Dev menu → 6)
  const menuCmd = resolveCommand({
    text,
    interactiveId,
    lastMenu: conversationLastMenu(db, phone),
  });

  // Mode switches
  if (
    menuCmd === 'mode_customer' ||
    interactiveId === 'mode_customer' ||
    text.toLowerCase() === 'customer'
  ) {
    updateConversation(db, phone, { mode: 'customer', state: 'idle' });
    await sendCustomerHome(db, chatId, identity);
    return;
  }
  if (
    menuCmd === 'mode_merchant' ||
    interactiveId === 'mode_merchant' ||
    text.toLowerCase() === 'merchant'
  ) {
    identity = resolveIdentity(db, phone);
    if (!canAccessMerchant(identity)) {
      await sendText(
        chatId,
        'Sign up at https://www.pas2me.com with this WhatsApp number to sell and create a store.'
      );
      return;
    }
    // Drop wallet/airtime collection so merchant menu numbers aren't stolen
    updateConversation(db, phone, { mode: 'merchant', state: 'idle' });
    await sendMerchantHome(chatId, identity, db);
    return;
  }
  if (
    menuCmd === 'mode_developer' ||
    interactiveId === 'mode_developer' ||
    text.toLowerCase() === 'dev'
  ) {
    identity = resolveIdentity(db, phone);
    if (!identity.isDeveloper) {
      await sendText(chatId, 'Developer access required.');
      return;
    }
    updateConversation(db, phone, { mode: 'developer', state: 'idle' });
    await sendDeveloperHome(chatId, identity, db);
    return;
  }

  // OTP verify command: verify 123456
  if (text.toLowerCase().startsWith('verify ')) {
    const code = text.slice(7).trim();
    const result = verifyOtp(db, phone, 'link_phone', code);
    if (!result.ok) {
      await sendText(chatId, result.message);
      return;
    }
    await sendText(chatId, 'Phone verified.');
    identity = await onFirstTouch(db, phone);
  }

  const conv = getOrCreateConversation(db, phone);

  // Airtime / wallet stateful handlers â€” registered only
  if (identity.user) {
    if (await handleAirtimeMessage(db, identity, chatId, text)) return;
    if (await handleWalletMessage(db, identity, chatId, text, interactiveId))
      return;
  } else if (
    text.toLowerCase() === 'wallet' ||
    text.toLowerCase() === 'airtime' ||
    interactiveId === 'wal_topup' ||
    interactiveId === 'wal_airtime'
  ) {
    await sendText(
      chatId,
      'Wallet and airtime need a Pas2me account. Sign up at https://www.pas2me.com'
    );
    return;
  }

  // Location / media-only messages still need to reach checkout / merchant flows
  if (!text && !interactiveId && !msg.location && !msg.hasMedia) {
    return;
  }

  if (isWebsiteSignupContinue(text)) {
    const first = identity.user?.first_name?.trim();
    const greeting = first ? `Hi *${first}* 👋` : 'Hi 👋';
    if (identity.user) {
      await sendText(
        chatId,
        [
          greeting,
          '',
          'Welcome to *Pas2me*. Your account is linked to this WhatsApp.',
          '',
          'You can browse the marketplace, manage your cart, check orders, and use your wallet right here.',
          '',
          'Pick an option below to get started — or just say what you need.',
        ].join('\n')
      );
    } else {
      await sendText(
        chatId,
        [
          greeting,
          '',
          'Welcome to *Pas2me*. Glad you made it over from the website.',
          '',
          'To unlock cart, checkout, wallet, and orders, this WhatsApp number should match the phone on your account.',
          '',
          'If you signed up with a different number, reply:',
          '*link 08XXXXXXXXXX*',
          '',
          'You can still open *marketplace* and *search* as a guest.',
        ].join('\n')
      );
    }
    await sendCustomerHome(db, chatId, identity);
    return;
  }

  const mode = conv.mode || identity.mode;

  if (mode === 'developer') {
    await handleDeveloperMessage(db, identity, chatId, text, interactiveId);
  } else if (mode === 'merchant') {
    await handleMerchantMessage(
      db,
      identity,
      chatId,
      text,
      interactiveId,
      msg.location,
      msg
    );
  } else {
    await handleCustomerMessage(
      db,
      identity,
      chatId,
      text,
      interactiveId,
      msg.location
    );
  }

  if (identity.user) {
    const tip = await maybeTriggerAutoTopup(db, identity.user.id, phone);
    if (tip) await sendText(chatId, tip);
  }
}
