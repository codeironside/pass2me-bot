# Pas2me WhatsApp Bot

Type-strict Express + TypeScript WhatsApp bot for [Pas2me](https://www.pas2me.com/), using **Baileys** (in-process). Talks to a SQLite DB that mirrors the Pass2Me platform schema (additive bot tables only). Does **not** modify `wa-stores-main`.

> Unofficial WhatsApp Web client. Meta can still restrict the number. Prefer a dedicated business SIM. This bot uses text menus, rate limits, and Gaussian reply jitter to reduce bot-like fingerprints.

## Quick start

```bash
cp .env.example .env
npm install
npm run migrate
npm run dev
```

On first run, scan the **QR code** printed in the terminal (WhatsApp → Linked Devices). Auth is saved under `WA_AUTH_DIR` (default `./data/baileys_auth`).

Health: `GET /health`  
WhatsApp status: `GET /debug/whatsapp`

## Env swap

Point `DATABASE_PATH` at your test SQLite copy locally. In production, set the same env vars to the shared prod DB path/credentials.

Key WhatsApp env:

| Var | Purpose |
|-----|---------|
| `WA_AUTH_DIR` | Baileys session files |
| `WA_INTERACTIVE_MODE` | `text` (recommended) |
| `WA_JITTER_MIN_MS` / `WA_JITTER_MAX_MS` | Human-like delay before sends |
| `OUTBOUND_RATE_LIMIT_PER_MINUTE` | Cap replies per chat |

## Key flows

- **Customer:** browse/search marketplace → product info → cart → checkout (Monnify / wallet / bank transfer) → status / cancel / reorder
- **Merchant:** orders, stock, stats, POS sale, refunds, staff invites
- **Wallet:** Monnify virtual account + top-up, withdraw, auto top-up, Flutterwave airtime
- **Developer backroom:** user/order lookup, ledger, manual credit (gated)

## Fix “bot not responding”

1. Restart: `npm run dev`
2. Open `http://localhost:8080/debug/whatsapp` — `session.status` should be `open`
3. If status is `qr`, scan the QR in the bot console again
4. If logged out, delete `WA_AUTH_DIR` and restart to pair again
5. Watch logs for `[WA] msg from=…` then `[WA] sent text…`
