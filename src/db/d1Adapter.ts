import { Worker } from 'node:worker_threads';
import dns from 'node:dns';
import { getEnv } from '../config/env';

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  /* older Node */
}

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

const WORKER_SOURCE = `
const { workerData } = require('worker_threads');
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

const control = workerData.control;
const reqBuf = workerData.reqBuf;
const reqLen = workerData.reqLen;
const resBuf = workerData.resBuf;
const resLen = workerData.resLen;

function readJob() {
  const n = Atomics.load(reqLen, 0);
  return JSON.parse(Buffer.from(reqBuf.buffer, reqBuf.byteOffset, n).toString('utf8'));
}

function writeResult(obj) {
  const raw = Buffer.from(JSON.stringify(obj), 'utf8');
  if (raw.length > resBuf.length) {
    throw new Error('D1 response too large for worker buffer');
  }
  raw.copy(Buffer.from(resBuf.buffer, resBuf.byteOffset, resBuf.length));
  Atomics.store(resLen, 0, raw.length);
}

async function queryOnce(job) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25000);
  try {
    const res = await fetch(job.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + job.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql: job.sql, params: job.params }),
      signal: ac.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

function isRetryable(status, errMsg) {
  if (errMsg) {
    const m = errMsg.toLowerCase();
    if (m.includes('fetch failed') || m.includes('aborted') || m.includes('econn') || m.includes('etimedout') || m.includes('network')) {
      return true;
    }
  }
  return status === 429 || status === 502 || status === 503 || status === 504;
}

(async function loop() {
  while (true) {
    Atomics.wait(control, 0, 0);
    if (Atomics.load(control, 0) !== 1) continue;
    try {
      const job = readJob();
      let last = { ok: false, status: 0, text: '', error: 'no attempt' };
      for (let i = 0; i < 4; i++) {
        try {
          last = await queryOnce(job);
          if (last.ok || !isRetryable(last.status, '')) break;
        } catch (err) {
          last = { ok: false, status: 0, text: '', error: err instanceof Error ? err.message : String(err) };
          if (!isRetryable(0, last.error) || i === 3) break;
        }
        await new Promise((r) => setTimeout(r, 250 * (i + 1)));
      }
      writeResult(last);
      Atomics.store(control, 0, last.ok || last.text ? 2 : 3);
    } catch (err) {
      try {
        writeResult({ ok: false, status: 0, text: '', error: err instanceof Error ? err.message : String(err) });
      } catch {}
      Atomics.store(control, 0, 3);
    }
    Atomics.notify(control, 0);
  }
})();
`;

type WorkerBundle = {
  worker: Worker;
  control: Int32Array;
  lock: Int32Array;
  reqBuf: Uint8Array;
  reqLen: Int32Array;
  resBuf: Uint8Array;
  resLen: Int32Array;
};

let bundle: WorkerBundle | null = null;

function acquire(lock: Int32Array): void {
  while (Atomics.compareExchange(lock, 0, 0, 1) !== 0) {
    Atomics.wait(lock, 0, 1);
  }
}

function release(lock: Int32Array): void {
  Atomics.store(lock, 0, 0);
  Atomics.notify(lock, 0, 1);
}

function startWorker(): WorkerBundle {
  const control = new Int32Array(new SharedArrayBuffer(4));
  const lock = new Int32Array(new SharedArrayBuffer(4));
  const reqBuf = new Uint8Array(new SharedArrayBuffer(512 * 1024));
  const reqLen = new Int32Array(new SharedArrayBuffer(4));
  const resBuf = new Uint8Array(new SharedArrayBuffer(2 * 1024 * 1024));
  const resLen = new Int32Array(new SharedArrayBuffer(4));

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { control, reqBuf, reqLen, resBuf, resLen },
  });
  worker.on('error', (err) => {
    console.error('[D1] worker error:', err);
    bundle = null;
    try {
      Atomics.store(control, 0, 3);
      Atomics.notify(control, 0);
    } catch {
      /* ignore */
    }
  });
  worker.on('exit', (code) => {
    if (code !== 0) {
      console.error(`[D1] worker exited ${code}`);
      bundle = null;
    }
  });

  return { worker, control, lock, reqBuf, reqLen, resBuf, resLen };
}

function ensureWorker(): WorkerBundle {
  if (bundle) return bundle;
  bundle = startWorker();
  return bundle;
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
    const job = {
      url,
      token: this.apiToken,
      sql: sql.trim(),
      params,
    };
    const payload = Buffer.from(JSON.stringify(job), 'utf8');
    const w = ensureWorker();
    if (payload.length > w.reqBuf.length) {
      throw new Error('D1 query payload too large');
    }

    acquire(w.lock);
    try {
      payload.copy(Buffer.from(w.reqBuf.buffer, w.reqBuf.byteOffset, w.reqBuf.length));
      Atomics.store(w.reqLen, 0, payload.length);
      Atomics.store(w.control, 0, 1);
      Atomics.notify(w.control, 0);
      const waited = Atomics.wait(w.control, 0, 1, 35_000);
      if (waited === 'timed-out') {
        bundle = null;
        try {
          w.worker.terminate();
        } catch {
          /* ignore */
        }
        throw new Error('Cloudflare D1 execution error: worker timed out');
      }

      const n = Atomics.load(w.resLen, 0);
      const raw = Buffer.from(w.resBuf.buffer, w.resBuf.byteOffset, n).toString('utf8');
      Atomics.store(w.control, 0, 0);

      const reply = JSON.parse(raw) as {
        ok?: boolean;
        status?: number;
        text?: string;
        error?: string;
      };

      if (reply.error && !reply.text) {
        throw new Error(`Cloudflare D1 execution error: ${reply.error}`);
      }

      if (!reply.ok) {
        throw new Error(
          redact(
            `Cloudflare D1 execution error: HTTP ${reply.status ?? 0} ${String(reply.text ?? reply.error ?? '').slice(0, 400)}`
          )
        );
      }

      const parsed = JSON.parse(reply.text || '{}') as {
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
    } finally {
      release(w.lock);
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
    const withoutLineComments = sql
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    const chunks = withoutLineComments
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (chunks.length === 0) return;
    for (const chunk of chunks) {
      this.executeSync(chunk, []);
    }
  }

  public pragma(_statement: string): void {
    // No-op for D1
  }

  public transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    return ((...args: unknown[]) => fn(...args)) as T;
  }

  public close(): void {
    if (bundle) {
      try {
        bundle.worker.terminate();
      } catch {
        /* ignore */
      }
      bundle = null;
    }
  }
}
