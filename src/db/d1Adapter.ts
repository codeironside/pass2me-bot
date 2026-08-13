import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEnv } from '../config/env';

export interface D1AdapterStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | string };
}

function redact(msg: string): string {
  return msg
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/cfat_[A-Za-z0-9]+/gi, 'cfat_***');
}

export class D1DatabaseAdapter {
  private accountId: string;
  private databaseId: string;
  private apiToken: string;

  constructor(accountId?: string, databaseId?: string, apiToken?: string) {
    const env = getEnv();
    this.accountId = accountId || env.CLOUDFLARE_ACCOUNT_ID || '';
    this.databaseId =
      databaseId ||
      env.CLOUDFLARE_DATABASE_ID ||
      '46009d94-37b4-4536-bc7d-7ec37c389ef0';
    this.apiToken = apiToken || env.CLOUDFLARE_API_TOKEN || '';
  }

  public isConfigured(): boolean {
    return Boolean(this.accountId && this.databaseId && this.apiToken);
  }

  private executeSync(
    sql: string,
    params: unknown[] = []
  ): { results: unknown[]; meta?: Record<string, unknown> } {
    if (!this.isConfigured()) {
      throw new Error(
        'Cloudflare D1 credentials missing. Please set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID, and CLOUDFLARE_API_TOKEN in .env'
      );
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
    const payload = JSON.stringify({ sql: sql.trim(), params });
    const bodyFile = path.join(
      os.tmpdir(),
      `pas2me-d1-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    );
    fs.writeFileSync(bodyFile, payload, 'utf8');

    const runner = `
      const fs = require('fs');
      const body = fs.readFileSync(${JSON.stringify(bodyFile)}, 'utf8');
      fetch(${JSON.stringify(url)}, {
        method: 'POST',
        headers: {
          Authorization: ${JSON.stringify(`Bearer ${this.apiToken}`)},
          'Content-Type': 'application/json',
        },
        body,
      }).then(async (res) => {
        const text = await res.text();
        process.stdout.write(text);
        process.exit(res.ok ? 0 : 2);
      }).catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      });
    `;

    try {
      const output = execFileSync(process.execPath, ['-e', runner], {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30_000,
      });

      const parsed = JSON.parse(output) as {
        success: boolean;
        result?: Array<{
          results: unknown[];
          success: boolean;
          meta?: Record<string, unknown>;
          error?: string;
        }>;
        errors?: Array<{ message: string }>;
      };

      if (!parsed.success || !parsed.result?.[0]?.success) {
        const errorMsg =
          parsed.errors?.map((e) => e.message).join(', ') ||
          parsed.result?.[0]?.error ||
          'D1 query failed';
        throw new Error(`Cloudflare D1 Error: ${errorMsg}`);
      }

      return {
        results: parsed.result[0].results || [],
        meta: parsed.result[0].meta || {},
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const extra =
        err && typeof err === 'object' && 'stdout' in err
          ? String((err as { stdout?: string }).stdout ?? '')
          : '';
      const stderr =
        err && typeof err === 'object' && 'stderr' in err
          ? String((err as { stderr?: string }).stderr ?? '')
          : '';
      throw new Error(
        redact(
          `Cloudflare D1 execution error: ${msg}${extra ? ` | ${extra.slice(0, 500)}` : ''}${stderr ? ` | ${stderr.slice(0, 300)}` : ''}`
        )
      );
    } finally {
      try {
        fs.unlinkSync(bodyFile);
      } catch {
        /* ignore */
      }
    }
  }

  public prepare(sql: string): D1AdapterStatement {
    const adapter = this;
    return {
      get(...params: unknown[]) {
        const flatParams =
          params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        const res = adapter.executeSync(sql, flatParams);
        return res.results[0] ?? undefined;
      },
      all(...params: unknown[]) {
        const flatParams =
          params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        const res = adapter.executeSync(sql, flatParams);
        return res.results;
      },
      run(...params: unknown[]) {
        const flatParams =
          params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
        const res = adapter.executeSync(sql, flatParams);
        const meta = res.meta || {};
        return {
          changes: (meta.changes as number) ?? 0,
          lastInsertRowid: (meta.last_row_id as number | string) ?? 0,
        };
      },
    };
  }

  public exec(sql: string): void {
    const chunks = sql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('--'));
    if (chunks.length === 0) return;
    for (const chunk of chunks) {
      this.executeSync(chunk, []);
    }
  }

  public pragma(_statement: string): void {
    // No-op for D1
  }

  public transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    // D1 REST cannot hold a transaction across separate HTTP calls.
    return ((...args: unknown[]) => fn(...args)) as T;
  }

  public close(): void {
    // No-op for D1 REST connection
  }
}
