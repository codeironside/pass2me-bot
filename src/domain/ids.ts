import { nanoid } from 'nanoid';

export function newId(prefix?: string): string {
  const id = nanoid(21);
  return prefix ? `${prefix}_${id}` : id;
}

/** Nigeria-focused phone normalization → digits only, country code 234 */
export function normalizePhone(input: string): string {
  // Baileys JIDs look like 234xxxxxxxxxx:0@s.whatsapp.net — `:0` is a device id.
  const withoutJid = input.split('@')[0] ?? input;
  const withoutDevice = withoutJid.replace(/:\d+$/, '');
  let digits = withoutDevice.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0') && digits.length === 11) {
    digits = `234${digits.slice(1)}`;
  }
  if (
    digits.length === 10 &&
    (digits.startsWith('7') || digits.startsWith('8') || digits.startsWith('9'))
  ) {
    digits = `234${digits}`;
  }
  // Typed as +234 0xxxxxxxxxx (local leading zero kept after country code)
  if (digits.startsWith('2340') && digits.length === 14) {
    digits = `234${digits.slice(4)}`;
  }
  // Device id leaked as an extra trailing digit (234 + 11 digits)
  if (digits.startsWith('234') && digits.length === 14) {
    digits = digits.slice(0, 13);
  }
  return digits;
}

export function phoneToWahaChatId(normalizedPhone: string): string {
  const digits = normalizePhone(normalizedPhone);
  return `${digits}@c.us`;
}

export function chatIdToPhone(chatId: string): string | null {
  if (shouldIgnoreChatId(chatId)) return null;
  const raw = chatId.split('@')[0] ?? '';
  if (!raw || raw === 'status') return null;
  // @lid is WhatsApp linked-id — keep digits as conversation key
  return normalizePhone(raw);
}

export function isGroupChatId(chatId: string): boolean {
  return chatId.endsWith('@g.us');
}

/** Status updates, newsletters, broadcasts — never reply */
export function shouldIgnoreChatId(chatId: string): boolean {
  const id = chatId.toLowerCase();
  return (
    id === 'status@broadcast' ||
    id.endsWith('@broadcast') ||
    id.endsWith('@newsletter') ||
    id.endsWith('@g.us') ||
    id.includes('status@broadcast')
  );
}

export function nowIso(): string {
  return new Date().toISOString();
}
