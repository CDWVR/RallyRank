// `npm run migrate`: applies pending db/migrations (the server also does this at startup).
// Env: DATABASE_URL (owner role), AUTHENTICATOR_PASSWORD (login password for PostgREST's role).
import { runMigrations } from '../server/migrate.ts';

const { DATABASE_URL, AUTHENTICATOR_PASSWORD } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!AUTHENTICATOR_PASSWORD) throw new Error('AUTHENTICATOR_PASSWORD is required');

await runMigrations({ databaseUrl: DATABASE_URL, authenticatorPassword: AUTHENTICATOR_PASSWORD });
