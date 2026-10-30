-- REM-004: At most one open club_sessions row per club.
-- Collapse any existing duplicates, then enforce with a partial unique index.
-- get_or_open_session: select open; if missing insert with unique_violation retry.
--
-- ROLLBACK:
--   drop index if exists public.club_sessions_one_open_per_club;
--   recreate get_or_open_session from 20260322100000_trust_sessions_identity.sql
--   (closed duplicate sessions from the data collapse stay closed — reopen manually if needed)

-- Keep newest open session per club; re-point matches; close extras
with ranked as (
  select
    id,
    club_id,
    row_number() over (
      partition by club_id
      order by created_at desc, id desc
    ) as rn
  from public.club_sessions
  where status = 'open'
),
keeper as (
  select id, club_id from ranked where rn = 1
),
dupes as (
  select id, club_id from ranked where rn > 1
)
update public.matches m
set session_id = k.id
from dupes d
join keeper k on k.club_id = d.club_id
where m.session_id = d.id;

with ranked as (
  select
    id,
    row_number() over (
      partition by club_id
      order by created_at desc, id desc
    ) as rn
  from public.club_sessions
  where status = 'open'
)
update public.club_sessions cs
set
  status = 'closed',
  closed_at = coalesce(cs.closed_at, now()),
  updated_at = now()
from ranked r
where cs.id = r.id
  and r.rn > 1;

create unique index if not exists club_sessions_one_open_per_club
  on public.club_sessions (club_id)
  where status = 'open';

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

  if v_session is not null then
    return v_session;
  end if;

  begin
    insert into public.club_sessions (club_id, opened_by)
    values (p_club_id, auth.uid())
    returning * into v_session;
  exception
    when unique_violation then
      select * into v_session
      from public.club_sessions
      where club_id = p_club_id and status = 'open'
      order by created_at desc
      limit 1;
  end;

  if v_session is null then
    raise exception 'Could not open session';
  end if;

  return v_session;
end;
$$;

grant execute on function public.get_or_open_session(uuid) to authenticated;
