import { getEnv } from '../config/env';

export interface CabmeParcelCreateInput {
  userId: string;
  lat1: number;
  lng1: number;
  lat2: number;
  lng2: number;
  sourceCity: string;
  destinationCity: string;
  distance: number;
  distanceUnit?: string;
  duration?: string;
  paymentMethodId: string;
  sourceAddress: string;
  destinationAddress: string;
  senderName: string;
  senderPhone: string;
  receiverName: string;
  receiverPhone: string;
  note?: string;
  parcelWeight?: string;
  parcelDimension?: string;
  parcelType: string;
  amount: number;
  parcelDate?: string;
  parcelTime?: string;
  receiveDate?: string;
  receiveTime?: string;
}

export interface CabmeParcelResult {
  ok: boolean;
  parcelId?: string;
  status?: string;
  message: string;
  raw: unknown;
}

export interface CabmeVehicleCategory {
  id: string;
  libelle?: string;
  kmCharge?: number;
  raw: Record<string, unknown>;
}

function cabmeConfigured(): boolean {
  const env = getEnv();
  return Boolean(env.CABME_BASE_URL && env.CABME_API_KEY);
}

async function cabmeFetch(
  path: string,
  init?: RequestInit & { form?: Record<string, string> }
): Promise<Response> {
  const env = getEnv();
  if (!cabmeConfigured()) {
    throw new Error('Cabme is not configured (CABME_BASE_URL / CABME_API_KEY)');
  }

  const base = env.CABME_BASE_URL!.replace(/\/$/, '');
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

  if (init?.form) {
    const body = new URLSearchParams(init.form);
    return fetch(url, {
      method: init.method ?? 'POST',
      headers: {
        apikey: env.CABME_API_KEY!,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(init.headers as Record<string, string> | undefined),
      },
      body,
    });
  }

  return fetch(url, {
    ...init,
    headers: {
      apikey: env.CABME_API_KEY!,
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/** Estimate fare from Cabme vehicle km charge × distance (same model as Cabme customer app). */
export async function estimateCabmeFare(distanceKm: number): Promise<{
  ok: boolean;
  amountNaira: number;
  categoryId?: string;
  message: string;
  raw?: unknown;
}> {
  if (!cabmeConfigured()) {
    return {
      ok: false,
      amountNaira: 0,
      message: 'Cabme is not configured',
    };
  }
  if (!(distanceKm > 0)) {
    return { ok: false, amountNaira: 0, message: 'Distance must be positive' };
  }

  try {
    const res = await cabmeFetch('/api/v1/Vehicle-category', { method: 'GET' });
    const json = (await res.json().catch(async () => ({
      text: await res.text(),
    }))) as Record<string, unknown>;
    const rows = Array.isArray(json.data) ? json.data : [];
    const first = asRecord(rows[0]);
    const kmCharge = Number(
      first.kmCharge ?? first.km_charge ?? first.prix ?? 0
    );
    if (!(kmCharge > 0)) {
      return {
        ok: false,
        amountNaira: 0,
        message: 'No Cabme vehicle km charge found',
        raw: json,
      };
    }
    const amountNaira = Number((kmCharge * distanceKm).toFixed(2));
    return {
      ok: true,
      amountNaira,
      categoryId: String(first.id ?? ''),
      message: 'ok',
      raw: json,
    };
  } catch (err) {
    return {
      ok: false,
      amountNaira: 0,
      message: err instanceof Error ? err.message : 'Cabme estimate failed',
    };
  }
}

export async function createCabmeParcel(
  input: CabmeParcelCreateInput
): Promise<CabmeParcelResult> {
  if (!cabmeConfigured()) {
    return {
      ok: false,
      message: 'Cabme is not configured',
      raw: { error: 'not_configured' },
    };
  }

  const now = new Date();
  const date = input.parcelDate ?? now.toISOString().slice(0, 10);
  const time = input.parcelTime ?? now.toISOString().slice(11, 19);

  try {
    const res = await cabmeFetch('/api/v1/parcel-register', {
      method: 'POST',
      form: {
        user_id: input.userId,
        lat1: String(input.lat1),
        lng1: String(input.lng1),
        lat2: String(input.lat2),
        lng2: String(input.lng2),
        source_city: input.sourceCity,
        destination_city: input.destinationCity,
        distance: String(input.distance),
        distance_unit: input.distanceUnit ?? 'km',
        duration: input.duration ?? '0',
        id_payment: input.paymentMethodId,
        source_adrs: input.sourceAddress,
        destination_adrs: input.destinationAddress,
        sender_name: input.senderName,
        sender_phone: input.senderPhone,
        receiver_name: input.receiverName,
        receiver_phone: input.receiverPhone,
        note: input.note ?? 'Pas2me waybill',
        parcel_weight: input.parcelWeight ?? '1',
        parcel_dimension: input.parcelDimension ?? '1x1x1',
        parcel_type: input.parcelType,
        amount: String(input.amount),
        parcel_date: date,
        parcel_time: time,
        receive_date: input.receiveDate ?? date,
        receive_time: input.receiveTime ?? time,
      },
    });

    const raw = await res.json().catch(async () => ({ text: await res.text() }));
    const root = asRecord(raw);
    const success = String(root.success ?? '').toLowerCase() === 'success';
    const data = Array.isArray(root.data) ? root.data[0] : root.data;
    const row = asRecord(data);

    if (!success || !row.id) {
      return {
        ok: false,
        message: String(root.message ?? root.error ?? 'Cabme parcel create failed'),
        raw,
      };
    }

    return {
      ok: true,
      parcelId: String(row.id),
      status: String(row.status ?? 'new'),
      message: String(root.message ?? 'Successfully created'),
      raw,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Cabme parcel create failed',
      raw: { error: String(err) },
    };
  }
}

export async function getCabmeParcelDetail(
  parcelId: string
): Promise<CabmeParcelResult> {
  if (!cabmeConfigured()) {
    return {
      ok: false,
      message: 'Cabme is not configured',
      raw: { error: 'not_configured' },
    };
  }

  try {
    const res = await cabmeFetch(
      `/api/v1/get-parcel-detail?id_parcel=${encodeURIComponent(parcelId)}`,
      { method: 'GET' }
    );
    const raw = await res.json().catch(async () => ({ text: await res.text() }));
    const root = asRecord(raw);
    const success = String(root.success ?? '').toLowerCase() === 'success';
    const data = Array.isArray(root.data) ? root.data[0] : root.data;
    const row = asRecord(data);
    if (!success) {
      return {
        ok: false,
        message: String(root.message ?? root.error ?? 'Parcel not found'),
        raw,
      };
    }
    return {
      ok: true,
      parcelId: String(row.id ?? parcelId),
      status: String(row.status ?? ''),
      message: 'ok',
      raw,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Cabme parcel fetch failed',
      raw: { error: String(err) },
    };
  }
}

export async function findCabmeCustomerByPhone(
  phone: string
): Promise<{ ok: true; cabmeUserId: string; raw: unknown } | { ok: false; message: string }> {
  if (!cabmeConfigured()) {
    return { ok: false, message: 'Cabme is not configured' };
  }

  const digits = phone.replace(/\D/g, '');
  const candidates = Array.from(
    new Set(
      [
        phone,
        digits,
        digits.startsWith('234') && digits.length >= 13 ? `0${digits.slice(3)}` : '',
        digits.length === 11 && digits.startsWith('0') ? `+234${digits.slice(1)}` : '',
        digits.length >= 10 ? `+${digits}` : '',
      ].filter(Boolean)
    )
  );

  for (const candidate of candidates) {
    try {
      const res = await cabmeFetch('/api/v1/profilebyphone/', {
        method: 'POST',
        form: {
          phone: candidate,
          user_cat: 'customer',
          login_type: 'phoneNumber',
        },
      });
      const raw = await res.json().catch(async () => ({ text: await res.text() }));
      const root = asRecord(raw);
      const success = String(root.success ?? '').toLowerCase() === 'success';
      const data = Array.isArray(root.data) ? root.data[0] : root.data;
      const row = asRecord(data);
      const id = row.id ?? row.user_id;
      if (success && id) {
        return { ok: true, cabmeUserId: String(id), raw };
      }
    } catch {
      /* try next phone format */
    }
  }

  return {
    ok: false,
    message:
      'No Cabme customer account found for this phone. Register in the Cabme customer app with this WhatsApp number, then reply *link cabme*.',
  };
}

export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function mapCabmeStatusToLogistics(
  cabmeStatus: string
):
  | 'dispatch_requested'
  | 'rider_assigned'
  | 'en_route_to_pickup'
  | 'picked_up'
  | 'en_route_to_dropoff'
  | 'delivered'
  | 'dispatch_failed'
  | 'cancelled' {
  const s = cabmeStatus.toLowerCase();
  if (s.includes('complete') || s === 'delivered') return 'delivered';
  if (s.includes('onride') || s.includes('on_ride') || s.includes('transit'))
    return 'en_route_to_dropoff';
  if (s.includes('confirm') || s.includes('assigned')) return 'rider_assigned';
  if (s.includes('reject') || s.includes('fail')) return 'dispatch_failed';
  if (s.includes('cancel')) return 'cancelled';
  if (s.includes('new') || s.includes('pending')) return 'dispatch_requested';
  return 'dispatch_requested';
}
