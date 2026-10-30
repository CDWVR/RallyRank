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

It will log connection errors until step 4's first deploy creates the `authenticator` role. That's expected, because it keeps retrying.

## 4. Web (this repo)

The existing service that deploys from GitHub. **Delete the old `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` variables** and set:

| Name | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `AUTHENTICATOR_PASSWORD` | `${{shared.AUTHENTICATOR_PASSWORD}}` |
| `JWT_SECRET` | `${{shared.JWT_SECRET}}` |
| `POSTGREST_URL` | `http://${{postgrest.RAILWAY_PRIVATE_DOMAIN}}:3001` |

No `VITE_*` variables are needed. The browser only talks to its own origin.

On every deploy, `railway.toml` runs `npm run migrate` before the new version starts. It applies any new files in `db/migrations/`, and a failing migration stops the deploy. Then `npm start` runs `node server/index.ts`. If a required variable is missing, the server refuses to start and lists which one.

## 5. Check it

1. Open the web service's public URL. The landing page should render.
2. Sign up, create a club, add players, log a match.
3. Open the public ladder link in a private window (logged out).

## Troubleshooting

- **`Invalid server configuration: …` in web logs**: the variable named in the message is missing or too short (`JWT_SECRET` needs 32+ characters).
- **`/rest/...` returns 502/500, or "fetch failed" in web logs**: check `POSTGREST_URL` and that the postgrest service is running, with `PGRST_SERVER_HOST=*`.
- **PostgREST logs `password authentication failed for user "authenticator"`**: `AUTHENTICATOR_PASSWORD` differs between web and postgrest. Use the shared variable in both, then redeploy web, which re-applies the password.
- **401s on every request after sign-in**: `JWT_SECRET` differs between web and postgrest.
