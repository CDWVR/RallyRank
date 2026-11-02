// Applies db/migrations/*.sql in filename order, each in its own transaction, once.
// Used by `npm run migrate` and by the server at startup, so a deploy never runs against an unmigrated
// database even when the platform's pre-deploy step is missing or skipped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
// Arbitrary constant: concurrent runners (pre-deploy step, server boot, a second replica) take turns.
const LOCK_KEY = 727_311_001;

export interface MigrateOptions {
  databaseUrl: string;
  /** Login password for PostgREST's `authenticator` role; left unchanged when omitted. */
  authenticatorPassword?: string;
  log?: (message: string) => void;
}

/** Returns the names of the migrations it applied. Throws, naming the file, if one fails. */
export async function runMigrations({ databaseUrl, authenticatorPassword, log = console.log }: MigrateOptions): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      create schema if not exists ops;
      create table if not exists ops.schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      );
    `);

    const { rows } = await client.query<{ name: string }>('select name from ops.schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    const pending = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql') && !done.has(f))
      .sort();

    for (const name of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into ops.schema_migrations (name) values ($1)', [name]);
        await client.query('commit');
        applied.push(name);
        log(`applied ${name}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${name} failed: ${(err as Error).message}`);
      }
    }
    if (pending.length === 0) log('database is up to date');

    if (authenticatorPassword) {
      // Identifiers can't be bound as parameters; format() quotes the password literal safely.
      const {
        rows: [{ stmt }],
      } = await client.query<{ stmt: string }>("select format('alter role authenticator with password %L', $1::text) as stmt", [
        authenticatorPassword,
      ]);
      await client.query(stmt);
    }
    // PostgREST caches the schema; tell it to reload after DDL changes.
    await client.query("notify pgrst, 'reload schema'");
    return applied;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
}
