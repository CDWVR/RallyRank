-- L-01: Drop stale log_match / start_season overloads so PostgREST cannot
-- resolve to an older arity that mutates singles Elo only (or soft-reset only).
-- Keep the current full signatures from rem003 / wave5.
--
-- Surviving:
--   log_match(uuid,uuid,uuid,uuid,uuid,int,int,timestamptz,uuid,text,boolean)
--   start_season(uuid,text,boolean)
--
-- ROLLBACK: recreate the dropped signatures from older migrations
--   (20260321000000 / 20260322100000 / 20260322120000) — not recommended.

drop function if exists public.log_match(
  uuid, uuid, uuid, uuid, uuid, integer, integer, timestamp with time zone
);

drop function if exists public.log_match(
  uuid, uuid, uuid, uuid, uuid, integer, integer, timestamp with time zone, uuid
);

drop function if exists public.start_season(uuid, text);

-- Re-assert grants on the surviving overloads (idempotent).
grant execute on function public.log_match(
  uuid, uuid, uuid, uuid, uuid, integer, integer, timestamp with time zone,
  uuid, text, boolean
) to authenticated;

grant execute on function public.start_season(uuid, text, boolean) to authenticated;
