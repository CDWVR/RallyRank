-- Wave 2: session_id on matches, courts JSON, transfer ownership

-- ---------------------------------------------------------------------------
-- Matches ↔ session
-- ---------------------------------------------------------------------------

alter table public.matches
  add column if not exists session_id uuid references public.club_sessions(id) on delete set null;

create index if not exists idx_matches_session on public.matches(session_id);

alter table public.club_sessions
  add column if not exists courts jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- log_match: optional session_id
-- ---------------------------------------------------------------------------

create or replace function public.log_match(
  p_club_id uuid,
  p_team1_player1_id uuid,
  p_team1_player2_id uuid,
  p_team2_player1_id uuid,
  p_team2_player2_id uuid,
  p_team1_score int,
  p_team2_score int,
  p_played_at timestamptz default now(),
  p_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_winner text;
  v_match_id uuid;
  v_k numeric := 32;
  v_t1_rating numeric;
  v_t2_rating numeric;
  v_t1_expected numeric;
  v_t2_expected numeric;
  v_t1_change numeric;
  v_t2_change numeric;
  v_season_id uuid;
  r record;
  v_new_rating numeric;
  v_is_winner boolean;
  v_delta numeric;
  v_events jsonb := '[]'::jsonb;
  v_ids uuid[];
  v_distinct int;
  v_session public.club_sessions;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_club_member(p_club_id) then
    raise exception 'Not a club member';
  end if;

  if p_team1_score = p_team2_score then
    raise exception 'Ties are not allowed';
  end if;

  if p_team1_player1_id is null or p_team2_player1_id is null then
    raise exception 'Each team needs at least one player';
  end if;

  v_ids := array_remove(array[
    p_team1_player1_id,
    p_team1_player2_id,
    p_team2_player1_id,
    p_team2_player2_id
  ], null);

  select count(distinct x) into v_distinct from unnest(v_ids) as x;
  if v_distinct <> cardinality(v_ids) then
    raise exception 'All players in a match must be distinct';
  end if;

  if p_session_id is not null then
    select * into v_session from public.club_sessions where id = p_session_id;
    if v_session is null or v_session.club_id <> p_club_id then
      raise exception 'Invalid session for club';
    end if;
    if v_session.status <> 'open' then
      raise exception 'Session is closed';
    end if;
  end if;

  v_winner := case when p_team1_score > p_team2_score then 'team1' else 'team2' end;

  select id into v_season_id from public.seasons
  where club_id = p_club_id and is_active = true
  order by starts_at desc limit 1;

  select avg(rating)::numeric into v_t1_rating
  from public.players
  where id = any (array_remove(array[p_team1_player1_id, p_team1_player2_id], null))
    and club_id = p_club_id;

  select avg(rating)::numeric into v_t2_rating
  from public.players
  where id = any (array_remove(array[p_team2_player1_id, p_team2_player2_id], null))
    and club_id = p_club_id;

  if v_t1_rating is null or v_t2_rating is null then
    raise exception 'Players not found in club';
  end if;

  v_t1_expected := 1 / (1 + power(10, (v_t2_rating - v_t1_rating) / 400.0));
  v_t2_expected := 1 / (1 + power(10, (v_t1_rating - v_t2_rating) / 400.0));
  v_t1_change := round(v_k * ((case when v_winner = 'team1' then 1 else 0 end) - v_t1_expected));
  v_t2_change := round(v_k * ((case when v_winner = 'team2' then 1 else 0 end) - v_t2_expected));

  insert into public.matches (
    club_id, season_id, session_id, user_id,
    team1_player1_id, team1_player2_id,
    team2_player1_id, team2_player2_id,
    team1_score, team2_score, winner, created_at
  ) values (
    p_club_id, v_season_id, p_session_id, auth.uid(),
    p_team1_player1_id, p_team1_player2_id,
    p_team2_player1_id, p_team2_player2_id,
    p_team1_score, p_team2_score, v_winner, coalesce(p_played_at, now())
  ) returning id into v_match_id;

  for r in
    select id, rating, matches_played, wins, streak_count,
      case
        when id in (p_team1_player1_id, p_team1_player2_id) then 'team1'
        else 'team2'
      end as team
    from public.players
    where id = any (v_ids)
      and club_id = p_club_id
  loop
    v_delta := case when r.team = 'team1' then v_t1_change else v_t2_change end;
    v_is_winner := (r.team = v_winner);
    v_new_rating := greatest(800, round(r.rating + v_delta));

    update public.players set
      rating = v_new_rating,
      matches_played = coalesce(matches_played, 0) + 1,
      wins = coalesce(wins, 0) + case when v_is_winner then 1 else 0 end,
      win_rate = case
        when coalesce(matches_played, 0) + 1 > 0 then
          ((coalesce(wins, 0) + case when v_is_winner then 1 else 0 end)::numeric
            / (coalesce(matches_played, 0) + 1)) * 100
        else 0
      end,
      streak_count = case when v_is_winner then coalesce(streak_count, 0) + 1 else 0 end,
      last_played_at = coalesce(p_played_at, now()),
      season_id = v_season_id,
      updated_at = now()
    where id = r.id;

    insert into public.match_history (
      match_id, player_id, club_id, date,
      rating_before, rating_after, rating_change,
      score_difference, is_winner
    ) values (
      v_match_id, r.id, p_club_id, coalesce(p_played_at, now()),
      r.rating, v_new_rating, v_delta,
      abs(p_team1_score - p_team2_score), v_is_winner
    );

    v_events := v_events || jsonb_build_object(
      'player_id', r.id,
      'rating_before', r.rating,
      'rating_after', v_new_rating,
      'rating_change', v_delta,
      'is_winner', v_is_winner
    );
  end loop;

  return jsonb_build_object(
    'match_id', v_match_id,
    'winner', v_winner,
    'events', v_events
  );
end;
$$;

grant execute on function public.log_match(uuid, uuid, uuid, uuid, uuid, int, int, timestamptz, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- save_session_state: courts jsonb
-- ---------------------------------------------------------------------------

create or replace function public.save_session_state(
  p_session_id uuid,
  p_attendee_ids uuid[],
  p_team_a_ids uuid[],
  p_team_b_ids uuid[],
  p_court_count int default null,
  p_courts jsonb default null
)
returns public.club_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.club_sessions;
begin
  select * into v_session from public.club_sessions where id = p_session_id;
  if v_session is null then
    raise exception 'Session not found';
  end if;

  if not public.is_club_member(v_session.club_id) then
    raise exception 'Not a club member';
  end if;

  if v_session.status <> 'open' then
    raise exception 'Session is closed';
  end if;

  update public.club_sessions set
    attendee_ids = coalesce(p_attendee_ids, attendee_ids),
    team_a_ids = coalesce(p_team_a_ids, team_a_ids),
    team_b_ids = coalesce(p_team_b_ids, team_b_ids),
    court_count = coalesce(p_court_count, court_count),
    courts = coalesce(p_courts, courts),
    updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return v_session;
end;
$$;

grant execute on function public.save_session_state(uuid, uuid[], uuid[], uuid[], int, jsonb) to authenticated;

-- Drop prior 5-arg overload if present (replaced by 6-arg with p_courts)
drop function if exists public.save_session_state(uuid, uuid[], uuid[], uuid[], int);

-- ---------------------------------------------------------------------------
-- Transfer ownership
-- ---------------------------------------------------------------------------

create or replace function public.transfer_ownership(p_club_id uuid, p_new_owner_id uuid)
returns public.memberships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me text;
  v_target text;
  v_row public.memberships;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select role into v_me
  from public.memberships
  where club_id = p_club_id and user_id = auth.uid();

  if v_me is distinct from 'owner' then
    raise exception 'Only the owner can transfer ownership';
  end if;

  if p_new_owner_id = auth.uid() then
    raise exception 'Already the owner';
  end if;

  select role into v_target
  from public.memberships
  where club_id = p_club_id and user_id = p_new_owner_id;

  if v_target is null then
    raise exception 'New owner must already be a club member';
  end if;

  update public.memberships
  set role = 'admin'
  where club_id = p_club_id and user_id = auth.uid();

  update public.memberships
  set role = 'owner'
  where club_id = p_club_id and user_id = p_new_owner_id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.transfer_ownership(uuid, uuid) to authenticated;
