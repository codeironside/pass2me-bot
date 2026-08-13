import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/client';
import { getEnv } from '../config/env';
import { newId, normalizePhone, nowIso } from '../domain/ids';

export interface WahaButton {
  id: string;
  text: string;
}

export interface WahaListRow {
  id: string;
  title: string;
  description?: string;
}

/** Normalized inbound message (kept name-compatible with old WAHA shape). */
export interface IncomingWahaMessage {
  id: string;
  timestamp: number;
  from: string;
  fromMe: boolean;
  body?: string;
  type?: string;
  hasMedia?: boolean;
  replyTo?: string;
  buttonOrListId?: string;
  location?: {
    latitude: number;
    longitude: number;
    description?: string;
  };
  session?: string;
  event?: string;
  /** Baileys message key — used for read receipts */
  rawKey?: {
    remoteJid?: string | null;
    id?: string | null;
    fromMe?: boolean | null;
    participant?: string | null;
  };
  /** Full Baileys WAMessage — used for media download */
  rawWaMessage?: {
    key: {
      remoteJid?: string | null;
      id?: string | null;
      fromMe?: boolean | null;
      participant?: string | null;
    };
    message?: Record<string, unknown> | null;
  };
}

export type IncomingWhatsAppMessage = IncomingWahaMessage;

type RateBucket = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateBucket>();
const burstBuckets = new Map<string, { count: number; resetAt: number }>();
const pendingReadKeys = new Map<
  string,
  Array<{
    remoteJid?: string | null;
    id?: string | null;
    fromMe?: boolean | null;
    participant?: string | null;
  }>
>();

type BaileysModule = typeof import('@whiskeysockets/baileys');
type WASocket = import('@whiskeysockets/baileys').WASocket;

let baileysMod: BaileysModule | null = null;
let sock: WASocket | null = null;
let connectionStatus:
  | 'starting'
  | 'qr'
  | 'connecting'
  | 'open'
  | 'close'
  = 'starting';
let lastDisconnect: string | null = null;
let inboundHandler: ((msg: IncomingWahaMessage) => Promise<void>) | null =
  null;
let starting = false;

async function loadBaileys(): Promise<BaileysModule> {
  if (baileysMod) return baileysMod;
  // Baileys v7 is ESM-only; dynamic import works from CJS.
  baileysMod = await import('@whiskeysockets/baileys');
  return baileysMod;
}

