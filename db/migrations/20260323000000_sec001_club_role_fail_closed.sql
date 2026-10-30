-- SEC-001: permission checks failed open for non-members.
-- club_role() returned NULL when the caller has no membership, and every RPC guards with
--   if public.club_role(x) not in ('owner', 'admin') then raise ...
-- but `NULL not in (...)` is NULL, so the IF never fired and any signed-in user could e.g. rename
-- or administer another club. Returning 'none' makes all ~18 of those checks fail closed without
-- touching each function. Positive checks (`club_role(x) in (...)`, used by RLS policies) are unaffected.
-- Rollback: re-create the previous definition (without coalesce) from 20260321000000.

create or replace function public.club_role(p_club_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select m.role from public.memberships m
     where m.club_id = p_club_id and m.user_id = auth.uid()
     limit 1),
    'none'
  );
$$;
