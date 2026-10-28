# RallyRank

Fair badminton club ladders — invite your club, balance sessions, log matches, trust Elo.

**Full product reference:** [`docs/REFERENCE.md`](docs/REFERENCE.md)  
**Branch:** [`product-revamp`](https://github.com/CDWVR/RallyRank/tree/product-revamp)

## Features

- Multi-member clubs with roles (owner / admin / coach) and invite codes
- Roster management with edit & delete
- Fair session balancer (snake draft by rating)
- Server-side Elo match logging (`log_match` RPC)
- Ladder with rivalries & doubles synergy
- Seasons with rating reset
- Public shareable ladder links
- Progressive Web App (installable shell)
- Google OAuth + email/password with verification waiting page
- OTP-style invite reveal (copy once, 60s UI timer, 24h code expiry)

## Stack

- Vite · React · TypeScript · Tailwind · shadcn/ui
- Supabase (Auth, Postgres, RLS, RPCs)

## Setup

1. Clone and install: `npm install`
2. Copy `.env.example` to `.env` and set:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_...` from **Settings → API Keys**)
   
   Do not use the legacy `anon` JWT — it is being deprecated. Never put a secret (`sb_secret_...`) key in the frontend.
3. Apply migrations in `supabase/migrations/` to your Supabase project (SQL editor or CLI), including:
   - `20260321000000_clubs_tenancy_ratings.sql`
   - `20260321120000_profile_signup_fields.sql`
   - `20260321140000_invite_one_day_expiry.sql`
   - `20260322100000_trust_sessions_identity.sql`
   - `20260322120000_session_courts_ownership.sql`
   - `20260322140000_guests_invites_archive.sql`
   - `20260322160000_wave4_notes_k_profiles.sql`
4. Configure Auth (required for signup flows):

### Confirm email

1. Supabase → **Authentication → Providers → Email**
2. Enable **Confirm email**
3. **Authentication → URL Configuration**
   - Site URL: `http://localhost:3000` (or your production origin)
   - Redirect URLs allow list must include:
     - `http://localhost:3000/auth/callback`
     - `http://localhost:3000/auth/verify-email`
     - Production equivalents when you deploy (include GitHub Pages base path if used)

After email signup, RallyRank sends users to `/auth/verify-email`, which listens for a confirmation ping (BroadcastChannel / auth session) when the email link opens — no per-second polling.

### Google OAuth

1. Create a Google Cloud OAuth **Web** client
2. Authorized redirect URI (exact):  
   `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`
3. Supabase → **Authentication → Providers → Google** → paste Client ID + Client Secret → enable
4. Add the same app callback URLs to Supabase Redirect URLs as above (`…/auth/callback`)

Google sign-in skips the email waiting page (identity is already verified).

5. Optional: deploy edge function `supabase/functions/log-match` (thin wrapper around the RPC).
6. Run: `npm run dev`

## Deploy on Railway

1. Push this repo to GitHub (Railway deploys from Git).
2. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub** → select this repo.
3. Root directory: repo root (where `package.json` / `railway.toml` live).
4. **Variables** (required at build time):
   - `VITE_SUPABASE_URL` = your Supabase project URL  
   - `VITE_SUPABASE_PUBLISHABLE_KEY` = `sb_publishable_...`  
   - `VITE_BASE_URL` = `/`
5. Generate a public domain (Railway service → **Settings** → **Networking** → **Generate domain**).
6. Supabase → **Authentication → URL Configuration**:
   - **Site URL**: `https://YOUR-RAILWAY-DOMAIN`
   - **Redirect URLs** add:
     - `https://YOUR-RAILWAY-DOMAIN/auth/callback`
     - `https://YOUR-RAILWAY-DOMAIN/auth/verify-email`

`railway.toml` runs `npm ci && npm run build`, then `npm start` (static `serve` on `$PORT`).

## Scripts

- `npm run dev` — local server
- `npm run build` — production build (`VITE_BASE_URL` defaults to `/`)
- `npm start` — serve `dist` (Railway / local preview after build)
- `npm run lint` — ESLint
- `npm run typecheck` — TypeScript

## License

MIT
