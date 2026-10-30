-- Wave 3: guests, archive, invite revoke, public ladder excludes guests

alter table public.players
  add column if not exists is_guest boolean not null default false;

alter table public.players
  add column if not exists archived_at timestamptz;

alter table public.invites
  add column if not exists revoked_at timestamptz;

create index if not exists idx_players_club_active
  on public.players(club_id)
  where archived_at is null;

-- Join must ignore revoked invites
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
    and revoked_at is null
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

  update public.invites
  set used_by = auth.uid(), used_at = now()
  where id = v_invite.id;

  select * into v_club from public.clubs where id = v_invite.club_id;
  return v_club;
end;
$$;

create or replace function public.revoke_invite(p_invite_id uuid)
returns public.invites
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.invites;
begin
  select * into v_invite from public.invites where id = p_invite_id;
  if v_invite is null then
    raise exception 'Invite not found';
  end if;

  if public.club_role(v_invite.club_id) not in ('owner', 'admin') then
    raise exception 'Insufficient permissions';
  end if;

  if v_invite.used_at is not null then
    raise exception 'Invite already used';
  end if;

  update public.invites
  set revoked_at = now()
  where id = p_invite_id
  returning * into v_invite;

  return v_invite;
end;
$$;

create or replace function public.archive_player(p_player_id uuid)
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

  if v_player.club_id is null
     or public.club_role(v_player.club_id) not in ('owner', 'admin', 'coach') then
    raise exception 'Insufficient permissions';
  end if;

  update public.players
  set archived_at = now(), updated_at = now(), user_id = null
  where id = p_player_id
  returning * into v_player;

  return v_player;
end;
$$;

create or replace function public.promote_guest(p_player_id uuid)
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

  if v_player.club_id is null or not public.is_club_member(v_player.club_id) then
    raise exception 'Not a club member';
  end if;

  update public.players
  set is_guest = false, updated_at = now()
  where id = p_player_id
  returning * into v_player;

  return v_player;
end;
$$;

create or replace function public.rename_club(p_club_id uuid, p_name text)
returns public.clubs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_club public.clubs;
  v_slug text;
begin
  if public.club_role(p_club_id) not in ('owner', 'admin') then
    raise exception 'Insufficient permissions';
  end if;

  if length(trim(p_name)) < 2 then
    raise exception 'Club name too short';
  end if;

  v_slug := lower(regexp_replace(trim(p_name), '[^a-zA-Z0-9]+', '-', 'g'))
    || '-' || substr(gen_random_uuid()::text, 1, 6);

  update public.clubs
  set name = trim(p_name),
      slug = v_slug,
      updated_at = now()
  where id = p_club_id
  returning * into v_club;

  return v_club;
end;
$$;

-- Public ladder: exclude guests + archived
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
      and archived_at is null
      and coalesce(is_guest, false) = false
    order by rating desc
  ) p;

  return jsonb_build_object(
    'club', jsonb_build_object('id', v_club.id, 'name', v_club.name),
    'players', v_players
  );
end;
$$;

grant execute on function public.revoke_invite(uuid) to authenticated;
grant execute on function public.archive_player(uuid) to authenticated;
grant execute on function public.promote_guest(uuid) to authenticated;
grant execute on function public.rename_club(uuid, text) to authenticated;
