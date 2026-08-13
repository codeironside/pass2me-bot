import { getEnv } from '../config/env';

export interface D1QueryResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export interface D1ApiResponse<T = Record<string, unknown>> {
  result: D1QueryResult<T>[];
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<string>;
}

export class D1Client {
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

  /**
   * Executes a SQL query against Cloudflare D1 REST API.
   * Endpoint: POST https://api.cloudflare.com/client/v4/accounts/{accountId}/d1/database/{databaseId}/query
   */
  public async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> {
    if (!this.isConfigured()) {
      throw new Error(
        'Cloudflare D1 credentials missing. Please set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID, and CLOUDFLARE_API_TOKEN in .env'
      );
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Cloudflare D1 API HTTP error (${response.status}): ${errorText}`
      );
    }

    const data = (await response.json()) as D1ApiResponse<T>;
    if (!data.success || !data.result?.[0]?.success) {
      const errMsg =
        data.errors?.map((e) => e.message).join(', ') ||
        'Unknown Cloudflare D1 error';
      throw new Error(`Cloudflare D1 Query Failure: ${errMsg}`);
    }

    return data.result[0].results;
  }
}

let d1Instance: D1Client | null = null;

export function getD1Client(): D1Client {
  if (!d1Instance) {
    d1Instance = new D1Client();
  }
  return d1Instance;
}
