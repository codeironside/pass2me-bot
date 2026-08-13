import { getEnv } from '../config/env';
import type { Kobo } from '../domain/money';
import { koboToNairaString } from '../domain/money';

export interface AirtimePurchaseResult {
  success: boolean;
  providerReference?: string;
  message: string;
  raw: unknown;
}

async function fwFetch(path: string, init?: RequestInit): Promise<Response> {
  const env = getEnv();
  if (!env.FLUTTERWAVE_SECRET_KEY) {
    throw new Error('FLUTTERWAVE_SECRET_KEY is not configured');
  }
  return fetch(`${env.FLUTTERWAVE_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}`,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

export async function purchaseAirtime(params: {
  beneficiaryPhone: string;
  amount: Kobo;
  network?: string;
  reference: string;
}): Promise<AirtimePurchaseResult> {
  const env = getEnv();

  if (!env.FLUTTERWAVE_SECRET_KEY) {
    return {
      success: true,
      providerReference: `mock_${params.reference}`,
      message: 'Airtime purchase simulated (Flutterwave not configured).',
      raw: { mock: true },
    };
  }

  // Flutterwave bill payment — AIRTIME
  const body = {
    country: 'NG',
    customer: params.beneficiaryPhone,
    amount: Number(koboToNairaString(params.amount)),
    type: 'AIRTIME',
    reference: params.reference,
    biller_name: params.network ?? 'AIRTIME',
  };

  const res = await fwFetch('/bills', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  const raw = (await res.json().catch(async () => ({
    text: await res.text(),
  }))) as Record<string, unknown>;

  if (!res.ok || raw.status === 'error') {
    return {
      success: false,
      message: String(raw.message ?? 'Flutterwave airtime failed'),
      raw,
    };
  }

  const data = (raw.data ?? {}) as Record<string, unknown>;
  return {
    success: true,
    providerReference: String(data.flw_ref ?? data.tx_ref ?? params.reference),
    message: 'Airtime purchase submitted.',
    raw,
  };
}
