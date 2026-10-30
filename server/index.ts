// Production entry: `node server/index.ts` (Node 24 strips the types; no build step).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10, connectionTimeoutMillis: 5_000 });
pool.on('error', (err) => console.error('Postgres pool error:', err));

const app = createApp({
  pool,
  jwtSecret: config.JWT_SECRET,
  postgrestUrl: config.POSTGREST_URL,
  distDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'),
});

const server = serve({ fetch: app.fetch, port: config.PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`RallyRank listening on :${info.port}`);
});

function shutdown() {
  server.close(() => pool.end().finally(() => process.exit(0)));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
