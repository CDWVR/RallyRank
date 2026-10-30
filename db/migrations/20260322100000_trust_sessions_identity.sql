-- Phase A–C: trust (memberships, undo, distinct players), sessions, identity helpers

-- ---------------------------------------------------------------------------
-- Memberships: no client self-join; leave / kick / role change
-- ---------------------------------------------------------------------------

drop policy if exists memberships_insert on public.memberships;
-- Inserts only via security-definer RPCs (create_club, join_club_with_code)

drop policy if exists memberships_update on public.memberships;
create policy memberships_update on public.memberships for update using (
  public.club_role(club_id) = 'owner'
  and user_id <> auth.uid()
) with check (
  public.club_role(club_id) = 'owner'
  and role in ('admin', 'coach')
);

drop policy if exists memberships_delete on public.memberships;
create policy memberships_delete on public.memberships for delete using (
  -- Leave own club (non-owners always; owners only if another owner exists)
  (
    user_id = auth.uid()
    and (
      role <> 'owner'
      or exists (
        select 1 from public.memberships m2
        where m2.club_id = memberships.club_id
          and m2.role = 'owner'
          and m2.user_id <> auth.uid()
      )
    )
  )
  or (
    -- Owner/admin kick non-owners
    public.club_role(club_id) in ('owner', 'admin')
    and user_id <> auth.uid()
    and role <> 'owner'
  )
);

-- Fix re-join role overwrite / escalation
create or replace function public.join_club_with_code(p_code text)
returns public.clubs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.invites;
  v_club public.clubs;
  v_existing public.memberships;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_invite
  from public.invites
  where upper(code) = upper(trim(p_code))
    and used_at is null
    and (expires_at is null or expires_at > now())
  for update;

  if v_invite is null then
    raise exception 'Invalid or expired invite code';
  end if;

  select * into v_existing
  from public.memberships
  where club_id = v_invite.club_id and user_id = auth.uid();

  if v_existing is null then
    insert into public.memberships (club_id, user_id, role)
    values (v_invite.club_id, auth.uid(), v_invite.role);
  end if;
  -- Existing members keep their current role (no downgrade / escalate via invite)

  update public.invites
  set used_by = auth.uid(), used_at = now()
  where id = v_invite.id;

  select * into v_club from public.clubs where id = v_invite.club_id;
  return v_club;
end;
$$;

