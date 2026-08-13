import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
  type RGB,
} from 'pdf-lib';
import { formatNgn, kobo, type Kobo } from '../domain/money';
import { loadCoverBytes } from './media';
import type { CartItem } from '../db/repos';
import type { Db } from '../db/client';

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 36;
const OLIVE = rgb(61 / 255, 74 / 255, 31 / 255);
const SAGE = rgb(143 / 255, 163 / 255, 122 / 255);
const WHITE = rgb(1, 1, 1);
const INK = rgb(0.18, 0.2, 0.18);
const MUTED = rgb(0.42, 0.44, 0.4);
const ROW_ALT = rgb(0.96, 0.96, 0.94);
const LINE = rgb(0.86, 0.88, 0.84);

function firstHttpUrl(value: unknown, depth = 0): string | null {
  if (value == null || depth > 4) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === '[]' || trimmed === '{}' || trimmed === 'null') {
      return null;
    }
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    try {
      return firstHttpUrl(JSON.parse(trimmed), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstHttpUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    return firstHttpUrl(
      rec.url ?? rec.src ?? rec.image_url ?? rec.secure_url ?? rec.path,
      depth + 1
    );
  }
  return null;
}

async function loadProductImageBytes(
  db: Db,
  productId: string
): Promise<Buffer | null> {
  const row = db
    .prepare(`SELECT images FROM products WHERE id = ?`)
    .get(productId) as { images?: unknown } | undefined;
  const url = firstHttpUrl(row?.images);
  if (!url) return null;
  const bytes = await loadCoverBytes(url);
  if (!bytes) return null;
  if (typeof bytes === 'string') {
    const fetched = await loadCoverBytes(bytes);
    return typeof fetched === 'string' ? null : fetched;
  }
  return bytes;
}

function winAnsi(text: string): string {
  return text
    .replace(/₦/g, 'NGN ')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');
}

function pdfNgn(amount: Kobo): string {
  return winAnsi(formatNgn(amount).replace('₦', 'NGN '));
}

function drawRight(
  page: PDFPage,
  text: string,
  xRight: number,
  y: number,
  size: number,
  font: PDFFont,
  color: RGB
): void {
  const safe = winAnsi(text);
  const w = font.widthOfTextAtSize(safe, size);
  page.drawText(safe, { x: xRight - w, y, size, font, color });
}

function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  const safe = winAnsi(text);
  if (font.widthOfTextAtSize(safe, size) <= maxWidth) return safe;
  let t = safe;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > maxWidth) {
    t = t.slice(0, -1);
  }
  return winAnsi(`${t}...`);
}