function allowOutbound(chatId: string): boolean {
  const limit = getEnv().OUTBOUND_RATE_LIMIT_PER_MINUTE;
  const now = Date.now();
  const bucket = rateBuckets.get(chatId);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(chatId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

/** Box–Muller → approx standard normal */
function gaussianSample(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/**
 * Human-like delay: Gaussian jitter in [min,max] + typing-scaled extra.
 * First few replies in a short window get a burst discount (humans reply faster in bursts).
 */
export function computeJitterMs(chatId: string, textLength: number): number {
  const env = getEnv();
  const min = env.WA_JITTER_MIN_MS;
  const max = env.WA_JITTER_MAX_MS;
  const mean = (min + max) / 2;
  const stdDev = Math.max(1, (max - min) / 6);
  let delay = mean + gaussianSample() * stdDev;
  delay = clamp(delay, min, max);

  // ~40 WPM ≈ 200ms/char at raw speed; use a softer 20–30ms/char cap
  const typingExtra = clamp(textLength * 22, 0, 3500);
  delay += typingExtra * 0.45;

  const now = Date.now();
  const burst = burstBuckets.get(chatId);
  if (!burst || now >= burst.resetAt) {
    burstBuckets.set(chatId, { count: 1, resetAt: now + 45_000 });
  } else if (burst.count < 3) {
    burst.count += 1;
    delay *= 0.55; // faster for first replies in a turn
  } else {
    burst.count += 1;
  }

  return Math.round(clamp(delay, min, max + 3500));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Normalize WAHA-style @c.us / bare phone → Baileys @s.whatsapp.net (keep @lid). */
export function toBaileysJid(chatId: string): string {
  if (chatId.includes('@')) {
    if (chatId.endsWith('@c.us')) {
      return `${chatId.split('@')[0]}@s.whatsapp.net`;
    }
    return chatId;
  }
  const digits = normalizePhone(chatId);
  return `${digits}@s.whatsapp.net`;
}

function getSock(): WASocket {
  if (!sock) {
    throw new Error('WhatsApp socket not ready — scan QR / wait for connection');
  }
  return sock;
}

async function humanizeBeforeSend(
  jid: string,
  textLength: number
): Promise<void> {
  const s = getSock();
  const delay = computeJitterMs(jid, textLength);
  try {
    await s.presenceSubscribe(jid);
  } catch {
    /* ignore */
  }
  try {
    await s.sendPresenceUpdate('composing', jid);
  } catch {
    /* ignore */
  }

  // Presence composing expires ~10s — refresh on long delays
  let remaining = delay;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 8_000);
    await sleep(chunk);
    remaining -= chunk;
    if (remaining > 0) {
      try {
        await s.sendPresenceUpdate('composing', jid);
      } catch {
        /* ignore */
      }
    }
  }

  try {
    await s.sendPresenceUpdate('paused', jid);
  } catch {
    /* ignore */
  }
}

export async function sendText(chatId: string, text: string): Promise<void> {
  if (!allowOutbound(chatId)) {
    console.warn('Outbound rate limit hit for', chatId);
    return;
  }
  const jid = toBaileysJid(chatId);
  try {
    await humanizeBeforeSend(jid, text.length);
    await getSock().sendMessage(jid, { text });
    console.log(`[WA] sent text to ${jid}`);
  } catch (err) {
    console.error(`[WA] sendText failed for ${jid}:`, err);
    console.log(`[WA fallback log] → ${jid}: ${text}`);
  }
}

/** Send an image (buffer or local file path) with optional caption. */
export async function sendImage(
  chatId: string,
  image: Buffer | string,
  caption?: string
): Promise<void> {
  if (!allowOutbound(chatId)) {
    console.warn('Outbound rate limit hit for', chatId);
    return;
  }
  const jid = toBaileysJid(chatId);
  const captionText = caption?.trim() || undefined;
  try {
    await humanizeBeforeSend(jid, captionText?.length ?? 24);
    const payload =
      typeof image === 'string'
        ? { image: { url: image }, caption: captionText }
        : { image, caption: captionText };
    await getSock().sendMessage(jid, payload);
    console.log(`[WA] sent image to ${jid}`);
  } catch (err) {
    console.error(`[WA] sendImage failed for ${jid}:`, err);
    if (captionText) {
      await sendText(chatId, captionText);
    }
  }
}

/** Send a PDF (or other document) with optional caption. */
export async function sendDocument(
  chatId: string,
  file: Buffer,
  opts: { fileName: string; mimetype?: string; caption?: string }
): Promise<boolean> {
  if (!allowOutbound(chatId)) {
    console.warn('Outbound rate limit hit for', chatId);
    return false;
  }
  const jid = toBaileysJid(chatId);
  const caption = opts.caption?.trim() || undefined;
  try {
    await humanizeBeforeSend(jid, caption?.length ?? 24);
    await getSock().sendMessage(jid, {
      document: file,
      mimetype: opts.mimetype || 'application/pdf',
      fileName: opts.fileName,
      caption,
    });
    console.log(`[WA] sent document ${opts.fileName} to ${jid}`);
    return true;
  } catch (err) {
    console.error(`[WA] sendDocument failed for ${jid}:`, err);
    if (caption) await sendText(chatId, caption);
    return false;
  }
}

/** Mark recent inbound messages as read (double blue ticks). */
export async function sendSeen(chatId: string): Promise<void> {
  const jid = toBaileysJid(chatId);
  const keys = pendingReadKeys.get(chatId) ?? pendingReadKeys.get(jid);
  if (!keys?.length || !sock) return;
  try {
    await sock.readMessages(keys);
    pendingReadKeys.delete(chatId);
    pendingReadKeys.delete(jid);
  } catch (err) {
    console.warn('[WA] readMessages failed:', err);
  }
}

function textMenu(
  body: string,
  options: Array<{ id: string; text: string }>
): string {
  const exampleName = options[0]?.text?.toLowerCase() || 'browse';
  return [
    body,
    '',
    ...options.map((b, i) => `${i + 1}. ${b.text}`),
    '',
    `Reply with a *number* (e.g. *1*) or the option name (e.g. *${exampleName}*).`,
  ].join('\n');
}

/**
 * Ban-safer menu sender — text numbered menus by default.
 * Interactive list/buttons fingerprint unofficial clients more heavily.
 */
export async function sendMenuMessage(
  chatId: string,
  body: string,
  options: Array<{ id: string; text: string }>
): Promise<'text' | 'list' | 'buttons'> {
  const mode = getEnv().WA_INTERACTIVE_MODE;
  if (mode === 'text') {
    await sendText(chatId, textMenu(body, options));
    return 'text';
  }
  // list/buttons intentionally fall back to text — safer on unofficial
  await sendText(chatId, textMenu(body, options));
  return 'text';
}

export async function sendButtons(
  chatId: string,
  body: string,
  buttons: WahaButton[],
  _footer?: string
): Promise<'buttons' | 'text'> {
  await sendText(chatId, textMenu(body, buttons));
  return 'text';
}

export async function sendList(
  chatId: string,
  body: string,
  _buttonText: string,
  sections: Array<{ title: string; rows: WahaListRow[] }>
): Promise<void> {
  const lines = [body, ''];
  for (const section of sections) {
    lines.push(`*${section.title}*`);
    for (const row of section.rows) {
      lines.push(
        `• ${row.title}${row.description ? ` — ${row.description}` : ''} (${row.id})`
      );
    }
    lines.push('');
  }
  await sendText(chatId, lines.join('\n'));
}

export function getSessionStatus(): {
  status: typeof connectionStatus;
  lastDisconnect: string | null;
  connected: boolean;
  authDir: string;
} {
  return {
    status: connectionStatus,
    lastDisconnect,
    connected: connectionStatus === 'open' && sock !== null,
    authDir: getEnv().WA_AUTH_DIR,
  };
}

/** Active Baileys socket (null if disconnected). Used for media download. */
export function getWhatsAppSocket(): WASocket | null {
  return sock;
}

/**
 * Resolve @lid → real phone. Keep original chatId for replies.
 */
export async function resolvePhoneFromChatId(
  db: Db,
  chatId: string
): Promise<string | null> {
  if (chatId.endsWith('@c.us') || chatId.endsWith('@s.whatsapp.net')) {
    return normalizePhone(chatId.split('@')[0] ?? '');
  }

  if (!chatId.endsWith('@lid')) {
    const digits = normalizePhone(chatId.split('@')[0] ?? chatId);
    return digits.length >= 10 ? digits : null;
  }

  const lid = chatId.includes('@') ? chatId : `${chatId}@lid`;
  const cached = db
    .prepare('SELECT phone FROM whatsapp_lid_map WHERE lid = ?')
    .get(lid) as { phone: string } | undefined;
  if (cached?.phone) return normalizePhone(cached.phone);

  if (sock) {
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(lid);
      if (pn) {
        const phone = normalizePhone(pn.split('@')[0] ?? pn);
        db.prepare(
          `INSERT INTO whatsapp_lid_map (id, lid, phone, chat_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(lid) DO UPDATE SET
             phone = excluded.phone,
             chat_id = excluded.chat_id,
             updated_at = excluded.updated_at`
        ).run(newId('lid'), lid, phone, chatId, nowIso(), nowIso());
        console.log(`[WA] resolved ${lid} → ${phone}`);
        return phone;
      }
    } catch (err) {
      console.warn(`[WA] lid lookup failed for ${lid}:`, err);
    }
  }

  console.warn(`[WA] lid ${lid} has no phone mapping`);
  return null;
}

/**
 * Chat ids to reach a phone on WhatsApp — PN (works with no prior chat)
 * plus any known @lid thread.
 */
export async function resolveOutboundChatIds(
  db: Db,
  phone: string
): Promise<string[]> {
  const normalized = normalizePhone(phone);
  const last10 = normalized.slice(-10);
  const pn = `${normalized}@s.whatsapp.net`;
  const lidIds: string[] = [];
  const pnIds: string[] = [];
  const add = (raw: string | null | undefined, preferPn: boolean) => {
    if (!raw) return;
    const id = raw.includes('@')
      ? raw
      : preferPn
        ? `${raw}@s.whatsapp.net`
        : `${raw}@lid`;
    const bucket = id.endsWith('@lid') ? lidIds : pnIds;
    if (!bucket.includes(id) && !pnIds.includes(id) && !lidIds.includes(id)) {
      bucket.push(id);
    }
  };

  add(pn, true);
  add(normalized, true);

  try {
    const mapped = db
      .prepare(
        `SELECT lid, chat_id FROM whatsapp_lid_map
         WHERE phone = ? OR phone LIKE ?`
      )
      .all(normalized, `%${last10}`) as Array<{
      lid: string;
      chat_id: string | null;
    }>;
    for (const row of mapped) {
      add(row.chat_id, false);
      add(row.lid, false);
    }
  } catch {
    /* table may be missing */
  }

  const s = getWhatsAppSocket();
  if (s) {
    try {
      const lid = await s.signalRepository.lidMapping.getLIDForPN(pn);
      if (typeof lid === 'string' && lid.trim()) add(lid, false);
    } catch {
      /* ok if they have never used this bot */
    }
    for (const query of [normalized, pn, `${normalized}@c.us`]) {
      try {
        const result = await s.onWhatsApp(query);
        const hit = result?.[0];
        if (hit && hit.exists === false) {
          console.warn(`[WA] ${query} is not on WhatsApp`);
          continue;
        }
        if (hit?.jid) add(hit.jid, hit.jid.endsWith('@s.whatsapp.net'));
      } catch {
        /* ignore */
      }
    }
  }

  // Phone JID first so a vendor who never messaged the bot still gets a new chat.
  return [...pnIds, ...lidIds];
}

async function ensureSendSession(jid: string): Promise<void> {
  const s = getWhatsAppSocket();
  if (!s) return;
  try {
    if (typeof s.assertSessions === 'function') {
      await s.assertSessions([jid], true);
    }
  } catch (err) {
    console.warn(`[WA] assertSessions ${jid}:`, err instanceof Error ? err.message : err);
  }
  try {
    await s.presenceSubscribe(jid);
  } catch {
    /* ignore */
  }
}

/** Deliver a vendor PDF even if they have never messaged the bot. */
export async function sendDocumentToPhone(
  db: Db,
  phone: string,
  file: Buffer,
  opts: { fileName: string; mimetype?: string; caption?: string }
): Promise<{ ok: boolean; jid?: string }> {
  const targets = await resolveOutboundChatIds(db, phone);
  console.log(
    `[WA] vendor deliver targets for ${normalizePhone(phone)}: ${targets.join(', ') || '(none)'}`
  );
  if (targets.length === 0) return { ok: false };

  let deliveredJid: string | undefined;
  for (const chatId of targets) {
    const jid = toBaileysJid(chatId);
    await ensureSendSession(jid);
    if (opts.caption) {
      try {
        await sendText(chatId, opts.caption);
      } catch (err) {
        console.warn(
          `[WA] vendor text failed ${jid}`,
          err instanceof Error ? err.message : err
        );
      }
    }
    const ok = await sendDocument(chatId, file, opts);
    if (ok) deliveredJid = jid;
  }
  return { ok: Boolean(deliveredJid), jid: deliveredJid };
}

/** @deprecated WAHA webhook config — no-op under Baileys */
export async function configureSessionWebhook(
  _webhookUrl: string
): Promise<{ ok: boolean; detail: unknown }> {
  return {
    ok: true,
    detail: {
      note: 'Baileys runs in-process; webhooks are not used. Messages arrive via socket events.',
    },
  };
}

function extractText(message: Record<string, unknown> | null | undefined): string | undefined {
  if (!message) return undefined;
  const conversation = message.conversation;
  if (typeof conversation === 'string') return conversation;
  const ext = message.extendedTextMessage as { text?: string } | undefined;
  if (typeof ext?.text === 'string') return ext.text;
  const img = message.imageMessage as { caption?: string } | undefined;
  if (typeof img?.caption === 'string') return img.caption;
  const vid = message.videoMessage as { caption?: string } | undefined;
  if (typeof vid?.caption === 'string') return vid.caption;
  const doc = message.documentMessage as { caption?: string } | undefined;
  if (typeof doc?.caption === 'string') return doc.caption;
  const buttons =
    message.buttonsResponseMessage as { selectedButtonId?: string; selectedDisplayText?: string } | undefined;
  if (typeof buttons?.selectedDisplayText === 'string') return buttons.selectedDisplayText;
  const list =
    message.listResponseMessage as { title?: string; singleSelectReply?: { selectedRowId?: string } } | undefined;
  if (typeof list?.title === 'string') return list.title;
  return undefined;
}

function extractInteractiveId(
  message: Record<string, unknown> | null | undefined
): string | undefined {
  if (!message) return undefined;
  const buttons = message.buttonsResponseMessage as
    | { selectedButtonId?: string }
    | undefined;
  if (typeof buttons?.selectedButtonId === 'string') return buttons.selectedButtonId;
  const list = message.listResponseMessage as
    | { singleSelectReply?: { selectedRowId?: string } }
    | undefined;
  if (typeof list?.singleSelectReply?.selectedRowId === 'string') {
    return list.singleSelectReply.selectedRowId;
  }
  const template = message.templateButtonReplyMessage as
    | { selectedId?: string }
    | undefined;
  if (typeof template?.selectedId === 'string') return template.selectedId;
  return undefined;
}

function extractLocation(
  message: Record<string, unknown> | null | undefined
): IncomingWahaMessage['location'] | undefined {
  if (!message) return undefined;
  const loc = message.locationMessage as
    | {
        degreesLatitude?: number | null;
        degreesLongitude?: number | null;
        name?: string | null;
        address?: string | null;
      }
    | undefined;
  if (
    loc &&
    typeof loc.degreesLatitude === 'number' &&
    typeof loc.degreesLongitude === 'number'
  ) {
    return {
      latitude: loc.degreesLatitude,
      longitude: loc.degreesLongitude,
      description: loc.name ?? loc.address ?? undefined,
    };
  }
  const live = message.liveLocationMessage as
    | {
        degreesLatitude?: number | null;
        degreesLongitude?: number | null;
        caption?: string | null;
      }
    | undefined;
  if (
    live &&
    typeof live.degreesLatitude === 'number' &&
    typeof live.degreesLongitude === 'number'
  ) {
    return {
      latitude: live.degreesLatitude,
      longitude: live.degreesLongitude,
      description: live.caption ?? undefined,
    };
  }
  return undefined;
}

function coerceTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (value && typeof value === 'object' && 'toNumber' in value) {
    const n = (value as { toNumber: () => number }).toNumber();
    return n < 1e12 ? n * 1000 : n;
  }
  return Date.now();
}

