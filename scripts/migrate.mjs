// Applies db/migrations/*.sql in filename order, each in its own transaction, once.
// Env: DATABASE_URL (owner role), AUTHENTICATOR_PASSWORD (login password for PostgREST's role).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

const { DATABASE_URL, AUTHENTICATOR_PASSWORD } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!AUTHENTICATOR_PASSWORD) throw new Error('AUTHENTICATOR_PASSWORD is required');

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

try {
  await client.query(`
    create schema if not exists ops;
    create table if not exists ops.schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    );
  `);

  const { rows } = await client.query('select name from ops.schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const pending = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql') && !applied.has(f))
    .sort();

  for (const name of pending) {
    const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into ops.schema_migrations (name) values ($1)', [name]);
      await client.query('commit');
      console.log(`applied ${name}`);
    } catch (err) {
      await client.query('rollback');
      throw new Error(`Migration ${name} failed: ${err.message}`);
    }
  }
  if (pending.length === 0) console.log('database is up to date');

  // Identifiers can't be bound as parameters; format() quotes the password literal safely.
  const { rows: [{ stmt }] } = await client.query(
    "select format('alter role authenticator with password %L', $1::text) as stmt",
    [AUTHENTICATOR_PASSWORD]
  );
  await client.query(stmt);
  // PostgREST caches the schema; tell it to reload after DDL changes.
  await client.query("notify pgrst, 'reload schema'");
} finally {
  await client.end();
}
