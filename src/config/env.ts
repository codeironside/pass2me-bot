import { z } from 'zod';

const emptyToUndefined = (v: unknown) =>
  v === '' || v === undefined || v === null ? undefined : v;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_PATH: z.string().min(1),
  BOT_PUBLIC_URL: z.string().url(),
  WEBHOOK_SECRET: z.string().min(8),
  JWT_INVITE_SECRET: z.string().min(8),

  /** Baileys multi-file auth directory (relative to cwd or absolute) */
  WA_AUTH_DIR: z.string().default('./data/baileys_auth'),
  /**
   * Bot WhatsApp number for pairing-code login (digits with country code, e.g. 2348012345678).
   * Faster and more reliable than QR in Windows terminals.
   */
  WA_PAIRING_PHONE: z.preprocess(emptyToUndefined, z.string().optional()),
  /**
   * Interactive UX for menus:
   * - text  = numbered menus only (safest / least ban risk)
   * - list / buttons = currently same as text (interactive UI fingerprints unofficial)
   */
  WA_INTERACTIVE_MODE: z.enum(['text', 'list', 'buttons']).default('text'),
  /** Gaussian jitter lower bound before send (ms) */
  WA_JITTER_MIN_MS: z.coerce.number().int().min(0).default(800),
  /** Gaussian jitter upper bound before send (ms), before typing-scaled extra */
  WA_JITTER_MAX_MS: z.coerce.number().int().min(0).default(2800),

  WHATSAPP_PHONE_NUMBER_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  PAYSTACK_PUBLIC_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  CLOUDINARY_CLOUD_NAME: z.preprocess(emptyToUndefined, z.string().optional()),
  CLOUDINARY_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),

  /** Cloudflare D1 REST API settings */
  CLOUDFLARE_ACCOUNT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  CLOUDFLARE_DATABASE_ID: z.preprocess(
    emptyToUndefined,
    z.string().default('46009d94-37b4-4536-bc7d-7ec37c389ef0')
  ),
  CLOUDFLARE_API_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  /**
   * When true, the bot uses hosted D1 via the REST API.
   * Default false so local wrangler (`npm run dev` / `dev:local`) and the bot
   * share the same Miniflare sqlite — dashboard signups then resolve on WhatsApp.
   */
  CLOUDFLARE_D1_REMOTE: z.preprocess((v) => {
    if (v === undefined || v === null || v === '') return false;
    const s = String(v).trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes';
  }, z.boolean().default(false)),

  R2_ACCOUNT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  R2_ACCESS_KEY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  R2_SECRET_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  R2_ENDPOINT: z.preprocess(emptyToUndefined, z.string().optional()),
  R2_BUCKET: z.preprocess(emptyToUndefined, z.string().optional()),
  /**
   * Public base that serves GET /media/* from the wa-stores worker (R2).
   * Example: http://localhost:8787/media  or  https://your-api.workers.dev/media
   */
  R2_PUBLIC_BASE_URL: z.preprocess(emptyToUndefined, z.string().optional()),

  MONNIFY_BASE_URL: z.string().url().default('https://sandbox.monnify.com'),
  MONNIFY_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  MONNIFY_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  MONNIFY_CONTRACT_CODE: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Merchant Monnify wallet account used as disbursement source (not user reserved VAs) */
  MONNIFY_DISBURSEMENT_SOURCE_ACCOUNT: z.preprocess(
    emptyToUndefined,
    z.string().optional()
  ),

  CABME_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  CABME_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  CABME_PAYMENT_METHOD_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  CABME_PARCEL_CATEGORY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  /** Shown when user must register in Cabme first */
  CABME_REGISTER_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),

  FLUTTERWAVE_BASE_URL: z
    .string()
    .url()
    .default('https://api.flutterwave.com/v3'),
  FLUTTERWAVE_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  FLUTTERWAVE_PUBLIC_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  FLUTTERWAVE_ENCRYPTION_KEY: z.preprocess(
    emptyToUndefined,
    z.string().optional()
  ),

  SMS_PROVIDER: z.enum(['termii', 'mock']).default('termii'),
  SMS_BASE_URL: z.string().url().default('https://api.ng.termii.com'),
  SMS_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  SMS_SENDER_ID: z.string().default('Pas2me'),
  SMS_OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(0),
  PLATFORM_FEE_FLAT_KOBO: z.coerce.number().int().min(0).default(0),
  YEARLY_DISCOUNT_BPS: z.coerce.number().int().min(0).max(10_000).default(1667),

  PLAN_LIMITS_JSON: z.preprocess(emptyToUndefined, z.string().optional()),
  OUTBOUND_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  if (parsed.data.WA_JITTER_MAX_MS < parsed.data.WA_JITTER_MIN_MS) {
    throw new Error('WA_JITTER_MAX_MS must be >= WA_JITTER_MIN_MS');
  }
  cached = parsed.data;
  return cached;
}

export function getEnv(): Env {
  if (!cached) return loadEnv();
  return cached;
}

/** Reset cache — for tests only */
export function resetEnvCache(): void {
  cached = null;
}
