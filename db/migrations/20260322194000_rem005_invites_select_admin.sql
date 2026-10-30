-- REM-005: Restrict invite listing to owner/admin (not all club members).
--
-- ROLLBACK:
--   drop policy if exists invites_select on public.invites;
--   create policy invites_select on public.invites for select using (
--     public.is_club_member(club_id)
--   );

drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites for select using (
  public.club_role(club_id) in ('owner', 'admin')
);
