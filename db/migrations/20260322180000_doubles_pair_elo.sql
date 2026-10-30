-- Wave 5: separate singles vs doubles player Elo + pair partnership Elo

alter table public.players
  add column if not exists doubles_rating numeric not null default 1000,
  add column if not exists doubles_matches_played integer not null default 0,
  add column if not exists doubles_wins integer not null default 0,
  add column if not exists doubles_streak_count integer not null default 0;

-- Seed doubles from legacy shared rating (future matches diverge by format)
update public.players set doubles_rating = coalesce(rating, 1000);

alter table public.match_history
  add column if not exists rating_format text not null default 'singles'
    check (rating_format in ('singles', 'doubles'));

-- ---------------------------------------------------------------------------
-- Pair (partnership) Elo
-- ---------------------------------------------------------------------------

create table if not exists public.pair_ratings (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  player_low_id uuid not null references public.players(id) on delete cascade,
  player_high_id uuid not null references public.players(id) on delete cascade,
  rating numeric not null default 1000,
  matches_played integer not null default 0,
  wins integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pair_ratings_ordered check (player_low_id < player_high_id),
  constraint pair_ratings_unique unique (club_id, player_low_id, player_high_id)
);

create index if not exists pair_ratings_club_rating_idx
  on public.pair_ratings (club_id, rating desc);

alter table public.pair_ratings enable row level security;

drop policy if exists pair_ratings_select on public.pair_ratings;
create policy pair_ratings_select on public.pair_ratings for select using (
  public.is_club_member(club_id)
);

