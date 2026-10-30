-- Smoke checks after wave 1–5 + REM-001..005 migrations
-- Run while signed in as a club owner (or call RPCs from the app).
--
-- ROLLBACK notes for REM migrations: see comments at top of each
--   2026032219* rem00*.sql file.

-- 1) create_club
-- select public.create_club('Smoke Test Club');

-- 2) create_invite / revoke
-- select public.create_invite('<club_id>', 'coach');
-- select public.revoke_invite('<invite_id>');

-- 3) log_match singles (updates rating, not doubles_rating)
-- select public.log_match(
--   '<club_id>', '<p1>', null, '<p2>', null, 21, 15, now(), null, 'smoke singles', false
-- );

-- 4) log_match doubles (updates doubles_rating + pair_ratings)
-- select public.log_match(
--   '<club_id>', '<p1>', '<p2>', '<p3>', '<p4>', 21, 15, now(), null, 'smoke doubles', false
-- );
-- select * from public.pair_ratings where club_id = '<club_id>';

-- 5) Distinct-player rejection (should error)
-- select public.log_match(
--   '<club_id>', '<p1>', null, '<p1>', null, 21, 15, now()
-- );

-- 6) Mixed singles/doubles sides (should error)
-- select public.log_match(
--   '<club_id>', '<p1>', '<p2>', '<p3>', null, 21, 15, now()
-- );

-- 7) Disputed match (no Elo change)
-- select public.log_match(
--   '<club_id>', '<p1>', null, '<p2>', null, 21, 18, now(), null, 'disputed smoke', true
-- );

-- 8) undo_match (most recent only; restores format-correct columns + pairs)
-- select public.undo_match('<match_id>');

-- 9) Provisional K: format-specific matches_played < 8 → k_factor 40 in JSON result

-- 10) Soft vs hard season (hard resets singles + doubles + pair ratings)
-- select public.start_season('<club_id>', 'Soft Season', false);
-- select public.start_season('<club_id>', 'Hard Season', true);

-- 11) club_average_rating / club_average_doubles_rating
-- select public.club_average_rating('<club_id>');
-- select public.club_average_doubles_rating('<club_id>');

-- 12) Session open / save / close
-- select public.get_or_open_session('<club_id>');
-- select public.close_session('<session_id>');

-- 13) Public ladder excludes guests/archived; includes doubles_rating
-- select public.get_public_ladder('<share_token>');

-- 14) Membership lock: client insert into memberships should fail; join via invite only

-- ---------------------------------------------------------------------------
-- REM-001: Elo write lock + create/update player RPCs
-- ---------------------------------------------------------------------------

-- 15) create_player (guest → 1000/1000; member → club averages; no client Elo)
-- select public.create_player('<club_id>', 'Smoke Guest', null, true);
-- select public.create_player('<club_id>', 'Smoke Member', 28, false);

-- 16) update_player_profile (name/age only)
-- select public.update_player_profile('<player_id>', 'Renamed', 30);

-- 17) NEGATIVE RLS: direct players insert must fail after rem001
-- insert into public.players (club_id, name, rating, doubles_rating, is_guest)
-- values ('<club_id>', 'Hack Elo', 2000, 2000, false);
-- Expected: new row violates row-level security policy

-- 18) NEGATIVE RLS: direct players update (rating) must fail
-- update public.players set rating = 2500 where id = '<player_id>';
-- Expected: RLS / 0 rows updated for authenticated member

-- 19) NEGATIVE RLS: direct matches insert must fail
-- insert into public.matches (
--   club_id, user_id, team1_player1_id, team2_player1_id,
--   team1_score, team2_score, winner
-- ) values (
--   '<club_id>', auth.uid(), '<p1>', '<p2>', 21, 10, 'team1'
-- );
-- Expected: RLS policy violation (use log_match RPC)

-- 20) NEGATIVE RLS: direct match_history insert must fail
-- insert into public.match_history (
--   match_id, player_id, club_id, rating_before, rating_after,
--   rating_change, score_difference, is_winner
-- ) values (
--   '<match_id>', '<p1>', '<club_id>', 1000, 1100, 100, 11, true
-- );
-- Expected: RLS policy violation

-- ---------------------------------------------------------------------------
-- REM-002: ensure_pair_rating not callable by authenticated clients
-- ---------------------------------------------------------------------------

-- 21) NEGATIVE: client execute ensure_pair_rating should fail (privilege)
-- select public.ensure_pair_rating('<club_id>', '<p1>', '<p2>');
-- Expected: permission denied for function ensure_pair_rating
-- (log_match SECURITY DEFINER still creates pairs successfully — see #4)

-- ---------------------------------------------------------------------------
-- REM-003: advisory lock + disputed-at-log undo
-- ---------------------------------------------------------------------------

-- 22) Disputed-at-log undo: delete only, no counter decrements
-- select public.log_match(
--   '<club_id>', '<p1>', null, '<p2>', null, 21, 18, now(), null, 'disputed undo', true
-- );
-- -- note matches_played before:
-- select matches_played from public.players where id = '<p1>';
-- select public.undo_match('<disputed_match_id>');
-- -- matches_played unchanged; result includes disputed_no_elo: true

-- 23) Post-hoc disputed (set_match_disputed after rated log) still undoes Elo
-- select public.log_match(
--   '<club_id>', '<p1>', null, '<p2>', null, 21, 15, now(), null, null, false
-- );
-- select public.set_match_disputed('<match_id>', true);
-- select public.undo_match('<match_id>');
-- -- ratings restored; counters decremented (NOT disputed_no_elo path)

-- 24) created_at on new matches ≈ now() even if p_played_at is in the past
-- select public.log_match(
--   '<club_id>', '<p1>', null, '<p2>', null, 21, 12,
--   now() - interval '2 days', null, 'backdated play', false
-- );
-- select id, created_at from public.matches where club_id = '<club_id>'
-- order by created_at desc limit 1;
-- -- created_at near now(); match_history.date ≈ p_played_at

-- ---------------------------------------------------------------------------
-- REM-004: one open session per club
-- ---------------------------------------------------------------------------

-- 25) Unique open session: concurrent get_or_open_session returns same id
-- select public.get_or_open_session('<club_id>');
-- -- Attempting a second open row should fail unique index:
-- insert into public.club_sessions (club_id, opened_by, status)
-- values ('<club_id>', auth.uid(), 'open');
-- Expected: unique violation on club_sessions_one_open_per_club

-- ---------------------------------------------------------------------------
-- REM-005: invites_select owner/admin only
-- ---------------------------------------------------------------------------

-- 26) As owner/admin: select * from public.invites where club_id = '<club_id>'; -- OK
-- 27) NEGATIVE: as coach member, same select returns 0 rows (RLS)

-- ---------------------------------------------------------------------------
-- L-01: only one log_match / start_season signature
-- ---------------------------------------------------------------------------

-- 28) In SQL editor:
-- select p.proname, pg_get_function_identity_arguments(p.oid)
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and p.proname in ('log_match', 'start_season')
-- order by 1, 2;
-- Expected: one log_match (11 args incl. session/note/dispute) and one start_season (3 args)

-- ---------------------------------------------------------------------------
-- DB-005: undo restores streak_before
-- ---------------------------------------------------------------------------

-- 29) Log a match that extends a win streak, note streak_count, undo, confirm streak restored
-- (not zeroed). Requires a player with streak_count > 0 before the match.
