# Local dev backend (no Supabase keys)

**Date:** 2026-10-27  
**Status:** Draft for review  
**Goal:** Running the app locally must expose product features without configuring Supabase keys every time.

## Intent

- **Hybrid:** If `VITE_SUPABASE_URL` and a publishable/anon key are set → real Supabase. If either is missing → local backend. No mandatory extra env flag.
- **Feature access, not a polished offline product:** Sign in locally, use clubs/roster/session/matches/ladder/settings with seed data. Survive refresh. Production paths stay unchanged when keys are present.
- **Out of scope:** Realtime, Storage, Edge Functions, Google OAuth against real Google, perfect SQL parity for unused RPCs, multi-device sync.

## Approach

Fake Supabase-shaped client (`auth` / `from` / `rpc`) backed by IndexedDB. App pages keep calling `supabase` as today; only the client module switches implementation.

## Mode switch

File: `src/integrations/supabase/client.ts`

1. Read `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` (fallback `VITE_SUPABASE_ANON_KEY`).
2. Keys present → `createClient` (current behavior).
3. Keys missing → export local client; **do not throw** at import time.

Optional: `import.meta.env.DEV` banner or shell chip “Local mode” so missing-key runs are obvious. Not required for MVP if it slows delivery.

## Local auth

- Email + password sign-up / sign-in stored in IndexedDB (`auth_users` + profile row).
- New users are treated as email-confirmed so `ProtectedRoute` does not send them to verify-email.
- `getSession` / `onAuthStateChange` / `signOut` mirror current AuthContext expectations; session persisted in `localStorage`.
- Google OAuth: return a clear error (“not available in local mode”) or map to the same local passwordless/demo sign-in — prefer clear error to avoid fake Google UX.
- Auth callback / verify-email pages remain reachable but are unnecessary in the happy local path.

## Local data

**Persistence:** IndexedDB database `rallyrank-local`.

**Collections:** `auth_users`, `profiles`, `clubs`, `memberships`, `seasons`, `players`, `matches`, `match_history`, `pair_ratings`, `invites`, `session_templates`, `club_sessions`.

**Query shim:** Support the chain patterns the SPA uses: `.from().select/insert/update/upsert/delete` with `.eq`, `.in`, `.is`, `.order`, `.limit`, `.single`, `.maybeSingle`, and the FK embeds pages already request.

**RPC shim (SPA-used only):**

- Club/onboarding: `create_club`, `join_club_with_code`
- Players: `create_player`, `update_player_profile`, `archive_player`, `promote_guest`, `link_player_to_user`, `unlink_player`
- Matches: `log_match`, `undo_match`, `set_match_disputed`
- Session: `get_or_open_session`, `save_session_state`, `close_session`
- Settings: `create_invite`, `revoke_invite`, `rename_club`, `rotate_share_token`, `leave_club`, `remove_member`, `update_member_role`, `transfer_ownership`, `start_season`
- Public: `get_public_ladder`

Port Elo / session / club rules from SQL migrations closely enough that ladder and session feel usable. Unsupported RPCs return a structured error.

**Seed (first local boot or empty DB):** one demo club, active season, membership for the signed-in user (or seed user after first sign-up), and ~6–8 players so Home / Roster / Ladder / Session / Matches work without manual setup.

**Reset (optional, small):** clear IndexedDB + local session and reseed — useful if local state corrupts; can live behind a console helper or a single Settings control if cheap.

## Error shape

Local operations return Supabase-like `{ data, error }` so existing page error handling keeps working.

## Files

```
src/integrations/supabase/client.ts          # switch
src/integrations/supabase/local/client.ts     # facade
src/integrations/supabase/local/db.ts         # IndexedDB
src/integrations/supabase/local/auth.ts
src/integrations/supabase/local/query.ts
src/integrations/supabase/local/seed.ts
src/integrations/supabase/local/rpcs/         # one module per domain or single rpcs.ts if small
```

## Docs / env

Update `.env.example`: keys enable cloud Supabase; omit them for local IndexedDB playground.

## Testing

- Client does not throw when keys are absent.
- Local `log_match` (or Elo helper) unit test covering a singles rating update.
- Manual: `npm run dev` with empty/missing keys → sign up → open `/app` features.

## Success criteria

1. No Supabase keys required for `npm run dev` to show and use app features.
2. With keys present, behavior matches today’s cloud client.
3. Refresh keeps local session and club data.
4. Existing typecheck / lint / unit tests still pass.
