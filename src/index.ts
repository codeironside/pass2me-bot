import express from 'express';
import path from 'node:path';
import { loadDotEnvFile, applyDevEnvDefaults } from './config/dotenv';
import { loadEnv } from './config/env';
import { getDb, runMigrations } from './db/client';
import { createHttpRouter } from './http/routes';
import { startWhatsApp } from './services/whatsapp';
import { ensureStoreCoverDir } from './services/media';
import { handleIncomingWhatsAppMessage } from './bot/router';
import { startMonnifyDepositPoller } from './services/monnifyPoll';

async function main(): Promise<void> {
  loadDotEnvFile();
  applyDevEnvDefaults();

  const env = loadEnv();
  const db = getDb();
  runMigrations(db);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(
    '/media/store-covers',
    express.static(ensureStoreCoverDir(), {
      maxAge: '7d',
      fallthrough: false,
    })
  );
  app.use(createHttpRouter(db));

  await startWhatsApp((msg) => handleIncomingWhatsAppMessage(db, msg));

  app.listen(env.PORT, () => {
    console.log(`Pas2me bot listening on :${env.PORT}`);
    console.log(`WhatsApp auth=${env.WA_AUTH_DIR} (Baileys in-process)`);
    console.log(
      `Jitter ${env.WA_JITTER_MIN_MS}-${env.WA_JITTER_MAX_MS}ms | rate ${env.OUTBOUND_RATE_LIMIT_PER_MINUTE}/min`
    );
    const isRemoteD1 = Boolean(
      env.CLOUDFLARE_D1_REMOTE &&
        env.CLOUDFLARE_ACCOUNT_ID &&
        env.CLOUDFLARE_API_TOKEN
    );
    const localD1 =
      env.DATABASE_PATH.includes('miniflare-D1DatabaseObject') ||
      env.DATABASE_PATH.includes('pas2me-stores');
    console.log(
      `DB=${
        isRemoteD1
          ? `Cloudflare D1 remote (${env.CLOUDFLARE_DATABASE_ID})`
          : localD1
            ? `local D1 pas2me-stores (${env.DATABASE_PATH})`
            : env.DATABASE_PATH
      }`
    );
    console.log(
      `Store covers=${path.resolve(process.cwd(), 'data', 'store-covers')}`
    );
    console.log(
      `Monnify webhook (instant):\n  ${env.BOT_PUBLIC_URL}/webhooks/monnify`
    );
    if (env.MONNIFY_BASE_URL.includes('sandbox')) {
      console.log(
        'Monnify is SANDBOX — real bank transfers will not notify. Use Monnify test payments, or switch to live keys.'
      );
    }
    startMonnifyDepositPoller(db);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
