import fs from 'node:fs';
import path from 'node:path';
import { getEnv } from '../config/env';
import { newId } from '../domain/ids';
import type { IncomingWahaMessage } from './whatsapp';
import { getWhatsAppSocket } from './whatsapp';

const COVER_DIR = path.resolve(process.cwd(), 'data', 'store-covers');
const PRODUCT_DIR = path.resolve(process.cwd(), 'data', 'product-photos');

export function ensureStoreCoverDir(): string {
  fs.mkdirSync(COVER_DIR, { recursive: true });
  return COVER_DIR;
}

export function ensureProductPhotoDir(): string {
  fs.mkdirSync(PRODUCT_DIR, { recursive: true });
  return PRODUCT_DIR;
}

export function storeCoverPublicPath(): string {
  return COVER_DIR;
}

/** Persist a cover image and return a public URL under BOT_PUBLIC_URL. */
export async function saveStoreCover(
  buffer: Buffer,
  ext: string
): Promise<string> {
  ensureStoreCoverDir();
  const safeExt = ext.replace(/[^a-z0-9]/gi, '') || 'jpg';
  const filename = `${newId('cov')}.${safeExt}`;
  const filePath = path.join(COVER_DIR, filename);
  await fs.promises.writeFile(filePath, buffer);
  const base = getEnv().BOT_PUBLIC_URL.replace(/\/$/, '');
  return `${base}/media/store-covers/${filename}`;
}

/** Persist a product photo and return a public URL the website can load. */
export async function saveProductPhoto(
  buffer: Buffer,
  ext: string
): Promise<string> {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '') || 'jpg';
  const filename = `${newId('pimg')}.${safeExt}`;
  const mime =
    safeExt === 'png'
      ? 'image/png'
      : safeExt === 'webp'
        ? 'image/webp'
        : safeExt === 'gif'
          ? 'image/gif'
          : 'image/jpeg';
  const hosted = await uploadPublicObject(
    `products/${filename}`,
    buffer,
    mime
  );
  if (hosted) return hosted;

  ensureProductPhotoDir();
  const filePath = path.join(PRODUCT_DIR, filename);
  await fs.promises.writeFile(filePath, buffer);
  const base = getEnv().BOT_PUBLIC_URL.replace(/\/$/, '');
  console.warn(
    '[media] product photo saved locally only — website cannot load this URL. Set R2_PUBLIC_BASE_URL and Cloudflare R2 credentials.'
  );
  return `${base}/media/product-photos/${filename}`;
}

async function uploadPublicObject(
  key: string,
  buffer: Buffer,
  contentType: string
): Promise<string | null> {
  const env = getEnv();
  const accountId = env.R2_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  const bucket = env.R2_BUCKET || 'pas2me-storage';
  const publicBase = env.R2_PUBLIC_BASE_URL?.replace(/\/$/, '');
  if (!accountId || !token || !publicBase) return null;

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${key}`;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': contentType,
      },
      body: new Uint8Array(buffer),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(
        `[media] R2 upload failed ${res.status} ${text.slice(0, 300)}`
      );
      return null;
    }
    return `${publicBase}/${key}`;
  } catch (err) {
    console.error('[media] R2 upload error', err);
    return null;
  }
}

function localPathFromMediaUrl(url: string): string | null {
  const maps: Array<{ marker: string; dir: string }> = [
    { marker: '/media/store-covers/', dir: COVER_DIR },
    { marker: '/media/product-photos/', dir: PRODUCT_DIR },
  ];
  for (const { marker, dir } of maps) {
    const idx = url.indexOf(marker);
    if (idx === -1) continue;
    const filename = (url.slice(idx + marker.length).split('?')[0] ?? '').trim();
    if (
      !filename ||
      filename.includes('..') ||
      filename.includes('/') ||
      filename.includes('\\')
    ) {
      return null;
    }
    const full = path.join(dir, filename);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/** Resolve a stored cover/product URL back to a local file path when we host it. */
export function localPathFromCoverUrl(url: string): string | null {
  return localPathFromMediaUrl(url);
}

/** Load cover bytes for WhatsApp send (local file preferred; else fetch http URL). */
export async function loadCoverBytes(
  bannerUrl: string
): Promise<Buffer | string | null> {
  const local = localPathFromCoverUrl(bannerUrl);
  if (local) return local;
  if (/^https?:\/\//i.test(bannerUrl)) {
    try {
      const res = await fetch(bannerUrl, {
        redirect: 'follow',
        headers: {
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
      });
      if (!res.ok) {
        console.warn(
          `[media] cover fetch ${res.status} ${bannerUrl.slice(0, 120)}`
        );
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length > 0 ? buf : null;
    } catch (err) {
      console.warn(
        `[media] cover fetch failed ${bannerUrl.slice(0, 120)}`,
        err instanceof Error ? err.message : err
      );
      return null;
    }
  }
  return null;
}

export async function downloadInboundImage(
  msg: IncomingWahaMessage
): Promise<{ buffer: Buffer; mime: string; ext: string } | null> {
  const sock = getWhatsAppSocket();
  const raw = msg.rawWaMessage;
  if (!sock || !raw?.message) return null;

  const image = raw.message.imageMessage as
    | { mimetype?: string | null }
    | undefined;
  if (!image) return null;

  try {
    const baileys = await import('@whiskeysockets/baileys');
    const buffer = (await baileys.downloadMediaMessage(
      raw as Parameters<typeof baileys.downloadMediaMessage>[0],
      'buffer',
      {},
      {
        logger: (await import('pino')).default({ level: 'silent' }),
        reuploadRequest: sock.updateMediaMessage.bind(sock),
      }
    )) as Buffer;

    const mime = image.mimetype || 'image/jpeg';
    const ext =
      mime.includes('png')
        ? 'png'
        : mime.includes('webp')
          ? 'webp'
          : mime.includes('gif')
            ? 'gif'
            : 'jpg';
    return { buffer, mime, ext };
  } catch (err) {
    console.error('[media] downloadInboundImage failed', err);
    return null;
  }
}