create or replace function public.leave_club(p_club_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_other_owners int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select role into v_role
  from public.memberships
  where club_id = p_club_id and user_id = auth.uid();

  if v_role is null then
    raise exception 'Not a club member';
  end if;

  if v_role = 'owner' then
    select count(*) into v_other_owners
    from public.memberships
    where club_id = p_club_id and role = 'owner' and user_id <> auth.uid();
    if v_other_owners < 1 then
      raise exception 'Transfer ownership before leaving as the sole owner';
    end if;
  end if;

  delete from public.memberships
  where club_id = p_club_id and user_id = auth.uid();
end;
$$;

create or replace function public.remove_member(p_club_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target text;
begin
  if public.club_role(p_club_id) not in ('owner', 'admin') then
    raise exception 'Insufficient permissions';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'Use leave_club to leave yourself';
  end if;

  select role into v_target
  from public.memberships
  where club_id = p_club_id and user_id = p_user_id;

  if v_target is null then
    raise exception 'Member not found';
  end if;

  if v_target = 'owner' then
    raise exception 'Cannot remove an owner';
  end if;

  if v_target = 'admin' and public.club_role(p_club_id) <> 'owner' then
    raise exception 'Only owners can remove admins';
  end if;

  delete from public.memberships
  where club_id = p_club_id and user_id = p_user_id;
end;
$$;

create or replace function public.update_member_role(
  p_club_id uuid,
  p_user_id uuid,
  p_role text
)
returns public.memberships
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.memberships;
  v_target text;
begin
  if public.club_role(p_club_id) <> 'owner' then
    raise exception 'Only owners can change roles';
  end if;

  if p_role not in ('admin', 'coach') then
    raise exception 'Role must be admin or coach';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'Cannot change your own role';
  end if;

  select role into v_target
  from public.memberships
  where club_id = p_club_id and user_id = p_user_id;

  if v_target is null then
    raise exception 'Member not found';
  end if;

  if v_target = 'owner' then
    raise exception 'Cannot change an owner role via this RPC';
  end if;

  update public.memberships
  set role = p_role
  where club_id = p_club_id and user_id = p_user_id
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- log_match: distinct players
-- ---------------------------------------------------------------------------

create or replace function public.log_match(
  p_club_id uuid,
  p_team1_player1_id uuid,
  p_team1_player2_id uuid,
  p_team2_player1_id uuid,
  p_team2_player2_id uuid,
  p_team1_score int,
  p_team2_score int,
  p_played_at timestamptz default now()
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
    club_id, season_id, user_id,
    team1_player1_id, team1_player2_id,
    team2_player1_id, team2_player2_id,
    team1_score, team2_score, winner, created_at
  ) values (
    p_club_id, v_season_id, auth.uid(),
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

-- ---------------------------------------------------------------------------
-- undo_match: revert Elo from match_history (club's latest match only)
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

  for r in
    select * from public.match_history where match_id = p_match_id
  loop
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

    v_reverted := v_reverted || jsonb_build_object(
      'player_id', r.player_id,
      'rating_restored', r.rating_before
    );
  end loop;

  delete from public.matches where id = p_match_id;

  return jsonb_build_object(
    'undone_match_id', p_match_id,
    'players', v_reverted
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Share token rotate
-- ---------------------------------------------------------------------------

create or replace function public.rotate_share_token(p_club_id uuid)
returns public.clubs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club public.clubs;
begin
  if public.club_role(p_club_id) not in ('owner', 'admin') then
    raise exception 'Insufficient permissions';
  end if;

  update public.clubs
  set share_token = encode(gen_random_bytes(12), 'hex'),
      updated_at = now()
  where id = p_club_id
  returning * into v_club;

  return v_club;
end;
$$;

-- ---------------------------------------------------------------------------
-- Link roster player ↔ auth user
-- ---------------------------------------------------------------------------

create or replace function public.link_player_to_user(p_player_id uuid)
returns public.players
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.players;
  v_taken uuid;
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

  if v_player.user_id is not null and v_player.user_id <> auth.uid() then
    raise exception 'Player already linked to another account';
  end if;

  select id into v_taken
  from public.players
  where club_id = v_player.club_id
    and user_id = auth.uid()
    and id <> p_player_id
  limit 1;

  if v_taken is not null then
    raise exception 'You are already linked to another roster player in this club';
  end if;

  update public.players
  set user_id = auth.uid(), updated_at = now()
  where id = p_player_id
  returning * into v_player;

  return v_player;
end;
$$;

create or replace function public.unlink_player(p_player_id uuid)
returns public.players
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.players;
begin
  select * into v_player from public.players where id = p_player_id;
  if v_player is null then
    raise exception 'Player not found';
  end if;

  if v_player.club_id is null then
    raise exception 'Player has no club';
  end if;

  if v_player.user_id <> auth.uid()
     and public.club_role(v_player.club_id) not in ('owner', 'admin') then
    raise exception 'Insufficient permissions';
  end if;

  update public.players
  set user_id = null, updated_at = now()
  where id = p_player_id
  returning * into v_player;

  return v_player;
end;
$$;

-- ---------------------------------------------------------------------------
-- Club sessions (Tonight OS persistence)
-- ---------------------------------------------------------------------------

create table if not exists public.club_sessions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  opened_by uuid references auth.users(id) on delete set null,
  court_count integer not null default 1 check (court_count between 1 and 8),
  status text not null default 'open' check (status in ('open', 'closed')),
  attendee_ids uuid[] not null default '{}',
  team_a_ids uuid[] not null default '{}',
  team_b_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists idx_club_sessions_club_status
  on public.club_sessions(club_id, status);

alter table public.club_sessions enable row level security;

drop policy if exists club_sessions_select on public.club_sessions;
create policy club_sessions_select on public.club_sessions for select using (
  public.is_club_member(club_id)
);

drop policy if exists club_sessions_insert on public.club_sessions;
create policy club_sessions_insert on public.club_sessions for insert with check (
  public.is_club_member(club_id)
);

drop policy if exists club_sessions_update on public.club_sessions;
create policy club_sessions_update on public.club_sessions for update using (
  public.is_club_member(club_id)
);

create or replace function public.get_or_open_session(p_club_id uuid)
returns public.club_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.club_sessions;
begin
  if not public.is_club_member(p_club_id) then
    raise exception 'Not a club member';
  end if;

  select * into v_session
  from public.club_sessions
  where club_id = p_club_id and status = 'open'
  order by created_at desc
  limit 1;

  if v_session is null then
    insert into public.club_sessions (club_id, opened_by)
    values (p_club_id, auth.uid())
    returning * into v_session;
  end if;

  return v_session;
end;
$$;

create or replace function public.save_session_state(
  p_session_id uuid,
  p_attendee_ids uuid[],
  p_team_a_ids uuid[],
  p_team_b_ids uuid[],
  p_court_count int default null
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
    updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return v_session;
end;
$$;

create or replace function public.close_session(p_session_id uuid)
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

  update public.club_sessions set
    status = 'closed',
    closed_at = now(),
    updated_at = now()
  where id = p_session_id
  returning * into v_session;

  return v_session;
end;
$$;

-- Grants
grant execute on function public.leave_club(uuid) to authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.update_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.undo_match(uuid) to authenticated;
grant execute on function public.rotate_share_token(uuid) to authenticated;
grant execute on function public.link_player_to_user(uuid) to authenticated;
grant execute on function public.unlink_player(uuid) to authenticated;
grant execute on function public.get_or_open_session(uuid) to authenticated;
grant execute on function public.save_session_state(uuid, uuid[], uuid[], uuid[], int) to authenticated;
grant execute on function public.close_session(uuid) to authenticated;