function baileysMsgToIncoming(msg: {
  key: {
    remoteJid?: string | null;
    id?: string | null;
    fromMe?: boolean | null;
    participant?: string | null;
  };
  message?: Record<string, unknown> | null;
  messageTimestamp?: unknown;
}): IncomingWahaMessage | null {
  const from = msg.key.remoteJid ?? msg.key.participant ?? null;
  if (!from) return null;

  const location = extractLocation(msg.message ?? undefined);
  const body = extractText(msg.message ?? undefined);
  const buttonOrListId = extractInteractiveId(msg.message ?? undefined);

  return {
    id: msg.key.id ?? `gen_${Date.now()}`,
    timestamp: coerceTimestamp(msg.messageTimestamp),
    from,
    fromMe: Boolean(msg.key.fromMe),
    body,
    type: location
      ? 'location'
      : msg.message?.imageMessage
        ? 'image'
        : 'chat',
    hasMedia: Boolean(
      msg.message?.imageMessage ||
        msg.message?.videoMessage ||
        msg.message?.documentMessage ||
        msg.message?.audioMessage
    ),
    buttonOrListId,
    location,
    event: 'message',
    rawKey: msg.key,
    rawWaMessage: {
      key: msg.key,
      message: msg.message ?? null,
    },
  };
}

