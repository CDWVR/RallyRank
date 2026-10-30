-- Wave 4: match notes/dispute, provisional K, profiles RLS, soft season, templates

alter table public.matches
  add column if not exists is_disputed boolean not null default false;

-- ---------------------------------------------------------------------------
-- Profiles: club-mates only (+ self)
-- ---------------------------------------------------------------------------

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select using (
  id = auth.uid()
  or exists (
    select 1
    from public.memberships mine
    join public.memberships theirs
      on theirs.club_id = mine.club_id
     and theirs.user_id = profiles.id
    where mine.user_id = auth.uid()
  )
);

-- ---------------------------------------------------------------------------
-- log_match: notes, dispute flag, provisional K
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

  -- Provisional K while any player has fewer than 8 rated matches
  select min(coalesce(matches_played, 0)) into v_min_mp
  from public.players
  where id = any (v_ids) and club_id = p_club_id;

  if coalesce(v_min_mp, 0) < 8 then
    v_k := 40;
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
    team1_score, team2_score, winner, created_at,
    session_note, is_disputed
  ) values (
    p_club_id, v_season_id, p_session_id, auth.uid(),
    p_team1_player1_id, p_team1_player2_id,
    p_team2_player1_id, p_team2_player2_id,
    p_team1_score, p_team2_score, v_winner, coalesce(p_played_at, now()),
    nullif(trim(p_session_note), ''), coalesce(p_is_disputed, false)
  ) returning id into v_match_id;

  -- Disputed matches still record history but skip Elo mutation
  if coalesce(p_is_disputed, false) then
    for r in
      select id, rating
      from public.players
      where id = any (v_ids) and club_id = p_club_id
    loop
      insert into public.match_history (
        match_id, player_id, club_id, date,
        rating_before, rating_after, rating_change,
        score_difference, is_winner
      ) values (
        v_match_id, r.id, p_club_id, coalesce(p_played_at, now()),
        r.rating, r.rating, 0,
        abs(p_team1_score - p_team2_score),
        (
          (r.id in (p_team1_player1_id, p_team1_player2_id) and v_winner = 'team1')
          or (r.id in (p_team2_player1_id, p_team2_player2_id) and v_winner = 'team2')
        )
      );

      v_events := v_events || jsonb_build_object(
        'player_id', r.id,
        'rating_before', r.rating,
        'rating_after', r.rating,
        'rating_change', 0,
        'is_winner', false,
        'disputed', true
      );
    end loop;

    return jsonb_build_object(
      'match_id', v_match_id,
      'winner', v_winner,
      'k_factor', v_k,
      'disputed', true,
      'events', v_events
    );
  end if;

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
    'k_factor', v_k,
    'disputed', false,
    'events', v_events
  );
end;
$$;

grant execute on function public.log_match(
  uuid, uuid, uuid, uuid, uuid, int, int, timestamptz, uuid, text, boolean
) to authenticated;

create or replace function public.set_match_disputed(p_match_id uuid, p_disputed boolean)
returns public.matches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_match public.matches;
begin
  select * into v_match from public.matches where id = p_match_id;
  if v_match is null then
    raise exception 'Match not found';
  end if;

  if v_match.club_id is null
     or public.club_role(v_match.club_id) not in ('owner', 'admin', 'coach') then
    raise exception 'Insufficient permissions';
  end if;

  -- Flag only — does not retroactively undo Elo (use undo_match for that)
  update public.matches
  set is_disputed = coalesce(p_disputed, true),
      updated_at = now()
  where id = p_match_id
  returning * into v_match;

  return v_match;
end;
$$;

grant execute on function public.set_match_disputed(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Soft vs hard season reset
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
        season_id = v_season.id
    where club_id = p_club_id
      and archived_at is null;
  else
    -- Soft: keep ratings; reset season counters only
    update public.players
    set matches_played = 0,
        wins = 0,
        win_rate = 0,
        streak_count = 0,
        season_id = v_season.id
    where club_id = p_club_id
      and archived_at is null;
  end if;

  return v_season;
end;
$$;

grant execute on function public.start_season(uuid, text, boolean) to authenticated;

-- Mid-season join rating helper
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

-- ---------------------------------------------------------------------------
-- Session templates (recurring / reusable night setups)
-- ---------------------------------------------------------------------------

create table if not exists public.session_templates (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  name text not null,
  court_count integer not null default 1 check (court_count between 1 and 8),
  weekday integer check (weekday is null or (weekday between 0 and 6)),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.session_templates enable row level security;

drop policy if exists session_templates_select on public.session_templates;
create policy session_templates_select on public.session_templates for select using (
  public.is_club_member(club_id)
);

drop policy if exists session_templates_write on public.session_templates;
create policy session_templates_insert on public.session_templates for insert with check (
  public.is_club_member(club_id)
);

drop policy if exists session_templates_update on public.session_templates;
create policy session_templates_update on public.session_templates for update using (
  public.club_role(club_id) in ('owner', 'admin', 'coach')
);

drop policy if exists session_templates_delete on public.session_templates;
create policy session_templates_delete on public.session_templates for delete using (
  public.club_role(club_id) in ('owner', 'admin', 'coach')
);
