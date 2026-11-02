// Production entry: `node server/index.ts` (Node 24 strips the types; no build step).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { checkHealth, diagnoseDbError } from './health.ts';
import { MigrationError, runMigrations } from './migrate.ts';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10, connectionTimeoutMillis: 5_000 });
pool.on('error', (err) => console.error('Postgres pool error:', err));

let migrationProblem: string | null = null;

const app = createApp({
  pool,
  migrationProblem: () => migrationProblem,
  jwtSecret: config.JWT_SECRET,
  postgrestUrl: config.POSTGREST_URL,
  distDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'),
});

// Apply pending migrations before taking traffic. This used to rely only on the platform's pre-deploy step,
// and a deploy where that step didn't run served an empty database ("Internal server error" on sign-in).
// A failure is logged, not fatal: the server stays up so /api/health can say what is wrong.
try {
  if (!config.AUTHENTICATOR_PASSWORD) {
    console.warn('AUTHENTICATOR_PASSWORD is not set: PostgREST will not be able to log in until it is.');
  }
  await runMigrations({
    databaseUrl: config.DATABASE_URL,
    authenticatorPassword: config.AUTHENTICATOR_PASSWORD,
    log: (m) => console.log(`migrate: ${m}`),
  });
} catch (err) {
  console.error('Startup migrations failed:', err);
  migrationProblem =
    err instanceof MigrationError
      ? `Migration ${err.migration} failed at startup; see "Startup migrations failed" in the server logs.`
      : (diagnoseDbError(err) ?? 'Startup migrations failed; see the server logs.');
}

// Say at boot what is still wrong, instead of leaving it to the first sign-in to fail.
void checkHealth(pool, config.POSTGREST_URL, config.JWT_SECRET, migrationProblem).then(({ database, postgrest }) => {
  if (!database.ok) console.error(`Startup check: ${database.problem}`);
  if (!postgrest.ok) console.error(`Startup check: ${postgrest.problem}`);
});

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`RallyRank listening on :${info.port}`);
});

function shutdown() {
  server.close(() => pool.end().finally(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
