-- REM-001: Lock Elo-affecting writes behind SECURITY DEFINER RPCs.
-- Drop direct INSERT/UPDATE policies that let members set arbitrary ratings.
--
-- ROLLBACK:
--   drop function if exists public.create_player(uuid, text, integer, boolean);
--   drop function if exists public.update_player_profile(uuid, text, integer);
--   recreate policies from 20260321000000_clubs_tenancy_ratings.sql:
--     players_insert, players_update, matches_insert, match_history_insert
--   (client create/edit flows must also revert from RPC to direct table writes)

drop policy if exists matches_insert on public.matches;
drop policy if exists match_history_insert on public.match_history;
drop policy if exists players_insert on public.players;
drop policy if exists players_update on public.players;

-- ---------------------------------------------------------------------------
-- create_player: membership-gated; server-owned Elo; never accepts client Elo/user_id
-- ---------------------------------------------------------------------------

create or replace function public.create_player(
  p_club_id uuid,
  p_name text,
  p_age integer default null,
  p_is_guest boolean default false
)
returns public.players
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.players;
  v_rating numeric := 1000;
  v_doubles numeric := 1000;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_club_member(p_club_id) then
    raise exception 'Not a club member';
  end if;

  v_name := trim(p_name);
  if length(v_name) < 1 then
    raise exception 'Player name required';
  end if;

  if coalesce(p_is_guest, false) then
    v_rating := 1000;
    v_doubles := 1000;
  else
    v_rating := public.club_average_rating(p_club_id);
    v_doubles := public.club_average_doubles_rating(p_club_id);
  end if;

  insert into public.players (
    club_id, name, age, is_guest,
    rating, doubles_rating,
    matches_played, wins
  ) values (
    p_club_id, v_name, p_age, coalesce(p_is_guest, false),
    coalesce(v_rating, 1000), coalesce(v_doubles, 1000),
    0, 0
  )
  returning * into v_player;

  return v_player;
end;
$$;

grant execute on function public.create_player(uuid, text, integer, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- update_player_profile: name/age only for players in caller's club
-- ---------------------------------------------------------------------------

create or replace function public.update_player_profile(
  p_player_id uuid,
  p_name text,
  p_age integer default null
)
returns public.players
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.players;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_player from public.players where id = p_player_id;
  if v_player is null then
    raise exception 'Player not found';
  end if;

  if v_player.club_id is null or not public.is_club_member(v_player.club_id) then
    raise exception 'Not a club member';
  end if;

  v_name := trim(p_name);
  if length(v_name) < 1 then
    raise exception 'Player name required';
  end if;

  update public.players
  set name = v_name,
      age = p_age,
      updated_at = now()
  where id = p_player_id
  returning * into v_player;

  return v_player;
end;
$$;

grant execute on function public.update_player_profile(uuid, text, integer) to authenticated;