function formatIssuedAt(d: Date): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${months[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}, ${d.getFullYear()} ${hh}:${mm}`;
}

export async function buildOrderReceiptPdf(
  db: Db,
  params: {
    orderNumber: string;
    storeName: string;
    storeAddress?: string | null;
    storePhone?: string | null;
    buyerName: string;
    buyerPhone: string;
    cart: CartItem[];
    itemsTotal: Kobo;
    deliveryFeeKobo: number;
    total: Kobo;
    fulfillment: string;
    paidVia: string;
    audience: 'buyer' | 'vendor';
    issuedAt?: Date;
  }
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const issued = formatIssuedAt(params.issuedAt ?? new Date());

  // Header bar
  page.drawRectangle({
    x: 0,
    y: PAGE_H - 72,
    width: PAGE_W,
    height: 72,
    color: OLIVE,
  });
  page.drawText('RECEIPT', {
    x: MARGIN,
    y: PAGE_H - 48,
    size: 26,
    font: bold,
    color: WHITE,
  });
  drawRight(
    page,
    `#${params.orderNumber}`,
    PAGE_W - MARGIN,
    PAGE_H - 38,
    11,
    bold,
    WHITE
  );
  drawRight(page, issued, PAGE_W - MARGIN, PAGE_H - 54, 9, font, WHITE);

  let y = PAGE_H - 100;
  page.drawText('MERCHANT', {
    x: MARGIN,
    y,
    size: 8,
    font: bold,
    color: SAGE,
  });
  page.drawText('TRANSACTION', {
    x: 320,
    y,
    size: 8,
    font: bold,
    color: SAGE,
  });
  y -= 16;
  page.drawText(fit(params.storeName, bold, 12, 250), {
    x: MARGIN,
    y,
    size: 12,
    font: bold,
    color: INK,
  });
  page.drawText('Status: Paid', {
    x: 320,
    y,
    size: 10,
    font,
    color: INK,
  });
  y -= 14;
  if (params.storeAddress) {
    page.drawText(fit(params.storeAddress, font, 9, 250), {
      x: MARGIN,
      y,
      size: 9,
      font,
      color: MUTED,
    });
  }
  page.drawText(winAnsi(`Fulfillment: ${params.fulfillment}`), {
    x: 320,
    y,
    size: 10,
    font,
    color: INK,
  });
  y -= 14;
  page.drawText(
    params.audience === 'vendor' ? 'Copy: Vendor' : 'Copy: Customer',
    { x: MARGIN, y, size: 9, font, color: MUTED }
  );
  page.drawText(winAnsi(`Buyer: ${fit(params.buyerName, font, 10, 160)}`), {
    x: 320,
    y,
    size: 10,
    font,
    color: INK,
  });
  y -= 14;
  page.drawText(winAnsi(`Phone: ${params.buyerPhone}`), {
    x: 320,
    y,
    size: 10,
    font,
    color: INK,
  });
  if (params.storePhone) {
    page.drawText(winAnsi(`Store: ${params.storePhone}`), {
      x: MARGIN,
      y,
      size: 9,
      font,
      color: MUTED,
    });
  }

  y -= 22;
  const tableLeft = MARGIN;
  const tableRight = PAGE_W - MARGIN;
  const tableW = tableRight - tableLeft;
  const colImg = tableLeft + 6;
  const colDesc = tableLeft + 52;
  const colPrice = 340;
  const colQty = 430;
  const colTotal = tableRight - 8;

  page.drawRectangle({
    x: tableLeft,
    y: y - 8,
    width: tableW,
    height: 22,
    color: SAGE,
  });
  page.drawText('ITEM', {
    x: colDesc,
    y: y - 2,
    size: 8,
    font: bold,
    color: WHITE,
  });
  page.drawText('PRICE', {
    x: colPrice,
    y: y - 2,
    size: 8,
    font: bold,
    color: WHITE,
  });
  page.drawText('QTY', {
    x: colQty,
    y: y - 2,
    size: 8,
    font: bold,
    color: WHITE,
  });
  drawRight(page, 'TOTAL', colTotal, y - 2, 8, bold, WHITE);
  y -= 8;

  const rowH = 54;
  let rowIndex = 0;
  for (const item of params.cart) {
    if (y - rowH < 160) break;
    y -= rowH;
    if (rowIndex % 2 === 1) {
      page.drawRectangle({
        x: tableLeft,
        y,
        width: tableW,
        height: rowH,
        color: ROW_ALT,
      });
    }
    page.drawLine({
      start: { x: tableLeft, y },
      end: { x: tableRight, y },
      thickness: 0.4,
      color: LINE,
    });

    const imgBytes = await loadProductImageBytes(db, item.product_id);
    if (imgBytes && imgBytes.length > 32) {
      try {
        const isPng = imgBytes[0] === 0x89 && imgBytes[1] === 0x50;
        const embedded = isPng
          ? await pdf.embedPng(imgBytes)
          : await pdf.embedJpg(imgBytes);
        const dims = embedded.scale(1);
        const max = 40;
        const scale = Math.min(max / dims.width, max / dims.height);
        const w = dims.width * scale;
        const h = dims.height * scale;
        page.drawImage(embedded, {
          x: colImg,
          y: y + (rowH - h) / 2,
          width: w,
          height: h,
        });
      } catch {
        /* skip webp / bad images */
      }
    }

    const unit = pdfNgn(kobo(item.unit_price_kobo));
    const line = pdfNgn(kobo(item.unit_price_kobo * item.quantity));
    page.drawText(fit(item.name, font, 10, 220), {
      x: colDesc,
      y: y + 22,
      size: 10,
      font: bold,
      color: INK,
    });
    page.drawText(unit, {
      x: colPrice,
      y: y + 22,
      size: 9,
      font,
      color: INK,
    });
    page.drawText(String(item.quantity), {
      x: colQty + 8,
      y: y + 22,
      size: 9,
      font,
      color: INK,
    });
    drawRight(page, line, colTotal, y + 22, 9, bold, INK);
    rowIndex += 1;
  }

  y -= 28;
  page.drawText('PAYMENT METHOD', {
    x: MARGIN,
    y,
    size: 8,
    font: bold,
    color: SAGE,
  });
  page.drawText('CUSTOMER SERVICE', {
    x: MARGIN,
    y: y - 36,
    size: 8,
    font: bold,
    color: SAGE,
  });
  page.drawText(winAnsi(params.paidVia), {
    x: MARGIN,
    y: y - 14,
    size: 10,
    font,
    color: INK,
  });
  page.drawText('www.pas2me.com', {
    x: MARGIN,
    y: y - 50,
    size: 9,
    font,
    color: MUTED,
  });

  const boxW = 220;
  const boxX = PAGE_W - MARGIN - boxW;
  let ty = y;
  drawRight(
    page,
    `SUBTOTAL    ${pdfNgn(params.itemsTotal)}`,
    PAGE_W - MARGIN,
    ty,
    10,
    font,
    INK
  );
  ty -= 16;
  if (params.deliveryFeeKobo > 0) {
    drawRight(
      page,
      `DELIVERY    ${pdfNgn(kobo(params.deliveryFeeKobo))}`,
      PAGE_W - MARGIN,
      ty,
      10,
      font,
      INK
    );
    ty -= 18;
  } else {
    ty -= 8;
  }

  page.drawRectangle({
    x: boxX,
    y: ty - 10,
    width: 72,
    height: 32,
    color: SAGE,
  });
  page.drawRectangle({
    x: boxX + 72,
    y: ty - 10,
    width: boxW - 72,
    height: 32,
    color: OLIVE,
  });
  page.drawText('TOTAL', {
    x: boxX + 14,
    y: ty,
    size: 10,
    font: bold,
    color: WHITE,
  });
  drawRight(
    page,
    pdfNgn(params.total),
    PAGE_W - MARGIN - 10,
    ty,
    13,
    bold,
    WHITE
  );

  page.drawRectangle({
    x: 0,
    y: 0,
    width: PAGE_W,
    height: 52,
    color: OLIVE,
  });
  const footer1 =
    params.audience === 'vendor'
      ? 'Paid order — reply merchant on WhatsApp to fulfill.'
      : 'Keep this receipt for your records.';
  const footer1W = font.widthOfTextAtSize(footer1, 8);
  page.drawText(winAnsi(footer1), {
    x: (PAGE_W - footer1W) / 2,
    y: 28,
    size: 8,
    font,
    color: WHITE,
  });
  const footer2 = 'Thank you for shopping!';
  const footer2W = font.widthOfTextAtSize(footer2, 9);
  page.drawText(footer2, {
    x: (PAGE_W - footer2W) / 2,
    y: 14,
    size: 9,
    font: bold,
    color: WHITE,
  });

  return Buffer.from(await pdf.save());
}