/** Compatibility shim — Baileys does not use HTTP webhooks. */
export function parseWahaWebhook(_payload: unknown): IncomingWahaMessage[] {
  return [];
}

export async function startWhatsApp(
  onMessage: (msg: IncomingWahaMessage) => Promise<void>
): Promise<void> {
  if (starting && sock) {
    inboundHandler = onMessage;
    return;
  }
  starting = true;
  inboundHandler = onMessage;

  const baileys = await loadBaileys();
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
  } = baileys;

  const qrcode = await import('qrcode-terminal');
  const pino = (await import('pino')).default;
  silenceLibsignalSessionLogs();

  const env = getEnv();
  const authDir = path.resolve(process.cwd(), env.WA_AUTH_DIR);
  fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  const connect = async (): Promise<void> => {
    connectionStatus = 'connecting';
    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect: ld, qr } = update;
      if (qr) {
        connectionStatus = 'qr';
        console.log('\n[WA] Scan this QR with WhatsApp → Linked Devices:\n');
        qrcode.default.generate(qr, { small: true });
      }
      if (connection === 'open') {
        connectionStatus = 'open';
        lastDisconnect = null;
        console.log('[WA] connected');
      }
      if (connection === 'close') {
        connectionStatus = 'close';
        const err = ld?.error as
          | { output?: { statusCode?: number }; message?: string }
          | undefined;
        const code =
          err?.output?.statusCode ?? DisconnectReason.connectionClosed;
        lastDisconnect = `code=${code} ${err?.message ?? ''}`.trim();
        const loggedOut = code === DisconnectReason.loggedOut;
        console.warn(`[WA] connection closed (${lastDisconnect})`);
        if (!loggedOut) {
          console.log('[WA] reconnecting…');
          try {
            sock?.end(undefined);
          } catch {
            /* ignore */
          }
          sock = null;
          setTimeout(() => {
            void connect();
          }, 2_000);
        } else {
          console.error(
            '[WA] logged out — delete auth folder and scan QR again:',
            authDir
          );
        }
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return;
      for (const raw of messages) {
        const incoming = baileysMsgToIncoming({
          key: raw.key,
          message: raw.message as Record<string, unknown> | null | undefined,
          messageTimestamp: raw.messageTimestamp as number | null | undefined,
        });
        if (!incoming || incoming.fromMe) continue;

        const storeKey = incoming.from;
        const list = pendingReadKeys.get(storeKey) ?? [];
        list.push(incoming.rawKey!);
        pendingReadKeys.set(storeKey, list.slice(-20));

        const handler = inboundHandler;
        if (!handler) continue;
        void handler(incoming).catch((err) => {
          console.error('[WA] inbound handler error:', err);
        });
      }
    });
  };

  await connect();
}

/** libsignal dumps full SessionEntry objects via console.info — hide that noise. */
function silenceLibsignalSessionLogs(): void {
  const swallow = (args: unknown[]): boolean => {
    const first = args[0];
    return typeof first === 'string' && first.startsWith('Closing session');
  };
  const info = console.info.bind(console);
  const log = console.log.bind(console);
  console.info = (...args: unknown[]) => {
    if (swallow(args)) return;
    info(...args);
  };
  console.log = (...args: unknown[]) => {
    if (swallow(args)) return;
    log(...args);
  };
}
