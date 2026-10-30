-- REM-002: Gate ensure_pair_rating with auth + membership + club ownership of both players.
-- Keep SECURITY DEFINER so log_match can still call it after EXECUTE is revoked from clients.
--
-- ROLLBACK:
--   recreate ensure_pair_rating body from 20260322180000_doubles_pair_elo.sql (no auth checks)
--   grant execute on function public.ensure_pair_rating(uuid, uuid, uuid) to authenticated;

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
  v_count int;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_club_member(p_club_id) then
    raise exception 'Not a club member';
  end if;

  if p_player_a is null or p_player_b is null or p_player_a = p_player_b then
    raise exception 'Pair needs two distinct players';
  end if;

  select count(*)::int into v_count
  from public.players
  where club_id = p_club_id
    and id in (p_player_a, p_player_b);

  if v_count <> 2 then
    raise exception 'Both players must belong to the club';
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

revoke execute on function public.ensure_pair_rating(uuid, uuid, uuid) from public;
revoke execute on function public.ensure_pair_rating(uuid, uuid, uuid) from authenticated;