create table if not exists public.pair_match_history (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  pair_id uuid not null references public.pair_ratings(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  rating_before numeric not null,
  rating_after numeric not null,
  rating_change numeric not null,
  is_winner boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists pair_match_history_match_idx on public.pair_match_history (match_id);

alter table public.pair_match_history enable row level security;

drop policy if exists pair_match_history_select on public.pair_match_history;
create policy pair_match_history_select on public.pair_match_history for select using (
  public.is_club_member(club_id)
);

create or replace function public.ensure_pair_rating(
  p_club_id uuid,
  p_player_a uuid,
  p_player_b uuid
)
returns public.pair_ratings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_low uuid;
  v_high uuid;
  v_pair public.pair_ratings;
begin
  if p_player_a is null or p_player_b is null or p_player_a = p_player_b then
    raise exception 'Pair needs two distinct players';
  end if;

  if p_player_a < p_player_b then
    v_low := p_player_a;
    v_high := p_player_b;
  else
    v_low := p_player_b;
    v_high := p_player_a;
  end if;

  select * into v_pair
  from public.pair_ratings
  where club_id = p_club_id
    and player_low_id = v_low
    and player_high_id = v_high;

  if v_pair is null then
    insert into public.pair_ratings (club_id, player_low_id, player_high_id)
    values (p_club_id, v_low, v_high)
    returning * into v_pair;
  end if;

  return v_pair;
end;
$$;

grant execute on function public.ensure_pair_rating(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- log_match: format-aware Elo + pair Elo on doubles
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
  p_session_id uuid default null,
  p_session_note text default null,
  p_is_disputed boolean default false
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
  v_min_mp int;
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
  v_is_doubles boolean;
  v_format text;
  v_pair1 public.pair_ratings;
  v_pair2 public.pair_ratings;
  v_p1_before numeric;
  v_p2_before numeric;
  v_p1_after numeric;
  v_p2_after numeric;
  v_pair_events jsonb := '[]'::jsonb;
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

  v_is_doubles := (p_team1_player2_id is not null and p_team2_player2_id is not null);
  if (p_team1_player2_id is null) <> (p_team2_player2_id is null) then
    raise exception 'Singles and doubles sides must match (both singles or both doubles)';
  end if;
  v_format := case when v_is_doubles then 'doubles' else 'singles' end;

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

  -- Provisional K: format-specific match counts
  if v_is_doubles then
    select min(coalesce(doubles_matches_played, 0)) into v_min_mp
    from public.players
    where id = any (v_ids) and club_id = p_club_id;
  else
    select min(coalesce(matches_played, 0)) into v_min_mp
    from public.players
    where id = any (v_ids) and club_id = p_club_id;
  end if;

  if coalesce(v_min_mp, 0) < 8 then
    v_k := 40;
  end if;

  v_winner := case when p_team1_score > p_team2_score then 'team1' else 'team2' end;

  select id into v_season_id from public.seasons
  where club_id = p_club_id and is_active = true
  order by starts_at desc limit 1;

  if v_is_doubles then
    select avg(doubles_rating)::numeric into v_t1_rating
    from public.players
    where id = any (array[p_team1_player1_id, p_team1_player2_id])
      and club_id = p_club_id;

    select avg(doubles_rating)::numeric into v_t2_rating
    from public.players
    where id = any (array[p_team2_player1_id, p_team2_player2_id])
      and club_id = p_club_id;
  else
    select avg(rating)::numeric into v_t1_rating
    from public.players
    where id = p_team1_player1_id and club_id = p_club_id;

    select avg(rating)::numeric into v_t2_rating
    from public.players
    where id = p_team2_player1_id and club_id = p_club_id;
  end if;

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
    team1_score, team2_score, winner, created_at,
    session_note, is_disputed
  ) values (
    p_club_id, v_season_id, p_session_id, auth.uid(),
    p_team1_player1_id, p_team1_player2_id,
    p_team2_player1_id, p_team2_player2_id,
    p_team1_score, p_team2_score, v_winner, coalesce(p_played_at, now()),
    nullif(trim(p_session_note), ''), coalesce(p_is_disputed, false)
  ) returning id into v_match_id;

  -- Disputed: history only, no Elo mutation
  if coalesce(p_is_disputed, false) then
    for r in
      select id, rating, doubles_rating
      from public.players
      where id = any (v_ids) and club_id = p_club_id
    loop
      insert into public.match_history (
        match_id, player_id, club_id, date,
        rating_before, rating_after, rating_change,
        score_difference, is_winner, rating_format
      ) values (
        v_match_id, r.id, p_club_id, coalesce(p_played_at, now()),
        case when v_is_doubles then r.doubles_rating else r.rating end,
        case when v_is_doubles then r.doubles_rating else r.rating end,
        0,
        abs(p_team1_score - p_team2_score),
        (
          (r.id in (p_team1_player1_id, p_team1_player2_id) and v_winner = 'team1')
          or (r.id in (p_team2_player1_id, p_team2_player2_id) and v_winner = 'team2')
        ),
        v_format
      );

      v_events := v_events || jsonb_build_object(
        'player_id', r.id,
        'rating_before', case when v_is_doubles then r.doubles_rating else r.rating end,
        'rating_after', case when v_is_doubles then r.doubles_rating else r.rating end,
        'rating_change', 0,
        'is_winner', false,
        'disputed', true,
        'format', v_format
      );
    end loop;

    return jsonb_build_object(
      'match_id', v_match_id,
      'winner', v_winner,
      'k_factor', v_k,
      'disputed', true,
      'format', v_format,
      'events', v_events,
      'pair_events', v_pair_events
    );
  end if;

  for r in
    select id, rating, doubles_rating, matches_played, wins, streak_count,
           doubles_matches_played, doubles_wins, doubles_streak_count,
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

    if v_is_doubles then
      v_new_rating := greatest(800, round(r.doubles_rating + v_delta));

      update public.players set
        doubles_rating = v_new_rating,
        doubles_matches_played = coalesce(doubles_matches_played, 0) + 1,
        doubles_wins = coalesce(doubles_wins, 0) + case when v_is_winner then 1 else 0 end,
        doubles_streak_count = case when v_is_winner then coalesce(doubles_streak_count, 0) + 1 else 0 end,
        last_played_at = coalesce(p_played_at, now()),
        season_id = v_season_id,
        updated_at = now()
      where id = r.id;

      insert into public.match_history (
        match_id, player_id, club_id, date,
        rating_before, rating_after, rating_change,
        score_difference, is_winner, rating_format
      ) values (
        v_match_id, r.id, p_club_id, coalesce(p_played_at, now()),
        r.doubles_rating, v_new_rating, v_delta,
        abs(p_team1_score - p_team2_score), v_is_winner, 'doubles'
      );

      v_events := v_events || jsonb_build_object(
        'player_id', r.id,
        'rating_before', r.doubles_rating,
        'rating_after', v_new_rating,
        'rating_change', v_delta,
        'is_winner', v_is_winner,
        'format', 'doubles'
      );
    else
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
        score_difference, is_winner, rating_format
      ) values (
        v_match_id, r.id, p_club_id, coalesce(p_played_at, now()),
        r.rating, v_new_rating, v_delta,
        abs(p_team1_score - p_team2_score), v_is_winner, 'singles'
      );

      v_events := v_events || jsonb_build_object(
        'player_id', r.id,
        'rating_before', r.rating,
        'rating_after', v_new_rating,
        'rating_change', v_delta,
        'is_winner', v_is_winner,
        'format', 'singles'
      );
    end if;
  end loop;

  -- Pair Elo (doubles only): partnership strength independent of individual doubles Elo
  if v_is_doubles then
    v_pair1 := public.ensure_pair_rating(p_club_id, p_team1_player1_id, p_team1_player2_id);
    v_pair2 := public.ensure_pair_rating(p_club_id, p_team2_player1_id, p_team2_player2_id);

    v_p1_before := v_pair1.rating;
    v_p2_before := v_pair2.rating;

    v_t1_expected := 1 / (1 + power(10, (v_p2_before - v_p1_before) / 400.0));
    v_t2_expected := 1 / (1 + power(10, (v_p1_before - v_p2_before) / 400.0));
    v_t1_change := round(v_k * ((case when v_winner = 'team1' then 1 else 0 end) - v_t1_expected));
    v_t2_change := round(v_k * ((case when v_winner = 'team2' then 1 else 0 end) - v_t2_expected));

    v_p1_after := greatest(800, round(v_p1_before + v_t1_change));
    v_p2_after := greatest(800, round(v_p2_before + v_t2_change));

    update public.pair_ratings set
      rating = v_p1_after,
      matches_played = coalesce(matches_played, 0) + 1,
      wins = coalesce(wins, 0) + case when v_winner = 'team1' then 1 else 0 end,
      updated_at = now()
    where id = v_pair1.id;

    update public.pair_ratings set
      rating = v_p2_after,
      matches_played = coalesce(matches_played, 0) + 1,
      wins = coalesce(wins, 0) + case when v_winner = 'team2' then 1 else 0 end,
      updated_at = now()
    where id = v_pair2.id;

    insert into public.pair_match_history (
      match_id, pair_id, club_id,
      rating_before, rating_after, rating_change, is_winner
    ) values
      (v_match_id, v_pair1.id, p_club_id, v_p1_before, v_p1_after, v_t1_change, v_winner = 'team1'),
      (v_match_id, v_pair2.id, p_club_id, v_p2_before, v_p2_after, v_t2_change, v_winner = 'team2');

    v_pair_events := jsonb_build_array(
      jsonb_build_object(
        'pair_id', v_pair1.id,
        'player_ids', jsonb_build_array(v_pair1.player_low_id, v_pair1.player_high_id),
        'rating_before', v_p1_before,
        'rating_after', v_p1_after,
        'rating_change', v_t1_change,
        'is_winner', v_winner = 'team1'
      ),
      jsonb_build_object(
        'pair_id', v_pair2.id,
        'player_ids', jsonb_build_array(v_pair2.player_low_id, v_pair2.player_high_id),
        'rating_before', v_p2_before,
        'rating_after', v_p2_after,
        'rating_change', v_t2_change,
        'is_winner', v_winner = 'team2'
      )
    );
  end if;

  return jsonb_build_object(
    'match_id', v_match_id,
    'winner', v_winner,
    'k_factor', v_k,
    'disputed', false,
    'format', v_format,
    'events', v_events,
    'pair_events', v_pair_events
  );
end;
$$;

grant execute on function public.log_match(
  uuid, uuid, uuid, uuid, uuid, int, int, timestamptz, uuid, text, boolean
) to authenticated;

-- ---------------------------------------------------------------------------
-- undo_match: restore singles or doubles + pair Elo
-- ---------------------------------------------------------------------------

create or replace function public.undo_match(p_match_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.matches;
  v_latest uuid;
  r record;
  v_mp int;
  v_wins int;
  v_reverted jsonb := '[]'::jsonb;
  v_pair_reverted jsonb := '[]'::jsonb;
  v_format text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_match from public.matches where id = p_match_id;
  if v_match is null then
    raise exception 'Match not found';
  end if;

  if v_match.club_id is null or not public.is_club_member(v_match.club_id) then
    raise exception 'Not a club member';
  end if;

  if public.club_role(v_match.club_id) not in ('owner', 'admin', 'coach') then
    raise exception 'Insufficient permissions';
  end if;

  select id into v_latest
  from public.matches
  where club_id = v_match.club_id
  order by created_at desc, id desc
  limit 1;

  if v_latest is distinct from p_match_id then
    raise exception 'Only the most recent club match can be undone';
  end if;

  select coalesce(max(rating_format), 'singles') into v_format
  from public.match_history
  where match_id = p_match_id;

  for r in
    select * from public.match_history where match_id = p_match_id
  loop
    if coalesce(r.rating_format, 'singles') = 'doubles' then
      select doubles_matches_played, doubles_wins into v_mp, v_wins
      from public.players where id = r.player_id;

      v_mp := greatest(0, coalesce(v_mp, 0) - 1);
      v_wins := greatest(0, coalesce(v_wins, 0) - case when r.is_winner then 1 else 0 end);

      update public.players set
        doubles_rating = r.rating_before,
        doubles_matches_played = v_mp,
        doubles_wins = v_wins,
        doubles_streak_count = 0,
        updated_at = now()
      where id = r.player_id;
    else
      select matches_played, wins into v_mp, v_wins
      from public.players where id = r.player_id;

      v_mp := greatest(0, coalesce(v_mp, 0) - 1);
      v_wins := greatest(0, coalesce(v_wins, 0) - case when r.is_winner then 1 else 0 end);

      update public.players set
        rating = r.rating_before,
        matches_played = v_mp,
        wins = v_wins,
        win_rate = case when v_mp > 0 then (v_wins::numeric / v_mp) * 100 else 0 end,
        streak_count = 0,
        updated_at = now()
      where id = r.player_id;
    end if;

    v_reverted := v_reverted || jsonb_build_object(
      'player_id', r.player_id,
      'rating_restored', r.rating_before,
      'format', coalesce(r.rating_format, 'singles')
    );
  end loop;

  for r in
    select * from public.pair_match_history where match_id = p_match_id
  loop
    select matches_played, wins into v_mp, v_wins
    from public.pair_ratings where id = r.pair_id;

    v_mp := greatest(0, coalesce(v_mp, 0) - 1);
    v_wins := greatest(0, coalesce(v_wins, 0) - case when r.is_winner then 1 else 0 end);

    update public.pair_ratings set
      rating = r.rating_before,
      matches_played = v_mp,
      wins = v_wins,
      updated_at = now()
    where id = r.pair_id;

    v_pair_reverted := v_pair_reverted || jsonb_build_object(
      'pair_id', r.pair_id,
      'rating_restored', r.rating_before
    );
  end loop;

  delete from public.matches where id = p_match_id;

  return jsonb_build_object(
    'undone_match_id', p_match_id,
    'format', v_format,
    'players', v_reverted,
    'pairs', v_pair_reverted
  );
end;
$$;

grant execute on function public.undo_match(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Season reset includes doubles + optional pair wipe on hard reset
-- ---------------------------------------------------------------------------

create or replace function public.start_season(
  p_club_id uuid,
  p_name text,
  p_hard_reset boolean default true
)
returns public.seasons
language plpgsql
security definer
set search_path = public
as $$
declare
  v_season public.seasons;
begin
  if public.club_role(p_club_id) not in ('owner', 'admin') then
    raise exception 'Insufficient permissions';
  end if;

  update public.seasons
  set is_active = false, ends_at = now()
  where club_id = p_club_id and is_active = true;

  insert into public.seasons (club_id, name, is_active)
  values (p_club_id, p_name, true)
  returning * into v_season;

  if coalesce(p_hard_reset, true) then
    update public.players
    set rating = 1000,
        matches_played = 0,
        wins = 0,
        win_rate = 0,
        streak_count = 0,
        doubles_rating = 1000,
        doubles_matches_played = 0,
        doubles_wins = 0,
        doubles_streak_count = 0,
        season_id = v_season.id
    where club_id = p_club_id
      and archived_at is null;

    update public.pair_ratings
    set rating = 1000,
        matches_played = 0,
        wins = 0,
        updated_at = now()
    where club_id = p_club_id;
  else
    update public.players
    set matches_played = 0,
        wins = 0,
        win_rate = 0,
        streak_count = 0,
        doubles_matches_played = 0,
        doubles_wins = 0,
        doubles_streak_count = 0,
        season_id = v_season.id
    where club_id = p_club_id
      and archived_at is null;
  end if;

  return v_season;
end;
$$;

grant execute on function public.start_season(uuid, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Public ladder + averages include doubles
-- ---------------------------------------------------------------------------

create or replace function public.get_public_ladder(p_share_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club public.clubs;
  v_players jsonb;
begin
  select * into v_club from public.clubs where share_token = p_share_token;
  if v_club is null then
    raise exception 'Ladder not found';
  end if;

  select coalesce(jsonb_agg(row_to_json(p)::jsonb order by p.doubles_rating desc), '[]'::jsonb)
  into v_players
  from (
    select id, name, rating, doubles_rating,
           matches_played, doubles_matches_played,
           wins, doubles_wins, win_rate, streak_count, doubles_streak_count
    from public.players
    where club_id = v_club.id
      and archived_at is null
      and coalesce(is_guest, false) = false
    order by doubles_rating desc
  ) p;

  return jsonb_build_object(
    'club', jsonb_build_object('id', v_club.id, 'name', v_club.name),
    'players', v_players
  );
end;
$$;

grant execute on function public.get_public_ladder(text) to anon, authenticated;

create or replace function public.club_average_rating(p_club_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(round(avg(rating)), 1000)
  from public.players
  where club_id = p_club_id
    and archived_at is null
    and coalesce(is_guest, false) = false;
$$;

grant execute on function public.club_average_rating(uuid) to authenticated;

create or replace function public.club_average_doubles_rating(p_club_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(round(avg(doubles_rating)), 1000)
  from public.players
  where club_id = p_club_id
    and archived_at is null
    and coalesce(is_guest, false) = false;
$$;

grant execute on function public.club_average_doubles_rating(uuid) to authenticated;
