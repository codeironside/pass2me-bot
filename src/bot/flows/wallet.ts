import type { Db } from '../../db/client';
import {
  findUserById,
  findUserByPhone,
  getContext,
  getOrCreateConversation,
  getWalletByUserId,
  updateConversation,
  type WalletRow,
} from '../../db/repos';
import { formatNgn, kobo, koboToNairaString, nairaToKobo } from '../../domain/money';
import { newId, normalizePhone, phoneToWahaChatId } from '../../domain/ids';
import { getEnv } from '../../config/env';
import { sendMenuMessage, sendText } from '../../services/whatsapp';
import {
  createCheckout,
  initiateSingleDisbursement,
  listMonnifyBanks,
  validateBankAccount,
  type MonnifyBank,
} from '../../services/monnify';
import {
  getReadyWallet,
  provisionMonnifyWallet,
} from '../../services/monnifyWallet';
import {
  applyLedgerEntry,
  transferToUserWallet,
} from '../../services/wallet';
import type { ResolvedIdentity } from '../identity';
import { resolveCommand, type MenuOption } from '../command';

const WALLET_MENU: MenuOption[] = [
  { id: 'wal_topup', label: 'Top up' },
  { id: 'wal_send', label: 'Send money' },
  { id: 'wal_auto', label: 'Auto top-up' },
  { id: 'wal_airtime', label: 'Buy airtime' },
  { id: 'wal_withdraw', label: 'Withdraw' },
  { id: 'cust_home', label: 'Main menu' },
];

const SEND_MENU: MenuOption[] = [
  { id: 'wal_send_p2p', label: 'To Pas2me user' },
  { id: 'wal_send_bank', label: 'To bank account' },
  { id: 'wal_menu_back', label: 'Back to wallet' },
];

const MIN_SEND_KOBO = 10_000; // ₦100

const KYC_PROMPT = [
  `To create your Pas2me wallet we need your *BVN* or *NIN* (required by Monnify).`,
  ``,
  `Reply with one of:`,
  `• *BVN* 12345678901`,
  `• *NIN* 12345678901`,
].join('\n');

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

async function showSendMenu(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  rememberMenu(db, identity.phone, SEND_MENU);
  updateConversation(db, identity.phone, { state: 'wallet_send_menu' });
  await sendMenuMessage(
    chatId,
    'Send money from your Pas2me wallet:',
    SEND_MENU.map((o) => ({ id: o.id, text: o.label }))
  );
}

function filterBanks(banks: MonnifyBank[], query: string): MonnifyBank[] {
  const q = query.trim().toLowerCase();
  if (!q) return banks.slice(0, 10);
  return banks
    .filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.code.includes(q) ||
        b.name.toLowerCase().replace(/\s+/g, '').includes(q.replace(/\s+/g, ''))
    )
    .slice(0, 10);
}

function formatWalletBody(wallet: WalletRow): string {
  const locked = Number(wallet.locked_kobo ?? 0);
  const available = Math.max(0, wallet.balance_kobo - locked);
  const lines = [
    `*Wallet*`,
    `Available: ${formatNgn(kobo(available))}`,
    locked > 0 ? `Locked (pending delivery): ${formatNgn(kobo(locked))}` : '',
    `Status: ${wallet.status}`,
    `Bank account: *${wallet.monnify_account_number}*`,
  ].filter(Boolean);
  if (wallet.monnify_account_reference) {
    lines.push(`Reference: ${wallet.monnify_account_reference}`);
  }
  lines.push('Transfer to this account to fund your wallet.');
  return lines.join('\n');
}

function parseKycInput(
  text: string
): { bvn?: string; nin?: string } | { error: string } {
  const trimmed = text.trim();
  const labeled = /^(bvn|nin)\s*[:=\-]?\s*(\d{11})$/i.exec(trimmed);
  if (labeled) {
    const kind = labeled[1]!.toLowerCase();
    const value = labeled[2]!;
    return kind === 'bvn' ? { bvn: value } : { nin: value };
  }

  // Bare 11 digits — ask them to label it
  if (/^\d{11}$/.test(trimmed)) {
    return {
      error:
        'Please specify which ID that is.\nReply *BVN 12345678901* or *NIN 12345678901*.',
    };
  }

  return {
    error:
      'Invalid format. Reply *BVN 12345678901* or *NIN 12345678901* (11 digits).',
  };
}

