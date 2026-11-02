import type { Pool, QueryConfig } from 'pg';
import { signAccessToken } from './tokens.ts';

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
export async function checkHealth(
  pool: Pool,
  postgrestUrl: string,
  jwtSecret: string,
  migrationProblem?: string | null,
): Promise<HealthReport> {
  const database: HealthReport['database'] = { ok: true };
  if (migrationProblem) {
    // A later migration can fail while auth.users already exists; the query below wouldn't notice.
    database.ok = false;
    database.problem = migrationProblem;
  } else try {
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

  const postgrest = await checkPostgrest(pool, postgrestUrl, jwtSecret);
  return { ok: database.ok, database, postgrest };
}

// Not a real user: RLS gives it no rows, which is all the probe needs.
const PROBE_USER = '00000000-0000-0000-0000-000000000000';

/**
 * Makes the same kind of request the app does: a token signed like a real session, sent to PostgREST
 * for a table behind RLS. "PostgREST is up" isn't enough; a JWT secret or audience that differs between
 * this service and PostgREST makes every app request fail while PostgREST itself looks healthy.
 */
async function checkPostgrest(pool: Pool, postgrestUrl: string, jwtSecret: string): Promise<HealthReport['postgrest']> {
  let res: Response;
  try {
    const { token } = await signAccessToken({ sub: PROBE_USER, email: 'health-check@rallyrank.invalid' }, jwtSecret);
    res = await fetch(`${postgrestUrl.replace(/\/$/, '')}/clubs?select=id&limit=1`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    return { ok: false, problem: 'Cannot reach PostgREST at POSTGREST_URL.' };
  }
  if (res.ok) {
    await res.body?.cancel();
    return { ok: true };
  }

  const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
  const message = body.message ?? '';
  if (body.code === 'PGRST301' || res.status === 401) {
    if (/audience/i.test(message)) {
      return { ok: false, problem: 'PostgREST rejects the app\'s tokens: set PGRST_JWT_AUD to "authenticated" (or remove it) on the postgrest service.' };
    }
    return { ok: false, problem: 'PostgREST rejects the app\'s tokens: PGRST_JWT_SECRET on the postgrest service must equal JWT_SECRET on this service.' };
  }
  if (body.code === 'PGRST205' || body.code === 'PGRST202' || body.code === '42P01') {
    // PostgREST cached the schema before migrations ran (e.g. it started first). Ask it to reload;
    // the next check passes if that was all.
    await pool.query("notify pgrst, 'reload schema'").catch(() => {});
    return { ok: false, problem: 'PostgREST\'s schema cache was out of date; a reload was requested. Check again in a few seconds.' };
  }
  if (body.code === '42501') {
    return { ok: false, problem: 'PostgREST\'s roles lack privileges on the app tables: migrations may not have completed.' };
  }
  return { ok: false, problem: `PostgREST answered ${res.status}${body.code ? ` (${body.code})` : ''}.` };
}
