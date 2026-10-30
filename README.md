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
- Email/password accounts
- OTP-style invite reveal (copy once, 60s UI timer, 24h code expiry)

## Stack

- Vite · React · TypeScript · Tailwind · shadcn/ui
- Node server (Hono): auth API + static hosting
- Postgres with RLS + SQL RPCs, served by PostgREST

## Setup

Needs Node 24 and Docker.

1. `npm install`
2. `cp .env.example .env` (the defaults match `docker-compose.yml`)
3. `docker compose up -d`: Postgres on `:54322`, PostgREST on `:3001`
4. `npm run migrate:dev`: applies `db/migrations/` (safe to re-run)
5. In two terminals: `npm run dev:server` (API on `:8787`) and `npm run dev` (app on `:3000`)

No database at hand? Set `VITE_BACKEND=local` in `.env` and just run `npm run dev`. All data then stays in your browser.

## Deploy on Railway

See [`docs/DEPLOY-RAILWAY.md`](docs/DEPLOY-RAILWAY.md): Postgres + PostgREST + this repo as the web service.

## Scripts

- `npm run dev`: Vite dev server (proxies `/api` and `/rest` to `dev:server`)
- `npm run dev:server`: API server with reload, reading `.env`
- `npm run build`: production build of the app
- `npm start`: production server (`dist/` + API), as on Railway
- `npm run migrate` / `migrate:dev`: apply database migrations
- `npm test`: unit tests; `npm run test:server`: API + database integration tests (needs the compose stack)
- `npm run lint` / `npm run typecheck`

## License

MIT
