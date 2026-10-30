-- RallyRank Phase 1: full schema bootstrap + clubs, memberships, invites, seasons, RLS, log_match RPC
-- Safe to re-run on empty or partially applied projects (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

-- Extensions
create extension if not exists "pgcrypto";

-- Profiles (1:1 with auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Clubs
create table if not exists public.clubs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  share_token text unique default encode(gen_random_bytes(12), 'hex'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Memberships
create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'coach')),
  created_at timestamptz not null default now(),
  unique (club_id, user_id)
);

-- Invites
create table if not exists public.invites (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  code text not null unique default upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8)),
  role text not null default 'coach' check (role in ('admin', 'coach')),
  expires_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  used_by uuid references auth.users(id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- Seasons
create table if not exists public.seasons (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  name text not null,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Players (roster)
create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  rating numeric not null default 1000,
  matches_played integer not null default 0,
  wins integer not null default 0,
  win_rate numeric default 0,
  streak_count integer default 0,
  last_played_at timestamptz,
  age integer,
  position text,
  user_id uuid references auth.users(id) on delete set null,
  club_id uuid references public.clubs(id) on delete cascade,
  season_id uuid references public.seasons(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Matches
create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  team1_player1_id uuid not null references public.players(id),
  team1_player2_id uuid references public.players(id),
  team2_player1_id uuid not null references public.players(id),
  team2_player2_id uuid references public.players(id),
  team1_score integer not null,
  team2_score integer not null,
  winner text not null,
  duration_minutes integer not null default 0,
  user_id uuid not null references auth.users(id),
  club_id uuid references public.clubs(id) on delete cascade,
  season_id uuid references public.seasons(id) on delete set null,
  session_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Rating / match history events
create table if not exists public.match_history (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  player_id uuid references public.players(id) on delete cascade,
  club_id uuid references public.clubs(id) on delete cascade,
  date timestamptz not null default now(),
  rating_before numeric not null,
  rating_after numeric not null,
  rating_change numeric not null,
  score_difference numeric not null,
  is_winner boolean not null,
  created_at timestamptz not null default now()
);

-- Upgrade path if tables already existed without tenancy columns
alter table public.players add column if not exists club_id uuid references public.clubs(id) on delete cascade;
alter table public.players add column if not exists season_id uuid references public.seasons(id) on delete set null;
alter table public.matches add column if not exists club_id uuid references public.clubs(id) on delete cascade;
alter table public.matches add column if not exists season_id uuid references public.seasons(id) on delete set null;
alter table public.matches add column if not exists session_note text;
alter table public.match_history add column if not exists player_id uuid references public.players(id) on delete cascade;
alter table public.match_history add column if not exists club_id uuid references public.clubs(id) on delete cascade;

create index if not exists idx_players_club on public.players(club_id);
create index if not exists idx_matches_club on public.matches(club_id);
create index if not exists idx_match_history_player on public.match_history(player_id);
create index if not exists idx_memberships_user on public.memberships(user_id);
create index if not exists idx_invites_code on public.invites(code);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Helper: is member of club
create or replace function public.is_club_member(p_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.club_id = p_club_id and m.user_id = auth.uid()
  );
$$;

create or replace function public.club_role(p_club_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select m.role from public.memberships m
  where m.club_id = p_club_id and m.user_id = auth.uid()
  limit 1;
$$;

-- Create club + owner membership + default season
create or replace function public.create_club(p_name text)
returns public.clubs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club public.clubs;
  v_slug text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  v_slug := lower(regexp_replace(p_name, '[^a-zA-Z0-9]+', '-', 'g')) || '-' || substr(gen_random_uuid()::text, 1, 6);

  insert into public.clubs (name, slug, created_by)
  values (trim(p_name), v_slug, auth.uid())
  returning * into v_club;

  insert into public.memberships (club_id, user_id, role)
  values (v_club.id, auth.uid(), 'owner');

  insert into public.seasons (club_id, name, is_active)
  values (v_club.id, 'Season 1', true);

  return v_club;
end;
$$;

-- Join club via invite code
create or replace function public.join_club_with_code(p_code text)
returns public.clubs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.invites;
  v_club public.clubs;
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

  insert into public.memberships (club_id, user_id, role)
  values (v_invite.club_id, auth.uid(), v_invite.role)
  on conflict (club_id, user_id) do update set role = excluded.role;

  update public.invites
  set used_by = auth.uid(), used_at = now()
  where id = v_invite.id;

  select * into v_club from public.clubs where id = v_invite.club_id;
  return v_club;
end;
$$;

-- Create invite
create or replace function public.create_invite(p_club_id uuid, p_role text default 'coach')
returns public.invites
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_invite public.invites;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if public.club_role(p_club_id) not in ('owner', 'admin') then
    raise exception 'Only owners and admins can create invites';
  end if;

  v_role := case when p_role in ('admin', 'coach') then p_role else 'coach' end;

  insert into public.invites (club_id, role, created_by, expires_at)
  values (p_club_id, v_role, auth.uid(), now() + interval '14 days')
  returning * into v_invite;

  return v_invite;
end;
$$;

-- Start new season (resets active flag; does not wipe history)
create or replace function public.start_season(p_club_id uuid, p_name text)
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

  -- Soft reset ratings for club players
  update public.players
  set rating = 1000,
      matches_played = 0,
      wins = 0,
      win_rate = 0,
      streak_count = 0,
      season_id = v_season.id
  where club_id = p_club_id;

  return v_season;
end;
$$;

-- Transactional log match + Elo
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

  v_winner := case when p_team1_score > p_team2_score then 'team1' else 'team2' end;

  select id into v_season_id from public.seasons
  where club_id = p_club_id and is_active = true
  order by starts_at desc limit 1;

  -- Average team ratings
  select avg(rating)::numeric into v_t1_rating
  from public.players
  where id in (p_team1_player1_id, p_team1_player2_id)
    and club_id = p_club_id;

  select avg(rating)::numeric into v_t2_rating
  from public.players
  where id in (p_team2_player1_id, p_team2_player2_id)
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
    where id in (p_team1_player1_id, p_team1_player2_id, p_team2_player1_id, p_team2_player2_id)
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

-- RLS
alter table public.clubs enable row level security;
alter table public.memberships enable row level security;
alter table public.invites enable row level security;
alter table public.seasons enable row level security;
alter table public.players enable row level security;
alter table public.matches enable row level security;
alter table public.match_history enable row level security;
alter table public.profiles enable row level security;

-- Clubs policies
drop policy if exists clubs_select on public.clubs;
create policy clubs_select on public.clubs for select using (
  public.is_club_member(id)
);

drop policy if exists clubs_update on public.clubs;
create policy clubs_update on public.clubs for update using (
  public.club_role(id) in ('owner', 'admin')
);

-- Memberships
drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships for select using (
  user_id = auth.uid() or public.is_club_member(club_id)
);

drop policy if exists memberships_insert on public.memberships;
create policy memberships_insert on public.memberships for insert with check (
  public.club_role(club_id) in ('owner', 'admin') or user_id = auth.uid()
);

-- Invites
drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites for select using (
  public.is_club_member(club_id)
);

drop policy if exists invites_insert on public.invites;
create policy invites_insert on public.invites for insert with check (
  public.club_role(club_id) in ('owner', 'admin')
);

-- Seasons
drop policy if exists seasons_select on public.seasons;
create policy seasons_select on public.seasons for select using (
  public.is_club_member(club_id)
);

-- Players
drop policy if exists players_select on public.players;
create policy players_select on public.players for select using (
  club_id is null or public.is_club_member(club_id)
);

drop policy if exists players_insert on public.players;
create policy players_insert on public.players for insert with check (
  public.is_club_member(club_id)
);

drop policy if exists players_update on public.players;
create policy players_update on public.players for update using (
  public.is_club_member(club_id)
);

drop policy if exists players_delete on public.players;
create policy players_delete on public.players for delete using (
  public.club_role(club_id) in ('owner', 'admin', 'coach')
);

-- Matches
drop policy if exists matches_select on public.matches;
create policy matches_select on public.matches for select using (
  club_id is null or public.is_club_member(club_id)
);

drop policy if exists matches_insert on public.matches;
create policy matches_insert on public.matches for insert with check (
  public.is_club_member(club_id)
);

drop policy if exists matches_delete on public.matches;
create policy matches_delete on public.matches for delete using (
  public.club_role(club_id) in ('owner', 'admin')
);

-- Match history
drop policy if exists match_history_select on public.match_history;
create policy match_history_select on public.match_history for select using (
  club_id is null or public.is_club_member(club_id)
);

drop policy if exists match_history_insert on public.match_history;
create policy match_history_insert on public.match_history for insert with check (
  public.is_club_member(club_id)
);

-- Profiles
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select using (true);

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update using (id = auth.uid());

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert with check (id = auth.uid());

-- Public ladder by share token (security definer)
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

  select coalesce(jsonb_agg(row_to_json(p)::jsonb order by p.rating desc), '[]'::jsonb)
  into v_players
  from (
    select id, name, rating, matches_played, wins, win_rate, streak_count
    from public.players
    where club_id = v_club.id
    order by rating desc
  ) p;

  return jsonb_build_object(
    'club', jsonb_build_object('id', v_club.id, 'name', v_club.name),
    'players', v_players
  );
end;
$$;

grant execute on function public.create_club(text) to authenticated;
grant execute on function public.join_club_with_code(text) to authenticated;
grant execute on function public.create_invite(uuid, text) to authenticated;
grant execute on function public.start_season(uuid, text) to authenticated;
grant execute on function public.log_match(uuid, uuid, uuid, uuid, uuid, int, int, timestamptz) to authenticated;
grant execute on function public.get_public_ladder(text) to anon, authenticated;
