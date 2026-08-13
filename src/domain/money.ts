/**
 * Money is stored and computed in integer kobo (1 NGN = 100 kobo).
 * Never use floating-point for currency.
 */

export type Kobo = number & { readonly __brand: 'Kobo' };
export type CurrencyCode = 'NGN';

const KOBO_PER_NAIRA = 100n;

function assertSafeInteger(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`${label} exceeds safe integer range`);
  }
  return Number(value);
}

export function kobo(amount: number | bigint): Kobo {
  const n = typeof amount === 'bigint' ? amount : BigInt(Math.trunc(amount));
  if (n < 0n) throw new Error('Kobo amount cannot be negative');
  return assertSafeInteger(n, 'kobo') as Kobo;
}

/** Parse display Naira string/number (e.g. 10.50) into kobo */
export function nairaToKobo(naira: string | number): Kobo {
  const raw = typeof naira === 'number' ? naira.toFixed(2) : naira.trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error(`Invalid Naira amount: ${naira}`);
  }
  const negative = raw.startsWith('-');
  const [whole, frac = ''] = raw.replace('-', '').split('.');
  const fracPadded = (frac + '00').slice(0, 2);
  const total =
    BigInt(whole) * KOBO_PER_NAIRA + BigInt(fracPadded);
  if (negative) throw new Error('Naira amount cannot be negative');
  return kobo(total);
}

/** Parse DECIMAL from SQLite (stored as number or string) into kobo */
export function decimalToKobo(value: unknown): Kobo {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid decimal money');
    return nairaToKobo(value);
  }
  if (typeof value === 'string') return nairaToKobo(value);
  throw new Error(`Unsupported money value: ${typeof value}`);
}

export function koboToNairaString(amount: Kobo): string {
  const neg = amount < 0;
  const abs = BigInt(Math.abs(amount));
  const whole = abs / KOBO_PER_NAIRA;
  const frac = abs % KOBO_PER_NAIRA;
  const s = `${whole}.${frac.toString().padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

export function formatNgn(amount: Kobo): string {
  return `₦${koboToNairaString(amount)}`;
}

export function addKobo(a: Kobo, b: Kobo): Kobo {
  return kobo(BigInt(a) + BigInt(b));
}

export function subKobo(a: Kobo, b: Kobo): Kobo {
  const result = BigInt(a) - BigInt(b);
  if (result < 0n) throw new Error('Insufficient funds');
  return kobo(result);
}

export function mulKoboByBps(amount: Kobo, bps: number): Kobo {
  if (!Number.isInteger(bps) || bps < 0) throw new Error('Invalid BPS');
  // fee = amount * bps / 10000, rounded half-up
  const product = BigInt(amount) * BigInt(bps);
  const rounded = (product + 5000n) / 10000n;
  return kobo(rounded);
}

export function computePlatformFee(
  amount: Kobo,
  feeBps: number,
  flatKobo: number
): Kobo {
  const pct = mulKoboByBps(amount, feeBps);
  return addKobo(pct, kobo(flatKobo));
}

export interface MoneyAmount {
  readonly currency: CurrencyCode;
  readonly kobo: Kobo;
}

export function moneyNGN(amountKobo: Kobo): MoneyAmount {
  return { currency: 'NGN', kobo: amountKobo };
}