export async function promptWalletKyc(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  updateConversation(db, identity.phone, { state: 'wallet_await_kyc' });
  await sendText(chatId, KYC_PROMPT);
}

/** Returns a Monnify-backed wallet, or prompts for BVN/NIN and returns null. */
export async function requireReadyWalletOrPromptKyc(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<WalletRow | null> {
  if (!identity.user) {
    await sendText(
      chatId,
      'No Pas2me account is linked to this phone yet. Register on pas2me.com first, then message the bot again.'
    );
    return null;
  }

  const ready = getReadyWallet(db, identity.user.id);
  if (ready) return ready;

  const result = await provisionMonnifyWallet(
    db,
    identity.user.id,
    identity.phone,
    {
      customerName: `${identity.user.first_name} ${identity.user.last_name}`.trim(),
    }
  );

  if (result.status === 'ready') return result.wallet;
  if (result.status === 'needs_kyc') {
    await promptWalletKyc(db, identity, chatId);
    return null;
  }
  if (result.status === 'unconfigured') {
    await sendText(
      chatId,
      'Wallet creation is temporarily unavailable (Monnify not configured). Please try again later.'
    );
    return null;
  }

  await sendText(chatId, result.message);
  await promptWalletKyc(db, identity, chatId);
  return null;
}

export async function handleWalletMenu(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string
): Promise<void> {
  const wallet = await requireReadyWalletOrPromptKyc(db, identity, chatId);
  if (!wallet) return;

  rememberMenu(db, identity.phone, WALLET_MENU);
  updateConversation(db, identity.phone, { state: 'wallet_menu' });
  await sendMenuMessage(
    chatId,
    formatWalletBody(wallet),
    WALLET_MENU.map((o) => ({ id: o.id, text: o.label }))
  );
}

export async function handleWalletMessage(
  db: Db,
  identity: ResolvedIdentity,
  chatId: string,
  text: string,
  interactiveId?: string
): Promise<boolean> {
  if (!identity.user) return false;

  const conv = getOrCreateConversation(db, identity.phone);
  const cmd = resolveCommand({
    text,
    interactiveId,
    lastMenu: lastMenu(db, identity.phone),
  });
  const lower = text.trim().toLowerCase();

  // Never steal merchant/developer menu numbers while those modes are active,
  // unless the user is mid wallet KYC / send / top-up collection.
  const midWalletFlow =
    conv.state === 'wallet_await_kyc' ||
    (conv.state.startsWith('wallet_') && conv.state !== 'wallet_menu');
  if (
    (conv.mode === 'merchant' || conv.mode === 'developer') &&
    !midWalletFlow &&
    lower !== 'wallet' &&
    cmd !== 'cust_wallet' &&
    !cmd.startsWith('wal_')
  ) {
    return false;
  }

  // KYC collection for Monnify VA
  if (conv.state === 'wallet_await_kyc') {
    if (cmd === 'cust_home' || lower === 'menu' || lower === 'cancel') {
      updateConversation(db, identity.phone, { state: 'idle' });
      const { sendCustomerHome } = await import('./customer');
      await sendCustomerHome(db, chatId, identity);
      return true;
    }

    const parsed = parseKycInput(text);
    if ('error' in parsed) {
      await sendText(chatId, parsed.error);
      return true;
    }

    await sendText(chatId, 'Creating your Monnify wallet…');
    const result = await provisionMonnifyWallet(
      db,
      identity.user.id,
      identity.phone,
      {
        customerName: `${identity.user.first_name} ${identity.user.last_name}`.trim(),
        bvn: parsed.bvn,
        nin: parsed.nin,
      }
    );

    if (result.status === 'ready') {
      await sendText(
        chatId,
        `Wallet ready.\nBank account: *${result.wallet.monnify_account_number}*`
      );
      await handleWalletMenu(db, identity, chatId);
      return true;
    }

    if (result.status === 'needs_kyc') {
      await promptWalletKyc(db, identity, chatId);
      return true;
    }

    if (result.status === 'unconfigured') {
      updateConversation(db, identity.phone, { state: 'idle' });
      await sendText(
        chatId,
        'Wallet creation is temporarily unavailable (Monnify not configured).'
      );
      return true;
    }

    await sendText(chatId, `${result.message}\n\n${KYC_PROMPT}`);
    return true;
  }

  // Only claim numeric picks when we're in a wallet submenu / wallet last_menu
  const menu = lastMenu(db, identity.phone);
  const inWalletMenu =
    conv.state.startsWith('wallet_') ||
    menu.some((m) => m.id.startsWith('wal_'));

  if (/^\d+$/.test(lower) && !inWalletMenu && !interactiveId) {
    return false;
  }

  if (cmd === 'cust_home') {
    updateConversation(db, identity.phone, { state: 'idle' });
    const { sendCustomerHome } = await import('./customer');
    await sendCustomerHome(db, chatId, identity);
    return true;
  }

  if (cmd === 'wal_topup' || lower === 'topup' || lower === 'top up') {
    if (!(await requireReadyWalletOrPromptKyc(db, identity, chatId))) return true;
    updateConversation(db, identity.phone, { state: 'wallet_topup_amount' });
    await sendText(chatId, 'Enter top-up amount in Naira (e.g. 5000):');
    return true;
  }

  if (
    cmd === 'wal_send' ||
    lower === 'send' ||
    lower === 'send money' ||
    lower === 'transfer'
  ) {
    if (!(await requireReadyWalletOrPromptKyc(db, identity, chatId))) return true;
    await showSendMenu(db, identity, chatId);
    return true;
  }

  if (cmd === 'wal_menu_back' || (conv.state === 'wallet_send_menu' && lower === 'back')) {
    await handleWalletMenu(db, identity, chatId);
    return true;
  }

  if (conv.state === 'wallet_send_menu') {
    if (cmd === 'wal_send_p2p' || lower.includes('pas2me') || lower === '1') {
      updateConversation(db, identity.phone, { state: 'wallet_send_p2p_phone' });
      await sendText(
        chatId,
        'Enter the recipient’s Pas2me phone number (e.g. 0813… or 234…).'
      );
      return true;
    }
    if (cmd === 'wal_send_bank' || lower.includes('bank') || lower === '2') {
      updateConversation(db, identity.phone, { state: 'wallet_send_bank_search' });
      await sendText(
        chatId,
        'Type the bank name to search (e.g. *opay*, *access*, *providus*).'
      );
      return true;
    }
    await showSendMenu(db, identity, chatId);
    return true;
  }

  // --- P2P: phone → amount → confirm ---
  if (conv.state === 'wallet_send_p2p_phone') {
    if (lower === 'cancel') {
      await handleWalletMenu(db, identity, chatId);
      return true;
    }
    const phone = normalizePhone(text.trim());
    if (phone.length < 10) {
      await sendText(chatId, 'Invalid phone. Example: 08134481508');
      return true;
    }
    if (phone === identity.phone || phone.endsWith(identity.phone.slice(-10))) {
      await sendText(chatId, 'You cannot send money to yourself.');
      return true;
    }
    const recipient = findUserByPhone(db, phone);
    if (!recipient) {
      await sendText(
        chatId,
        'No Pas2me account found for that phone. They must register at https://www.pas2me.com first.'
      );
      return true;
    }
    if (!getReadyWallet(db, recipient.id)) {
      await sendText(
        chatId,
        'That user has not set up a Pas2me wallet yet (needs BVN/NIN).'
      );
      return true;
    }
    const ctx = getContext(conv);
    updateConversation(db, identity.phone, {
      state: 'wallet_send_p2p_amount',
      context_json: JSON.stringify({
        ...ctx,
        send_to_user_id: recipient.id,
        send_to_phone: phone,
        send_to_name: `${recipient.first_name} ${recipient.last_name}`.trim(),
      }),
    });
    await sendText(
      chatId,
      `Sending to *${recipient.first_name} ${recipient.last_name}* (${phone}).\nEnter amount in Naira (min 100):`
    );
    return true;
  }

  if (conv.state === 'wallet_send_p2p_amount') {
    let amount;
    try {
      amount = nairaToKobo(text.trim());
    } catch {
      await sendText(chatId, 'Invalid amount. Example: 500');
      return true;
    }
    if (Number(amount) < MIN_SEND_KOBO) {
      await sendText(chatId, 'Minimum send is ₦100.');
      return true;
    }
    const ctx = getContext(conv);
    const name = String(ctx.send_to_name ?? 'recipient');
    updateConversation(db, identity.phone, {
      state: 'wallet_send_p2p_confirm',
      context_json: JSON.stringify({
        ...ctx,
        send_amount_kobo: Number(amount),
      }),
    });
    await sendText(
      chatId,
      `Confirm send *${formatNgn(amount)}* to *${name}*?\nReply *YES* to send or *NO* to cancel.`
    );
    return true;
  }

  if (conv.state === 'wallet_send_p2p_confirm') {
    if (lower === 'no' || lower === 'cancel') {
      await sendText(chatId, 'Transfer cancelled.');
      await handleWalletMenu(db, identity, chatId);
      return true;
    }
    if (lower !== 'yes' && lower !== 'y') {
      await sendText(chatId, 'Reply *YES* to send or *NO* to cancel.');
      return true;
    }
    const ctx = getContext(conv);
    const toUserId = String(ctx.send_to_user_id ?? '');
    const toPhone = String(ctx.send_to_phone ?? '');
    const toName = String(ctx.send_to_name ?? 'User');
    const amountKobo = Number(ctx.send_amount_kobo ?? 0);
    if (!toUserId || amountKobo < MIN_SEND_KOBO) {
      await sendText(chatId, 'Transfer session expired. Start again with *send*.');
      await handleWalletMenu(db, identity, chatId);
      return true;
    }
    const transferId = newId('p2p');
    try {
      transferToUserWallet(db, {
        fromUserId: identity.user.id,
        toUserId,
        amount: kobo(amountKobo),
        idempotencyKey: transferId,
        actorPhone: identity.phone,
      });
      updateConversation(db, identity.phone, {
        state: 'wallet_menu',
        context_json: JSON.stringify({
          ...ctx,
          send_to_user_id: null,
          send_to_phone: null,
          send_to_name: null,
          send_amount_kobo: null,
        }),
      });
      await sendText(
        chatId,
        `Sent *${formatNgn(kobo(amountKobo))}* to *${toName}*.\nRef: ${transferId}`
      );
      if (toPhone) {
        const fromName =
          `${identity.user.first_name} ${identity.user.last_name}`.trim();
        void sendText(
          phoneToWahaChatId(toPhone),
          [
            `*You received money*`,
            `From: ${fromName}`,
            `Amount: ${formatNgn(kobo(amountKobo))}`,
            `Ref: ${transferId}`,
            ``,
            `Reply *wallet* to see your balance.`,
          ].join('\n')
        ).catch((err) => console.error('[wallet] p2p notify failed', err));
      }
      await handleWalletMenu(db, identity, chatId);
    } catch (err) {
      await sendText(
        chatId,
        err instanceof Error ? err.message : 'Transfer failed'
      );
    }
    return true;
  }

  // --- Bank: search → pick → account → name → amount → confirm ---
  if (conv.state === 'wallet_send_bank_search') {
    if (lower === 'cancel') {
      await handleWalletMenu(db, identity, chatId);
      return true;
    }
    await sendText(chatId, 'Looking up banks…');
    const banks = await listMonnifyBanks();
    if (banks.length === 0) {
      await sendText(
        chatId,
        'Could not load banks from Monnify. Try again later or ask support to enable disbursements.'
      );
      await handleWalletMenu(db, identity, chatId);
      return true;
    }
    const matches = filterBanks(banks, text);
    if (matches.length === 0) {
      await sendText(chatId, 'No banks matched. Try another name (e.g. *gtb*, *opay*).');
      return true;
    }
    const options: MenuOption[] = matches.map((b) => ({
      id: `bank_${b.code}`,
      label: `${b.name} (${b.code})`,
    }));
    const ctx = getContext(conv);
    updateConversation(db, identity.phone, {
      state: 'wallet_send_bank_pick',
      context_json: JSON.stringify({
        ...ctx,
        send_bank_choices: matches,
        last_menu: options,
      }),
    });
    rememberMenu(db, identity.phone, options);
    await sendMenuMessage(
      chatId,
      'Pick a bank:',
      options.map((o) => ({ id: o.id, text: o.label }))
    );
    return true;
  }

  if (conv.state === 'wallet_send_bank_pick') {
    const ctx = getContext(conv);
    const choices = (ctx.send_bank_choices as MonnifyBank[] | undefined) ?? [];
    let picked: MonnifyBank | undefined;
    if (cmd.startsWith('bank_')) {
      const code = cmd.slice('bank_'.length);
      picked = choices.find((b) => b.code === code);
    } else if (/^\d+$/.test(lower)) {
      const idx = Number(lower) - 1;
      picked = choices[idx];
    }
    if (!picked) {
      await sendText(chatId, 'Pick a bank from the list, or reply *cancel*.');
      return true;
    }
    updateConversation(db, identity.phone, {
      state: 'wallet_send_bank_account',
      context_json: JSON.stringify({
        ...ctx,
        send_bank_code: picked.code,
        send_bank_name: picked.name,
      }),
    });
    await sendText(
      chatId,
      `Bank: *${picked.name}*\nEnter the 10-digit account number:`
    );
    return true;
  }

  if (conv.state === 'wallet_send_bank_account') {
    if (lower === 'cancel') {
      await handleWalletMenu(db, identity, chatId);
      return true;
    }
    const accountNumber = text.replace(/\D/g, '');
    if (accountNumber.length < 10) {
      await sendText(chatId, 'Enter a valid account number (10 digits).');
      return true;
    }
    const ctx = getContext(conv);
    const bankCode = String(ctx.send_bank_code ?? '');
    if (!bankCode) {
      await sendText(chatId, 'Session expired. Start again with *send*.');
      await handleWalletMenu(db, identity, chatId);
      return true;
    }
    await sendText(chatId, 'Verifying account name…');
    const validated = await validateBankAccount({ accountNumber, bankCode });
    if (!validated.ok || !validated.accountName) {
      await sendText(
        chatId,
        validated.message ?? 'Could not verify account. Check number and bank.'
      );
      return true;
    }
    updateConversation(db, identity.phone, {
      state: 'wallet_send_bank_amount',
      context_json: JSON.stringify({
        ...ctx,
        send_account_number: accountNumber,
        send_account_name: validated.accountName,
      }),
    });
    await sendText(
      chatId,
      `Account name: *${validated.accountName}*\nEnter amount in Naira (min 100):`
    );
    return true;
  }

  if (conv.state === 'wallet_send_bank_amount') {
    let amount;
    try {
      amount = nairaToKobo(text.trim());
    } catch {
      await sendText(chatId, 'Invalid amount. Example: 2000');
      return true;
    }
    if (Number(amount) < MIN_SEND_KOBO) {
      await sendText(chatId, 'Minimum send is ₦100.');
      return true;
    }
    const ctx = getContext(conv);
    updateConversation(db, identity.phone, {
      state: 'wallet_send_bank_confirm',
      context_json: JSON.stringify({
        ...ctx,
        send_amount_kobo: Number(amount),
      }),
    });
    await sendText(
      chatId,
      [
        `Confirm bank transfer:`,
        `*${formatNgn(amount)}*`,
        `To: *${String(ctx.send_account_name ?? '')}*`,
        `${String(ctx.send_bank_name ?? '')} · ${String(ctx.send_account_number ?? '')}`,
        ``,
        `Reply *YES* to send or *NO* to cancel.`,
      ].join('\n')
    );
    return true;
  }

  if (conv.state === 'wallet_send_bank_confirm') {
    if (lower === 'no' || lower === 'cancel') {
      await sendText(chatId, 'Transfer cancelled.');
      await handleWalletMenu(db, identity, chatId);
      return true;
    }
    if (lower !== 'yes' && lower !== 'y') {
      await sendText(chatId, 'Reply *YES* to send or *NO* to cancel.');
      return true;
    }

    const ctx = getContext(conv);
    const amountKobo = Number(ctx.send_amount_kobo ?? 0);
    const bankCode = String(ctx.send_bank_code ?? '');
    const bankName = String(ctx.send_bank_name ?? '');
    const accountNumber = String(ctx.send_account_number ?? '');
    const accountName = String(ctx.send_account_name ?? '');
    if (!amountKobo || !bankCode || !accountNumber || !accountName) {
      await sendText(chatId, 'Transfer session expired. Start again with *send*.');
      await handleWalletMenu(db, identity, chatId);
      return true;
    }

    const reference = `btx_${newId()}`;
    try {
      applyLedgerEntry(db, {
        userId: identity.user.id,
        direction: 'debit',
        amount: kobo(amountKobo),
        type: 'bank_transfer',
        idempotencyKey: `bank_debit_${reference}`,
        provider: 'monnify',
        providerReference: reference,
        actorPhone: identity.phone,
        metadata: {
          bank_code: bankCode,
          bank_name: bankName,
          account_number: accountNumber,
          account_name: accountName,
        },
      });
    } catch (err) {
      await sendText(
        chatId,
        err instanceof Error ? err.message : 'Could not debit wallet'
      );
      return true;
    }

    await sendText(chatId, 'Sending via Monnify…');
    const amountNaira = Number(koboToNairaString(kobo(amountKobo)));
    const result = await initiateSingleDisbursement({
      amountNaira,
      reference,
      narration: `Pas2me transfer from ${identity.phone}`,
      destinationBankCode: bankCode,
      destinationAccountNumber: accountNumber,
      destinationAccountName: accountName,
    });

    if (!result.ok) {
      try {
        applyLedgerEntry(db, {
          userId: identity.user.id,
          direction: 'credit',
          amount: kobo(amountKobo),
          type: 'refund',
          idempotencyKey: `bank_refund_${reference}`,
          provider: 'monnify',
          providerReference: reference,
          actorPhone: identity.phone,
          metadata: { reason: result.message, status: result.status },
        });
      } catch (refundErr) {
        console.error('[wallet] bank transfer refund failed', refundErr);
      }
      await sendText(
        chatId,
        `Transfer failed: ${result.message}\nYour wallet has been refunded.`
      );
      await handleWalletMenu(db, identity, chatId);
      return true;
    }

    updateConversation(db, identity.phone, {
      state: 'wallet_menu',
      context_json: JSON.stringify({
        ...ctx,
        send_bank_code: null,
        send_bank_name: null,
        send_account_number: null,
        send_account_name: null,
        send_amount_kobo: null,
        send_bank_choices: null,
      }),
    });
    await sendText(
      chatId,
      [
        `*Bank transfer submitted*`,
        `Amount: ${formatNgn(kobo(amountKobo))}`,
        `To: ${accountName}`,
        `${bankName} · ${accountNumber}`,
        `Status: ${result.status ?? 'SUCCESS'}`,
        `Ref: ${reference}`,
      ].join('\n')
    );
    await handleWalletMenu(db, identity, chatId);
    return true;
  }

  if (conv.state === 'wallet_topup_amount') {
    if (!(await requireReadyWalletOrPromptKyc(db, identity, chatId))) return true;
    let amount;
    try {
      amount = nairaToKobo(text.trim());
    } catch {
      await sendText(chatId, 'Invalid amount. Example: 5000');
      return true;
    }
    if (Number(amount) < 10000) {
      await sendText(chatId, 'Minimum top-up is ₦100.');
      return true;
    }

    const reference = `topup_${newId()}`;
    const env = getEnv();
    const checkout = await createCheckout({
      amount,
      customerPhone: identity.phone,
      customerName: `${identity.user.first_name} ${identity.user.last_name}`.trim(),
      description: 'Pas2me wallet top-up',
      reference,
      callbackUrl: `${env.BOT_PUBLIC_URL}/webhooks/monnify/payment`,
    });

    const ctx = getContext(conv);
    updateConversation(db, identity.phone, {
      state: 'idle',
      context_json: JSON.stringify({
        ...ctx,
        pending_topup_ref: reference,
        pending_topup_kobo: Number(amount),
        last_menu: WALLET_MENU,
      }),
    });

    await sendText(
      chatId,
      `Top-up ${formatNgn(amount)}\nPay here:\n${checkout.checkoutUrl}\nRef: ${reference}`
    );
    return true;
  }

  if (cmd === 'wal_auto' || lower === 'auto top-up' || lower === 'autotopup') {
    if (!(await requireReadyWalletOrPromptKyc(db, identity, chatId))) return true;
    updateConversation(db, identity.phone, { state: 'auto_topup_setup' });
    await sendText(
      chatId,
      'Auto top-up setup.\nSend: <threshold_naira> <topup_naira>\nExample: 1000 5000\nOr send OFF to disable.'
    );
    return true;
  }

  if (conv.state === 'auto_topup_setup') {
    if (!(await requireReadyWalletOrPromptKyc(db, identity, chatId))) return true;
    if (text.trim().toLowerCase() === 'off') {
      db.prepare(
        `INSERT INTO auto_topup_settings (id, user_id, enabled, threshold_kobo, topup_amount_kobo, funding_method, created_at, updated_at)
         VALUES (?, ?, 0, 0, 0, 'monnify_checkout', datetime('now'), datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET enabled = 0, updated_at = datetime('now')`
      ).run(newId('ats'), identity.user.id);
      updateConversation(db, identity.phone, { state: 'wallet_menu' });
      await sendText(chatId, 'Auto top-up disabled.');
      await handleWalletMenu(db, identity, chatId);
      return true;
    }
    const parts = text.trim().split(/\s+/);
    try {
      const threshold = nairaToKobo(parts[0] ?? '');
      const topup = nairaToKobo(parts[1] ?? '');
      db.prepare(
        `INSERT INTO auto_topup_settings (id, user_id, enabled, threshold_kobo, topup_amount_kobo, funding_method, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, 'monnify_checkout', datetime('now'), datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           enabled = 1,
           threshold_kobo = excluded.threshold_kobo,
           topup_amount_kobo = excluded.topup_amount_kobo,
           updated_at = datetime('now')`
      ).run(newId('ats'), identity.user.id, threshold, topup);
      updateConversation(db, identity.phone, { state: 'wallet_menu' });
      await sendText(
        chatId,
        `Auto top-up enabled.\nWhen balance < ${formatNgn(threshold)}, request ${formatNgn(topup)}.`
      );
      await handleWalletMenu(db, identity, chatId);
    } catch {
      await sendText(chatId, 'Invalid format. Example: 1000 5000');
    }
    return true;
  }

  if (cmd === 'wal_withdraw' || lower === 'withdraw') {
    if (!(await requireReadyWalletOrPromptKyc(db, identity, chatId))) return true;
    await sendText(
      chatId,
      'To withdraw to a bank account, use *Send money* → *To bank account*.'
    );
    await showSendMenu(db, identity, chatId);
    return true;
  }

  if (conv.state === 'wallet_withdraw_amount') {
    // Legacy state — redirect to bank send
    updateConversation(db, identity.phone, { state: 'wallet_send_bank_search' });
    await sendText(
      chatId,
      'Withdrawals use bank transfer now.\nType the bank name to search (e.g. *opay*, *access*).'
    );
    return true;
  }

  if (cmd === 'wal_airtime' || lower === 'airtime') {
    if (!(await requireReadyWalletOrPromptKyc(db, identity, chatId))) return true;
    const { startAirtimeFlow } = await import('./airtime');
    await startAirtimeFlow(db, identity, chatId);
    return true;
  }

  // Explicit wallet entry word
  if (lower === 'wallet' || cmd === 'cust_wallet') {
    await handleWalletMenu(db, identity, chatId);
    return true;
  }

  // If user is in wallet_menu state and sent something wallet-related menu id
  if (cmd.startsWith('wal_')) {
    await sendText(chatId, 'Use the wallet options, or reply *menu*.');
    await handleWalletMenu(db, identity, chatId);
    return true;
  }

  if (conv.state === 'wallet_menu' && /^\d+$/.test(lower)) {
    // Number didn't map — refresh menu
    await handleWalletMenu(db, identity, chatId);
    return true;
  }

  return false;
}

export async function maybeTriggerAutoTopup(
  db: Db,
  userId: string,
  phone: string
): Promise<string | null> {
  const settings = db
    .prepare(
      `SELECT * FROM auto_topup_settings WHERE user_id = ? AND enabled = 1`
    )
    .get(userId) as
    | {
        threshold_kobo: number;
        topup_amount_kobo: number;
      }
    | undefined;
  if (!settings) return null;

  const wallet = getReadyWallet(db, userId);
  if (!wallet) return null;
  if (wallet.balance_kobo >= settings.threshold_kobo) return null;

  const env = getEnv();
  const reference = `autotopup_${newId()}`;
  const checkout = await createCheckout({
    amount: kobo(settings.topup_amount_kobo),
    customerPhone: phone,
    description: 'Pas2me auto top-up',
    reference,
    callbackUrl: `${env.BOT_PUBLIC_URL}/webhooks/monnify/payment`,
  });
  return `Auto top-up triggered. Pay ${formatNgn(kobo(settings.topup_amount_kobo))}:\n${checkout.checkoutUrl}`;
}

/** Credit wallet from payment webhook by reference. Returns false if already applied. */
export function creditTopupFromWebhook(
  db: Db,
  reference: string,
  userId: string,
  amountKobo: number
): boolean {
  if (!getReadyWallet(db, userId) && !getWalletByUserId(db, userId)) {
    console.warn(
      `[Monnify] top-up credit skipped — no wallet for user=${userId} ref=${reference}`
    );
    return false;
  }
  const idempotencyKey = `credit_${reference}`;
  const already = db
    .prepare(`SELECT id FROM wallet_transactions WHERE idempotency_key = ?`)
    .get(idempotencyKey) as { id: string } | undefined;
  if (already) return false;
  applyLedgerEntry(db, {
    userId,
    direction: 'credit',
    amount: kobo(amountKobo),
    type: reference.startsWith('autotopup_') ? 'auto_topup' : 'topup',
    idempotencyKey,
    provider: 'monnify',
    providerReference: reference,
  });
  return true;
}

export async function notifyWalletTopup(
  db: Db,
  userId: string,
  amountKobo: number
): Promise<void> {
  const user = findUserById(db, userId);
  if (!user?.phone) {
    console.warn(
      `[Monnify] credited user=${userId} but no phone for WhatsApp notify`
    );
    return;
  }
  const wallet = getReadyWallet(db, userId) ?? getWalletByUserId(db, userId);
  const available = wallet
    ? Math.max(0, wallet.balance_kobo - Number(wallet.locked_kobo ?? 0))
    : amountKobo;
  try {
    await sendText(
      phoneToWahaChatId(user.phone),
      [
        `*Wallet funded*`,
        `Amount: ${formatNgn(kobo(amountKobo))}`,
        `New available balance: ${formatNgn(kobo(available))}`,
        '',
        `Reply *wallet* to manage your balance.`,
      ].join('\n')
    );
  } catch (err) {
    console.error('[Monnify] WhatsApp top-up notify failed:', err);
  }
}
