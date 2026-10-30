-- Invite codes expire after 1 day (was 14 days)
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
  values (p_club_id, v_role, auth.uid(), now() + interval '1 day')
  returning * into v_invite;

  return v_invite;
end;
$$;
