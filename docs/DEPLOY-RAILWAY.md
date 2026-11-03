# Deploying RallyRank on Railway

Three services in one Railway project:

```
browser ──► web (this repo: SPA + /api/auth + /rest proxy) ──► postgrest (private) ──► Postgres
                 └──────────────────────────────────────────────────────────────────► Postgres
```

Only **web** gets a public domain. PostgREST is reachable only over Railway's private network, through web's `/rest` proxy.

## 1. Generate two secrets

Run this twice and keep both outputs:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

In the project → **Settings → Shared Variables**, add:

| Name | Value |
|---|---|
| `JWT_SECRET` | first output |
| `AUTHENTICATOR_PASSWORD` | second output |

## 2. Postgres

**New → Database → PostgreSQL.** Keep the service name `Postgres` (the references below use it).

## 3. PostgREST

**New → Docker Image →** `postgrest/postgrest:v12.2.12`. Rename the service to `postgrest`. Do **not** generate a public domain.

Variables:

| Name | Value |
|---|---|
| `PGRST_DB_URI` | `postgres://authenticator:${{shared.AUTHENTICATOR_PASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}` |
| `PGRST_DB_SCHEMAS` | `public` |
| `PGRST_DB_ANON_ROLE` | `anon` |
| `PGRST_JWT_SECRET` | `${{shared.JWT_SECRET}}` |
| `PGRST_JWT_AUD` | `authenticated` |
| `PGRST_SERVER_PORT` | `3001` |
| `PGRST_SERVER_HOST` | `*` (listen on IPv6 too; Railway's private network uses it) |

Until step 4's first deploy creates the `authenticator` role, PostgREST can't log in. It treats a failed login as fatal and **exits**; it does not keep retrying. Railway's default restart policy gives up after a few crashes, which usually happens before web's first build finishes. So in the postgrest service's **Settings → Deploy → Restart Policy**, choose **Always**. Then it comes up on its own once the role exists. If you leave the default, **Redeploy** postgrest after step 4's first deploy succeeds.

## 4. Web (this repo)

The existing service that deploys from GitHub. **Delete the old `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` variables** and set:

| Name | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `AUTHENTICATOR_PASSWORD` | `${{shared.AUTHENTICATOR_PASSWORD}}` |
| `JWT_SECRET` | `${{shared.JWT_SECRET}}` |
| `POSTGREST_URL` | `http://${{postgrest.RAILWAY_PRIVATE_DOMAIN}}:3001` |

No `VITE_*` variables are needed. The browser only talks to its own origin.

Pending files in `db/migrations/` are applied twice over, under a lock so the two never collide:

- `railway.toml`'s pre-deploy step runs `npm run migrate`. If a migration fails there, the deploy stops.
- The server applies anything still pending at startup, so migrations land even if Railway skips the pre-deploy step. A failure there is logged (`Startup migrations failed: …`) and makes `/api/health` fail, which stops the deploy when Railway runs the healthcheck. The server keeps running so `/api/health` can name the failing migration.

Then `npm start` runs `node server/index.ts`. If a required variable is missing, the server refuses to start and lists which one.

## 5. Check it

1. Open the web service's public URL. The landing page should render.
2. Sign up, create a club, add players, log a match.
3. Open the public ladder link in a private window (logged out).

## Troubleshooting

Start with **`https://<your-domain>/api/health`**. It reports whether the database (including migrations) and PostgREST are usable, and names the problem when they aren't. Railway uses it as the healthcheck, so a deploy whose database connection is broken fails rather than going live. The web service also logs `Startup check: …` at boot when something is wrong.

- **Sign-in says "temporarily unavailable" (503), or `/api/health` shows `database.ok: false`**: the `problem` field says which of these it is:
  - *migrations have not been applied*: the database has no schema yet. Either no migration run has reached it (check that `DATABASE_URL` is `${{Postgres.DATABASE_URL}}`), or a run reached it and failed: look for `Startup migrations failed:` in the web logs.
  - *Migration … failed at startup*: that file failed against this database. `Startup migrations failed:` in the web logs has the database's error.
  - *rejected the credentials* / *does not exist*: `DATABASE_URL` is stale or hand-typed. Use the reference `${{Postgres.DATABASE_URL}}`.
  - *Cannot reach the database host*: the Postgres service is down, or `DATABASE_URL` points to a host this service can't reach.
- **Sign-in works but creating a club (or anything else) fails, or `/api/health` shows `postgrest.ok: false`**: the health check makes a real signed request through PostgREST, and `problem` names the cause:
  - *PGRST_JWT_SECRET is not set*: the postgrest service is missing its variables (step 3). It still shows Online, because it answers anonymous requests.
  - *cannot use the database: check PGRST_DB_URI*: set it as in step 3.
  - *rejects the app's tokens: PGRST_JWT_SECRET … must equal JWT_SECRET*: set both to `${{shared.JWT_SECRET}}`, then redeploy postgrest.
  - *rejects the app's tokens: set PGRST_JWT_AUD*: set it to `authenticated` on postgrest (or delete it), then redeploy postgrest.
  - *Cannot reach PostgREST*: see the `/rest/...` 502 entry below.
- **The healthcheck or pre-deploy step seems to be ignored**: Railway isn't reading `railway.toml`. In the web service's **Settings**, check that the config-as-code file path is `railway.toml` (or empty, which defaults to it) and that the root directory is the repo root.
- **`Invalid server configuration: …` in web logs**: the variable named in the message is missing or too short (`JWT_SECRET` needs 32+ characters).
- **`/rest/...` returns 502, and web logs say `PostgREST at … unreachable`**: check `POSTGREST_URL` and that the postgrest service is running, with `PGRST_SERVER_HOST=*`. If postgrest shows **Crashed**, it most likely gave up before the `authenticator` role existed: redeploy it (see step 3).
- **PostgREST logs `password authentication failed for user "authenticator"`**: `AUTHENTICATOR_PASSWORD` differs between web and postgrest. Use the shared variable in both, then redeploy web, which re-applies the password.
- **401s on every request after sign-in**: `JWT_SECRET` differs between web and postgrest.
