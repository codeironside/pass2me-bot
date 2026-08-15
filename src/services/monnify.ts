import { createHash } from 'node:crypto';
import { getEnv } from '../config/env';
import type { Kobo } from '../domain/money';
import { formatNgn, koboToNairaString } from '../domain/money';

export interface MonnifyCheckoutResult {
  reference: string;
  checkoutUrl: string;
  transactionReference?: string;
  raw: unknown;
}

export interface ReservedAccountResult {
  ok: boolean;
  accountNumber: string;
  accountReference: string;
  bankName?: string;
  accountName?: string;
  raw: unknown;
}

export interface BankTransferCharge {
  reference: string;
  accountNumber?: string;
  accountName?: string;
  bankName?: string;
  expiresOn?: string;
  checkoutUrl?: string;
  raw: unknown;
}

interface TokenCache {
  token: string;
  expiresAtMs: number;
}

let tokenCache: TokenCache | null = null;

function monnifyConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.MONNIFY_API_KEY && env.MONNIFY_SECRET_KEY && env.MONNIFY_CONTRACT_CODE);
}

async function getAccessToken(): Promise<string> {
  const env = getEnv();
  if (!env.MONNIFY_API_KEY || !env.MONNIFY_SECRET_KEY) {
    throw new Error('Monnify API credentials are not configured');
  }

  if (tokenCache && Date.now() < tokenCache.expiresAtMs) {
    return tokenCache.token;
  }

  const basic = Buffer.from(
    `${env.MONNIFY_API_KEY}:${env.MONNIFY_SECRET_KEY}`
  ).toString('base64');

  const res = await fetch(`${env.MONNIFY_BASE_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
    },
  });

  const json = (await res.json().catch(async () => ({
    text: await res.text(),
  }))) as Record<string, unknown>;

  if (!res.ok || json.requestSuccessful === false) {
    throw new Error(
      `Monnify auth failed: ${String(json.responseMessage ?? JSON.stringify(json))}`
    );
  }

  const body = (json.responseBody ?? {}) as Record<string, unknown>;
  const token = String(body.accessToken ?? '');
  const expiresIn = Number(body.expiresIn ?? 3600);
  if (!token) {
    throw new Error('Monnify auth returned no access token');
  }

  // Refresh a minute early
  tokenCache = {
    token,
    expiresAtMs: Date.now() + Math.max(60, expiresIn - 60) * 1000,
  };
  return token;
}

async function monnifyFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const env = getEnv();
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...(init?.headers as Record<string, string> | undefined),
  };
  return fetch(`${env.MONNIFY_BASE_URL}${path}`, { ...init, headers });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function extractReservedAccount(raw: unknown): {
  accountNumber: string;
  accountReference: string;
  bankName?: string;
  accountName?: string;
} {
  const root = asRecord(raw);
  const body = asRecord(root.responseBody ?? root.data ?? root);
  const accounts = Array.isArray(body.accounts) ? body.accounts : [];
  const firstAccount = asRecord(accounts[0]);
  const transfer = asRecord(body.bankTransfer ?? body.accountDetails ?? body);

  const accountNumber = String(
    body.accountNumber ??
      firstAccount.accountNumber ??
      transfer.accountNumber ??
      body.account_number ??
      ''
  ).trim();
  const accountReference = String(
    body.accountReference ?? body.account_reference ?? ''
  ).trim();
  const bankName = String(
    body.bankName ?? firstAccount.bankName ?? transfer.bankName ?? ''
  ).trim();
  const accountName = String(
    body.accountName ??
      firstAccount.accountName ??
      transfer.accountName ??
      ''
  ).trim();

  return {
    accountNumber,
    accountReference,
    bankName: bankName || undefined,
    accountName: accountName || undefined,
  };
}

/** Create a checkout / payment session. Falls back to local pay URL in mock mode. */
export async function createCheckout(params: {
  amount: Kobo;
  customerPhone: string;
  customerEmail?: string;
  customerName?: string;
  description: string;
  reference: string;
  callbackUrl: string;
}): Promise<MonnifyCheckoutResult> {
  const env = getEnv();

  if (!monnifyConfigured()) {
    return {
      reference: params.reference,
      checkoutUrl: `${env.BOT_PUBLIC_URL}/pay/${params.reference}`,
      raw: { mock: true },
    };
  }

  const body = {
    amount: Number(koboToNairaString(params.amount)),
    currencyCode: 'NGN',
    paymentDescription: params.description,
    paymentReference: params.reference,
    contractCode: env.MONNIFY_CONTRACT_CODE,
    // Browser return URL (webhooks are configured separately in Monnify dashboard)
    redirectUrl: params.callbackUrl.includes('/webhooks/')
      ? `${env.BOT_PUBLIC_URL}/pay/${params.reference}`
      : params.callbackUrl,
    customerName: params.customerName ?? params.customerPhone,
    customerEmail:
      params.customerEmail ?? `${params.customerPhone.replace(/\D/g, '')}@pas2me.local`,
    paymentMethods: ['CARD', 'ACCOUNT_TRANSFER'],
  };

  try {
    const res = await monnifyFetch('/api/v1/merchant/transactions/init-transaction', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(async () => ({
      text: await res.text(),
    }))) as Record<string, unknown>;

    if (!res.ok || json.requestSuccessful === false) {
      console.error('Monnify initialize failed:', json);
      return {
        reference: params.reference,
        checkoutUrl: `${env.BOT_PUBLIC_URL}/pay/${params.reference}`,
        raw: json,
      };
    }

    const data = asRecord(json.responseBody ?? json.data ?? json);
    const checkoutUrl = String(
      data.checkoutUrl ??
        data.checkout_url ??
        `${env.BOT_PUBLIC_URL}/pay/${params.reference}`
    );

    return {
      reference: params.reference,
      checkoutUrl,
      transactionReference: data.transactionReference
        ? String(data.transactionReference)
        : undefined,
      raw: json,
    };
  } catch (err) {
    console.error('Monnify initialize error:', err);
    return {
      reference: params.reference,
      checkoutUrl: `${env.BOT_PUBLIC_URL}/pay/${params.reference}`,
      raw: { error: String(err) },
    };
  }
}

/** One-time virtual account for bank-transfer checkout (shows account number). */
export async function createBankTransferCharge(params: {
  amount: Kobo;
  customerPhone: string;
  customerEmail?: string;
  customerName?: string;
  description: string;
  reference: string;
  callbackUrl: string;
}): Promise<BankTransferCharge> {
  const env = getEnv();
  const customerName =
    params.customerName?.trim() || params.customerPhone;
  const customerEmail =
    params.customerEmail ??
    `${params.customerPhone.replace(/\D/g, '')}@pas2me.local`;

  if (!monnifyConfigured()) {
    return {
      reference: params.reference,
      checkoutUrl: `${env.BOT_PUBLIC_URL}/pay/${params.reference}`,
      raw: { mock: true },
    };
  }

  const payload = {
    amount: Number(koboToNairaString(params.amount)),
    currencyCode: 'NGN',
    paymentDescription: params.description,
    paymentReference: params.reference,
    contractCode: env.MONNIFY_CONTRACT_CODE,
    customerName,
    customerEmail,
    redirectUrl: params.callbackUrl.includes('/webhooks/')
      ? `${env.BOT_PUBLIC_URL}/pay/${params.reference}`
      : params.callbackUrl,
  };

  try {
    const res = await monnifyFetch(
      '/api/v1/merchant/bank-transfer/init-payment',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    const json = (await res.json().catch(async () => ({
      text: await res.text(),
    }))) as Record<string, unknown>;

    if (res.ok && json.requestSuccessful !== false) {
      const extracted = extractReservedAccount(json);
      const data = asRecord(json.responseBody ?? json.data ?? json);
      if (extracted.accountNumber) {
        return {
          reference: params.reference,
          accountNumber: extracted.accountNumber,
          accountName: extracted.accountName,
          bankName: extracted.bankName,
          expiresOn: data.expiresOn ? String(data.expiresOn) : undefined,
          raw: json,
        };
      }
    } else {
      console.error('Monnify bank-transfer init failed:', json);
    }
  } catch (err) {
    console.error('Monnify bank-transfer init error:', err);
  }

  const checkout = await createCheckout({
    ...params,
    customerName,
    customerEmail,
  });
  const extracted = extractReservedAccount(checkout.raw);
  return {
    reference: params.reference,
    accountNumber: extracted.accountNumber || undefined,
    accountName: extracted.accountName,
    bankName: extracted.bankName,
    checkoutUrl: checkout.checkoutUrl,
    raw: checkout.raw,
  };
}

/** Reserve a dedicated virtual account for wallet funding. */
export async function createReservedAccount(params: {
  accountReference: string;
  customerName: string;
  customerEmail: string;
  bvn?: string;
  nin?: string;
}): Promise<ReservedAccountResult> {
  if (!params.bvn && !params.nin) {
    return {
      ok: false,
      accountNumber: '',
      accountReference: params.accountReference,
      raw: { error: 'bvn_or_nin_required' },
    };
  }

  const env = getEnv();
  if (!monnifyConfigured()) {
    return {
      ok: false,
      accountNumber: '',
      accountReference: params.accountReference,
      raw: { mock: true },
    };
  }

  const payload: Record<string, unknown> = {
    accountReference: params.accountReference,
    accountName: params.customerName,
    currencyCode: 'NGN',
    contractCode: env.MONNIFY_CONTRACT_CODE,
    customerEmail: params.customerEmail,
    customerName: params.customerName,
    getAllAvailableBanks: true,
  };
  if (params.bvn) payload.bvn = params.bvn;
  if (params.nin) payload.nin = params.nin;

  try {
    const res = await monnifyFetch('/api/v2/bank-transfer/reserved-accounts', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const raw = await res.json().catch(async () => ({ text: await res.text() }));
    const root = asRecord(raw);
    const message = String(root.responseMessage ?? '').toLowerCase();

    // Already reserved — fetch existing
    if (
      !res.ok ||
      root.requestSuccessful === false ||
      message.includes('same reference') ||
      message.includes('more than 1 account')
    ) {
      const existing = await getReservedAccount(params.accountReference);
      if (existing.accountNumber) {
        return { ...existing, ok: true, raw: existing.raw ?? raw };
      }
      console.error('Monnify reserve account failed:', raw);
      return {
        ok: false,
        accountNumber: '',
        accountReference: params.accountReference,
        raw,
      };
    }

    const extracted = extractReservedAccount(raw);
    return {
      ok: Boolean(extracted.accountNumber),
      accountNumber: extracted.accountNumber,
      accountReference: extracted.accountReference || params.accountReference,
      bankName: extracted.bankName,
      raw,
    };
  } catch (err) {
    console.error('Monnify reserve account error:', err);
    return {
      ok: false,
      accountNumber: '',
      accountReference: params.accountReference,
      raw: { error: String(err) },
    };
  }
}

export interface ReservedAccountTransaction {
  transactionReference: string;
  paymentReference: string;
  paymentStatus: string;
  amountPaid: unknown;
  completed: boolean;
  completedOn?: string;
}

export async function listReservedAccountTransactions(
  accountReference: string,
  page = 0,
  size = 10
): Promise<ReservedAccountTransaction[]> {
  if (!monnifyConfigured() || !accountReference.trim()) return [];
  try {
    const res = await monnifyFetch(
      `/api/v1/bank-transfer/reserved-accounts/transactions?accountReference=${encodeURIComponent(accountReference)}&page=${page}&size=${size}`
    );
    const raw = (await res.json().catch(async () => ({
      text: await res.text(),
    }))) as Record<string, unknown>;
    if (!res.ok || raw.requestSuccessful === false) {
      console.warn(
        '[Monnify] reserved-account transactions failed:',
        raw.responseMessage ?? raw
      );
      return [];
    }
    const body = asRecord(raw.responseBody ?? raw.data ?? raw);
    const content = Array.isArray(body.content)
      ? body.content
      : Array.isArray(body.transactions)
        ? body.transactions
        : [];
    return content.map((row) => {
      const item = asRecord(row);
      return {
        transactionReference: String(item.transactionReference ?? ''),
        paymentReference: String(item.paymentReference ?? ''),
        paymentStatus: String(item.paymentStatus ?? item.status ?? ''),
        amountPaid: item.amountPaid ?? item.amount,
        completed: item.completed === true,
        completedOn: String(item.completedOn ?? item.paidOn ?? item.createdOn ?? ''),
      };
    });
  } catch (err) {
    console.warn('[Monnify] reserved-account transactions error:', err);
    return [];
  }
}

export async function getReservedAccount(
  accountReference: string
): Promise<ReservedAccountResult> {
  try {
    const res = await monnifyFetch(
      `/api/v2/bank-transfer/reserved-accounts/${encodeURIComponent(accountReference)}`
    );
    const raw = await res.json().catch(async () => ({ text: await res.text() }));
    const extracted = extractReservedAccount(raw);
    return {
      ok: Boolean(extracted.accountNumber),
      accountNumber: extracted.accountNumber,
      accountReference: extracted.accountReference || accountReference,
      bankName: extracted.bankName,
      raw,
    };
  } catch (err) {
    return {
      ok: false,
      accountNumber: '',
      accountReference,
      raw: { error: String(err) },
    };
  }
}

/** Verify Monnify transactionHash when secret is configured. */
export function verifyMonnifyWebhookHash(body: Record<string, unknown>): boolean {
  const env = getEnv();
  if (!env.MONNIFY_SECRET_KEY) return true;

  const received = String(body.transactionHash ?? '');
  if (!received) return env.NODE_ENV !== 'production';

  const paymentReference = String(body.paymentReference ?? '');
  const amountPaid = String(body.amountPaid ?? '');
  const paidOn = String(body.paidOn ?? '');
  const transactionReference = String(body.transactionReference ?? '');

  const computed = createHash('sha512')
    .update(
      `${env.MONNIFY_SECRET_KEY}|${paymentReference}|${amountPaid}|${paidOn}|${transactionReference}`
    )
    .digest('hex');

  return computed.toLowerCase() === received.toLowerCase();
}

export function describeBankTransferInstructions(
  reference: string,
  amount: Kobo,
  details?: {
    accountNumber?: string;
    accountName?: string;
    bankName?: string;
    expiresOn?: string;
    checkoutUrl?: string;
  }
): string {
  const lines = [`*Bank transfer payment*`, `Amount: ${formatNgn(amount)}`];
  if (details?.bankName) lines.push(`Bank: *${details.bankName}*`);
  if (details?.accountName) lines.push(`Account name: *${details.accountName}*`);
  if (details?.accountNumber) {
    lines.push(`Account number: *${details.accountNumber}*`);
  }
  lines.push(`Reference: ${reference}`);
  if (details?.expiresOn) lines.push(`Valid until: ${details.expiresOn}`);
  lines.push('');
  if (details?.accountNumber) {
    lines.push(
      'Transfer the *exact amount* to the account above.',
      'Use the reference as narration if your bank asks for it.',
      'We will confirm automatically when payment lands.'
    );
  } else {
    lines.push(
      'Bank account details were not returned. Pay with the link below if shown.'
    );
    if (details?.checkoutUrl) lines.push(details.checkoutUrl);
  }
  return lines.join('\n');
}

export interface MonnifyBank {
  code: string;
  name: string;
}

let banksCache: { at: number; banks: MonnifyBank[] } | null = null;

export async function listMonnifyBanks(): Promise<MonnifyBank[]> {
  if (banksCache && Date.now() - banksCache.at < 6 * 60 * 60 * 1000) {
    return banksCache.banks;
  }
  if (!monnifyConfigured()) return [];

  const paths = [
    '/api/v1/banks',
    '/api/v1/sdk/transactions/banks',
  ];
  for (const path of paths) {
    try {
      const res = await monnifyFetch(path);
      const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || raw.requestSuccessful === false) continue;
      const body = raw.responseBody ?? raw.data ?? raw;
      const list = Array.isArray(body)
        ? body
        : Array.isArray((body as Record<string, unknown>).banks)
          ? ((body as Record<string, unknown>).banks as unknown[])
          : Array.isArray((body as Record<string, unknown>).content)
            ? ((body as Record<string, unknown>).content as unknown[])
            : [];
      const banks: MonnifyBank[] = [];
      for (const item of list) {
        const row = asRecord(item);
        const code = String(row.code ?? row.bankCode ?? '').trim();
        const name = String(row.name ?? row.bankName ?? '').trim();
        if (code && name) banks.push({ code, name });
      }
      if (banks.length > 0) {
        banks.sort((a, b) => a.name.localeCompare(b.name));
        banksCache = { at: Date.now(), banks };
        return banks;
      }
    } catch (err) {
      console.warn(`[Monnify] list banks via ${path} failed:`, err);
    }
  }
  return banksCache?.banks ?? [];
}

export async function validateBankAccount(params: {
  accountNumber: string;
  bankCode: string;
}): Promise<{ ok: boolean; accountName?: string; message?: string }> {
  if (!monnifyConfigured()) {
    return { ok: false, message: 'Monnify is not configured.' };
  }
  const accountNumber = params.accountNumber.replace(/\D/g, '');
  const bankCode = params.bankCode.trim();
  if (accountNumber.length < 10) {
    return { ok: false, message: 'Account number must be at least 10 digits.' };
  }
  try {
    const qs = new URLSearchParams({
      accountNumber,
      bankCode,
    });
    const res = await monnifyFetch(
      `/api/v2/disbursements/account/validate?${qs.toString()}`
    );
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || raw.requestSuccessful === false) {
      return {
        ok: false,
        message: String(
          raw.responseMessage ?? 'Could not validate account. Check bank and number.'
        ),
      };
    }
    const body = asRecord(raw.responseBody ?? raw.data ?? raw);
    const accountName = String(
      body.accountName ?? body.account_name ?? ''
    ).trim();
    if (!accountName) {
      return { ok: false, message: 'Account validated but no name returned.' };
    }
    return { ok: true, accountName };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Account validation failed',
    };
  }
}

export interface DisbursementResult {
  ok: boolean;
  status?: string;
  reference: string;
  message: string;
  raw?: unknown;
}

/** Pay out from merchant Monnify wallet to an external bank account. */
export async function initiateSingleDisbursement(params: {
  amountNaira: number;
  reference: string;
  narration: string;
  destinationBankCode: string;
  destinationAccountNumber: string;
  destinationAccountName: string;
}): Promise<DisbursementResult> {
  const env = getEnv();
  if (!monnifyConfigured()) {
    return {
      ok: false,
      reference: params.reference,
      message: 'Monnify is not configured.',
    };
  }
  const source = env.MONNIFY_DISBURSEMENT_SOURCE_ACCOUNT?.trim();
  if (!source) {
    return {
      ok: false,
      reference: params.reference,
      message:
        'Bank payouts are not configured (missing MONNIFY_DISBURSEMENT_SOURCE_ACCOUNT).',
    };
  }

  const body = {
    amount: params.amountNaira,
    reference: params.reference,
    narration: params.narration.slice(0, 100),
    destinationBankCode: params.destinationBankCode,
    destinationAccountNumber: params.destinationAccountNumber.replace(/\D/g, ''),
    currency: 'NGN',
    sourceAccountNumber: source,
    destinationAccountName: params.destinationAccountName,
  };

  try {
    const res = await monnifyFetch('/api/v2/disbursements/single', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const raw = await res.json().catch(async () => ({ text: await res.text() }));
    const root = asRecord(raw);
    const responseBody = asRecord(root.responseBody ?? root.data ?? root);
    const status = String(
      responseBody.status ?? root.status ?? ''
    ).toUpperCase();
    const message = String(
      root.responseMessage ??
        responseBody.message ??
        (status || 'Disbursement submitted')
    );

    if (!res.ok || root.requestSuccessful === false) {
      return {
        ok: false,
        status,
        reference: params.reference,
        message:
          message ||
          'Disbursement failed. Ask Monnify to enable transfers on this contract if needed.',
        raw,
      };
    }

    // PENDING_AUTHORIZATION means MFA — treat as not completed for our flow
    if (status === 'PENDING_AUTHORIZATION' || status.includes('OTP')) {
      return {
        ok: false,
        status,
        reference: params.reference,
        message:
          'Monnify requires OTP/MFA approval for this payout. Disable MFA for API disbursements or approve in dashboard.',
        raw,
      };
    }

    const failed = status === 'FAILED' || status === 'OTP_EMAIL_DISPATCH_FAILED';
    return {
      ok: !failed,
      status,
      reference: params.reference,
      message,
      raw,
    };
  } catch (err) {
    return {
      ok: false,
      reference: params.reference,
      message: err instanceof Error ? err.message : 'Disbursement request failed',
    };
  }
}
