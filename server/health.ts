import type { Pool, QueryConfig } from 'pg';

/**
 * Turns a database failure into a short, secret-free diagnosis. Each of these otherwise surfaces only as
 * "Internal server error" on sign-in.
 */
export function diagnoseDbError(err: unknown): string | null {
  const e = err as { code?: string; message?: string };
  switch (e?.code) {
    case '42P01': // undefined_table
    case '3F000': // invalid_schema_name
      return 'Database schema is missing: migrations have not been applied (run `npm run migrate`).';
    case '28P01': // invalid_password
    case '28000': // invalid_authorization_specification
      return 'Database rejected the credentials in DATABASE_URL.';
    case '3D000': // invalid_catalog_name
      return 'The database named in DATABASE_URL does not exist.';
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ETIMEDOUT':
    case 'ECONNRESET':
      return `Cannot reach the database host in DATABASE_URL (${e.code}).`;
  }
  if (/Query read timeout/i.test(e?.message ?? '')) {
    return 'The database accepted the connection but did not answer in time.';
  }
  if (/timeout exceeded when trying to connect|Connection terminated/i.test(e?.message ?? '')) {
    return 'Cannot reach the database host in DATABASE_URL (connection timed out).';
  }
  return null;
}

export interface HealthReport {
  ok: boolean;
  database: { ok: boolean; problem?: string };
  postgrest: { ok: boolean; problem?: string };
}

/**
 * The database decides `ok`: it is what sign-in needs, and gating deploys on it keeps a misconfigured
 * DATABASE_URL from going live. PostgREST is reported but not gated, since on a first deploy it only
 * comes up after this service's migrations have created its login role.
 */
export async function checkHealth(pool: Pool, postgrestUrl: string): Promise<HealthReport> {
  const database: HealthReport['database'] = { ok: true };
  try {
    // Touches the table every sign-in reads, so a database that is up but unmigrated also fails.
    // query_timeout bounds a stalled connection (pg honours it per query; @types/pg only declares it on
    // the client config). On timeout pool.query releases the client with the error, which destroys it.
    await pool.query({ text: 'select 1 from auth.users limit 1', query_timeout: 3_000 } as QueryConfig);
  } catch (err) {
    database.ok = false;
    const problem = diagnoseDbError(err);
    if (!problem) console.error('Health check: unrecognised database error:', err);
    database.problem = problem ?? 'Database query failed; see the server logs.';
  }

  const postgrest: HealthReport['postgrest'] = { ok: true };
  try {
    const res = await fetch(postgrestUrl, { signal: AbortSignal.timeout(3_000) });
    // Only the status matters; release the body so the connection is freed now, not at garbage collection.
    await res.body?.cancel();
    if (!res.ok) {
      postgrest.ok = false;
      postgrest.problem = `PostgREST answered ${res.status}.`;
    }
  } catch {
    postgrest.ok = false;
    postgrest.problem = 'Cannot reach PostgREST at POSTGREST_URL.';
  }

  return { ok: database.ok, database, postgrest };
}
