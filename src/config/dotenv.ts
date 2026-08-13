import path from 'node:path';
import fs from 'node:fs';

/** Shared dotenv loader for CLI scripts and server bootstrap */
export function loadDotEnvFile(fileName = '.env'): void {
  const envPath = path.resolve(process.cwd(), fileName);
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function applyDevEnvDefaults(): void {
  process.env.DATABASE_PATH ??= './data/pas2me.sqlite';
  process.env.BOT_PUBLIC_URL ??= 'http://localhost:8080';
  process.env.WEBHOOK_SECRET ??= 'dev-webhook-secret-change-me';
  process.env.JWT_INVITE_SECRET ??= 'dev-invite-secret-change-me';
  process.env.WA_AUTH_DIR ??= './data/baileys_auth';
  process.env.WA_INTERACTIVE_MODE ??= 'text';
  process.env.SMS_PROVIDER ??= 'mock';
}
