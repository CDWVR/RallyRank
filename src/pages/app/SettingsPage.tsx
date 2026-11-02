import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/context/AuthContext';
import { useClub } from '@/context/ClubContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import InviteCodeReveal from '@/components/InviteCodeReveal';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from 'sonner';
import { downloadCsv, toCsv } from '@/lib/csv';
import type { Club, Invite, Membership, SessionTemplate } from '@/integrations/supabase/types';
import { describeError } from '@/lib/errors';

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

type MemberRow = Membership & {
  displayName: string;
  email?: string | null;
};

function profileDisplayName(profile: {
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
} | null | undefined): string | null {
  const full = [profile?.first_name, profile?.last_name]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(' ');
  if (full) return full;
  if (profile?.username?.trim()) return profile.username.trim();
  return null;
}

const SettingsPage: React.FC = () => {
  const { user } = useAuth();
  const { club, role, season, refreshClubs, refreshSeason } = useClub();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [seasonName, setSeasonName] = useState('');
  const [hardSeasonReset, setHardSeasonReset] = useState(true);
  const [templateName, setTemplateName] = useState('');
  const [templateCourts, setTemplateCourts] = useState('2');
  const [templateWeekday, setTemplateWeekday] = useState<string>('none');
  const [clubName, setClubName] = useState('');
  const [inviteRole, setInviteRole] = useState('coach');
  const [transferTo, setTransferTo] = useState('');
  const [revealOpen, setRevealOpen] = useState(false);
  const [revealed, setRevealed] = useState<{ code: string; role: string } | null>(
    null
  );

  useEffect(() => {
    if (club?.name) setClubName(club.name);
  }, [club?.name]);

  const { data: members = [] } = useQuery({
    queryKey: ['memberships', club?.id, user?.id],
    enabled: !!club?.id,
    queryFn: async (): Promise<MemberRow[]> => {
      const { data: memberships, error } = await supabase
        .from('memberships')
        .select('*')
        .eq('club_id', club!.id)
        .order('created_at', { ascending: true });
      if (error) throw error;

      const rows = (memberships || []) as Membership[];
      const userIds = [...new Set(rows.map((m) => m.user_id))];
      if (userIds.length === 0) return [];

      const { data: profiles, error: profileError } = await supabase
        .from('profiles')
        .select('id, username, first_name, last_name')
        .in('id', userIds);
      if (profileError) throw profileError;

      const byId = Object.fromEntries((profiles || []).map((p) => [p.id, p]));

      return rows.map((m) => {
        const profile = byId[m.user_id];
        const name = profileDisplayName(profile);
        const isSelf = user?.id === m.user_id;
        return {
          ...m,
          displayName:
            name ||
            (isSelf && user?.email ? user.email : null) ||
            'Unknown member',
          email: isSelf ? user?.email : null,
        };
      });
    },
  });

  const createInvite = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('create_invite', {
        p_club_id: club!.id,
        p_role: inviteRole,
      });
      if (error) throw error;
      return data as Invite;
    },
    onSuccess: (invite) => {
      setRevealed({ code: invite.code, role: invite.role });
      setRevealOpen(true);
      queryClient.invalidateQueries({ queryKey: ['invites', club?.id] });
    },
    onError: (e: unknown) => toast.error(describeError(e)),
  });

  const { data: openInvites = [] } = useQuery({
    queryKey: ['invites', club?.id],
    enabled: !!club?.id && (role === 'owner' || role === 'admin'),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('invites')
        .select('*')
        .eq('club_id', club!.id)
        .is('used_at', null)
        .is('revoked_at', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as Invite[];
    },
  });

  const revokeInvite = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc('revoke_invite', { p_invite_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invites', club?.id] });
      toast.success('Invite revoked');
    },
    onError: (e: unknown) => toast.error(describeError(e)),
  });

  const renameClub = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('rename_club', {
        p_club_id: club!.id,
        p_name: clubName.trim(),
      });
      if (error) throw error;
      return data as Club;
    },
    onSuccess: async () => {
      await refreshClubs();
      toast.success('Club renamed');
    },
    onError: (e: unknown) => toast.error(describeError(e)),
  });

  const exportData = async (kind: 'roster' | 'matches') => {
    if (!club) return;
    try {
      if (kind === 'roster') {
        const { data, error } = await supabase
          .from('players')
          .select(
            'name, rating, doubles_rating, wins, doubles_wins, matches_played, doubles_matches_played, is_guest, streak_count'
          )
          .eq('club_id', club.id)
          .is('archived_at', null)
          .order('doubles_rating', { ascending: false });
        if (error) throw error;
        const csv = toCsv(
          [
            'name',
            'doubles_rating',
            'rating',
            'doubles_wins',
            'doubles_matches_played',
            'wins',
            'matches_played',
            'is_guest',
            'streak',
          ],
          (data || []).map((p) => [
            p.name,
            p.doubles_rating,
            p.rating,
            p.doubles_wins,
            p.doubles_matches_played,
            p.wins,
            p.matches_played,
            p.is_guest ? 'yes' : 'no',
            p.streak_count ?? 0,
          ])
        );
        downloadCsv(`${club.slug || 'club'}-roster.csv`, csv);
      } else {
        const { data, error } = await supabase
          .from('matches')
          .select(
            `
            created_at, team1_score, team2_score, winner,
            team1_player1:players!team1_player1_id(name),
            team1_player2:players!team1_player2_id(name),
            team2_player1:players!team2_player1_id(name),
            team2_player2:players!team2_player2_id(name)
          `
          )
          .eq('club_id', club.id)
          .order('created_at', { ascending: false })
          .limit(500);
        if (error) throw error;
        const csv = toCsv(
          ['played_at', 'team_a', 'team_b', 'score', 'winner'],
          (data || []).map((m: {
            created_at: string;
            team1_score: number;
            team2_score: number;
            winner: string;
            team1_player1?: { name?: string } | null;
            team1_player2?: { name?: string } | null;
            team2_player1?: { name?: string } | null;
            team2_player2?: { name?: string } | null;
          }) => [
            m.created_at,
            [m.team1_player1?.name, m.team1_player2?.name].filter(Boolean).join(' / '),
            [m.team2_player1?.name, m.team2_player2?.name].filter(Boolean).join(' / '),
            `${m.team1_score}-${m.team2_score}`,
            m.winner,
          ])
        );
        downloadCsv(`${club.slug || 'club'}-matches.csv`, csv);
      }
      toast.success('Export downloaded');
    } catch (e) {
      toast.error(describeError(e, 'Export failed'));
    }
  };

  const canManageTemplates =
    role === 'owner' || role === 'admin' || role === 'coach';

  const { data: sessionTemplates = [] } = useQuery({
    queryKey: ['session_templates', club?.id],
    enabled: !!club?.id && canManageTemplates,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('session_templates')
        .select('*')
        .eq('club_id', club!.id)
        .order('name', { ascending: true });
      if (error) throw error;
      return (data || []) as SessionTemplate[];
    },
  });

  const addSessionTemplate = useMutation({
    mutationFn: async () => {
      const name = templateName.trim();
      if (!name) throw new Error('Template name is required');
      const { error } = await supabase.from('session_templates').insert({
        club_id: club!.id,
        name,
        court_count: Number(templateCourts),
        weekday: templateWeekday === 'none' ? null : Number(templateWeekday),
        created_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session_templates', club?.id] });
      toast.success('Session template added');
      setTemplateName('');
      setTemplateCourts('2');
      setTemplateWeekday('none');
    },
    onError: (e: unknown) => toast.error(describeError(e)),
  });

  const deleteSessionTemplate = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('session_templates').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session_templates', club?.id] });
      toast.success('Template removed');
    },
    onError: (e: unknown) => toast.error(describeError(e)),
  });

  const startSeason = useMutation({
    mutationFn: async () => {
      const msg = hardSeasonReset
        ? 'Start a new season? Hard reset sets singles, doubles, and pair ratings to 1000.'
        : 'Start a soft season? Ratings stay; match counters reset for singles and doubles.';
      if (!confirm(msg)) return false;
      const { error } = await supabase.rpc('start_season', {
        p_club_id: club!.id,
        p_name: seasonName.trim() || `Season ${new Date().getFullYear()}`,
        p_hard_reset: hardSeasonReset,
      });
      if (error) throw error;
      return true;
    },
    onSuccess: async (ok) => {
      if (!ok) return;
      await refreshSeason();
      queryClient.invalidateQueries({ queryKey: ['players'] });
      queryClient.invalidateQueries({ queryKey: ['matches'] });
      queryClient.invalidateQueries({ queryKey: ['pair-ratings'] });
      toast.success('New season started');
      setSeasonName('');
    },
    onError: (e: unknown) => toast.error(describeError(e)),
  });

  const rotateShare = useMutation({
    mutationFn: async () => {
      if (
        !confirm(
          'Rotate the public ladder link? The old link will stop working immediately.'
        )
      ) {
        return null;
      }
      const { data, error } = await supabase.rpc('rotate_share_token', {
        p_club_id: club!.id,
      });
      if (error) throw error;
      return data as Club;
    },
    onSuccess: async (data) => {
      if (!data) return;
      await refreshClubs();
      toast.success('Public ladder link rotated');
    },
    onError: (e: unknown) => toast.error(describeError(e)),
  });

  const leaveClub = useMutation({
    mutationFn: async () => {
      if (!confirm('Leave this club? You will need a new invite to rejoin.')) return false;
      const { error } = await supabase.rpc('leave_club', { p_club_id: club!.id });
      if (error) throw error;
      return true;
    },
    onSuccess: async (ok) => {
      if (!ok) return;
      await refreshClubs();
      toast.success('Left club');
      navigate('/onboarding');
    },
    onError: (e: unknown) => toast.error(describeError(e)),
  });

  const removeMember = useMutation({
    mutationFn: async (userId: string) => {
      if (!confirm('Remove this member from the club?')) return false;
      const { error } = await supabase.rpc('remove_member', {
        p_club_id: club!.id,
        p_user_id: userId,
      });
      if (error) throw error;
      return true;
    },
    onSuccess: (ok) => {
      if (!ok) return;
      queryClient.invalidateQueries({ queryKey: ['memberships', club?.id] });
      toast.success('Member removed');
    },
    onError: (e: unknown) => toast.error(describeError(e)),
  });

  const updateRole = useMutation({
    mutationFn: async ({ userId, nextRole }: { userId: string; nextRole: string }) => {
      const { error } = await supabase.rpc('update_member_role', {
        p_club_id: club!.id,
        p_user_id: userId,
        p_role: nextRole,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['memberships', club?.id] });
      toast.success('Role updated');
    },
    onError: (e: unknown) => toast.error(describeError(e)),
  });

  const transferOwnership = useMutation({
    mutationFn: async () => {
      if (!transferTo) throw new Error('Select a member');
      if (
        !confirm(
          'Transfer ownership? You will become an admin. This cannot be undone without the new owner.'
        )
      ) {
        return false;
      }
      const { error } = await supabase.rpc('transfer_ownership', {
        p_club_id: club!.id,
        p_new_owner_id: transferTo,
      });
      if (error) throw error;
      return true;
    },
    onSuccess: async (ok) => {
      if (!ok) return;
      await refreshClubs();
      queryClient.invalidateQueries({ queryKey: ['memberships', club?.id] });
      setTransferTo('');
      toast.success('Ownership transferred');
    },
    onError: (e: unknown) => toast.error(describeError(e)),
  });

  const shareUrl =
    typeof window !== 'undefined' && club?.share_token
      ? `${window.location.origin}${import.meta.env.BASE_URL}ladder/${club.share_token}`.replace(
          /([^:]\/)\/+/g,
          '$1'
        )
      : '';

  const copyShare = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    toast.success('Public ladder link copied');
  };

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="font-display text-3xl font-bold text-ink">Settings</h1>
        <p className="text-muted-foreground">Club members, invites, and seasons.</p>
      </div>

      <section className="surface-panel space-y-3 p-5">
        <h2 className="font-display text-lg font-bold">Club</h2>
        <p className="text-sm">
          <span className="text-muted-foreground">Your role:</span>{' '}
          <span className="capitalize">{role}</span>
        </p>
        <p className="text-sm">
          <span className="text-muted-foreground">Active season:</span> {season?.name || '—'}
        </p>
        {(role === 'owner' || role === 'admin') && (
          <div className="space-y-2 pt-1">
            <Label htmlFor="club-name">Club name</Label>
            <div className="flex gap-2">
              <Input
                id="club-name"
                value={clubName}
                onChange={(e) => setClubName(e.target.value)}
                className="h-11"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => renameClub.mutate()}
                disabled={renameClub.isPending || clubName.trim() === club?.name}
              >
                {renameClub.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        )}
        {!(role === 'owner' || role === 'admin') && (
          <p className="text-sm">
            <span className="text-muted-foreground">Name:</span> {club?.name}
          </p>
        )}
        {shareUrl && (
          <div className="space-y-2 pt-2">
            <Label>Public ladder link</Label>
            <div className="flex gap-2">
              <Input readOnly value={shareUrl} className="h-11 text-xs" />
              <Button type="button" onClick={copyShare}>
                Copy
              </Button>
            </div>
            {(role === 'owner' || role === 'admin') && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => rotateShare.mutate()}
                disabled={rotateShare.isPending}
              >
                {rotateShare.isPending ? 'Rotating…' : 'Rotate link'}
              </Button>
            )}
          </div>
        )}
        <div className="pt-2">
          <Button
            type="button"
            variant="ghost"
            className="text-destructive"
            onClick={() => leaveClub.mutate()}
            disabled={leaveClub.isPending}
          >
            Leave club
          </Button>
        </div>
      </section>

      {role === 'owner' && (
        <section className="surface-panel space-y-4 p-5">
          <div>
            <h2 className="font-display text-lg font-bold">Transfer ownership</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Make another member the owner. You become an admin and can then leave if you want.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={transferTo || undefined} onValueChange={setTransferTo}>
              <SelectTrigger className="h-11 w-[14rem]">
                <SelectValue placeholder="New owner" />
              </SelectTrigger>
              <SelectContent>
                {members
                  .filter((m) => m.user_id !== user?.id)
                  .map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.displayName}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => transferOwnership.mutate()}
              disabled={!transferTo || transferOwnership.isPending}
            >
              {transferOwnership.isPending ? 'Transferring…' : 'Transfer'}
            </Button>
          </div>
        </section>
      )}

      <section className="surface-panel space-y-3 p-5">
        <h2 className="font-display text-lg font-bold">Members</h2>
        <ul className="divide-y divide-border">
          {members.map((m) => {
            const isSelf = user?.id === m.user_id;
            return (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">
                    {m.displayName}
                    {isSelf ? (
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>
                    ) : null}
                  </p>
                  {m.email && isSelf ? (
                    <p className="truncate text-xs text-muted-foreground">{m.email}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {role === 'owner' && !isSelf && m.role !== 'owner' ? (
                    <Select
                      value={m.role}
                      onValueChange={(nextRole) =>
                        updateRole.mutate({ userId: m.user_id, nextRole })
                      }
                    >
                      <SelectTrigger className="h-9 w-[7.5rem]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="coach">Coach</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="capitalize text-muted-foreground">{m.role}</span>
                  )}
                  {(role === 'owner' || role === 'admin') &&
                    !isSelf &&
                    m.role !== 'owner' && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => removeMember.mutate(m.user_id)}
                        disabled={removeMember.isPending}
                      >
                        Remove
                      </Button>
                    )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {(role === 'owner' || role === 'admin') && (
        <>
          <section className="surface-panel space-y-4 p-5">
            <div>
              <h2 className="font-display text-lg font-bold">Invites</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Create a code (shown once), or revoke unused open invites. Codes expire in 24 hours.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Select value={inviteRole} onValueChange={setInviteRole}>
                <SelectTrigger className="h-11 w-[9rem]">
                  <SelectValue placeholder="Role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="coach">Coach</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
              <Button onClick={() => createInvite.mutate()} disabled={createInvite.isPending}>
                {createInvite.isPending ? 'Creating…' : 'Create invite'}
              </Button>
            </div>
            {openInvites.length > 0 && (
              <ul className="divide-y divide-border rounded-md border border-border">
                {openInvites.map((inv) => (
                  <li
                    key={inv.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <div>
                      <p className="font-mono font-semibold">{inv.code}</p>
                      <p className="text-xs text-muted-foreground">
                        {inv.role}
                        {inv.expires_at
                          ? ` · expires ${new Date(inv.expires_at).toLocaleString()}`
                          : ''}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => revokeInvite.mutate(inv.id)}
                      disabled={revokeInvite.isPending}
                    >
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="surface-panel space-y-4 p-5">
            <h2 className="font-display text-lg font-bold">Export</h2>
            <p className="text-sm text-muted-foreground">
              Download CSV for WhatsApp / sheets people.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void exportData('roster')}>
                Export roster
              </Button>
              <Button type="button" variant="outline" onClick={() => void exportData('matches')}>
                Export matches
              </Button>
            </div>
          </section>

          <section className="surface-panel space-y-4 p-5">
            <h2 className="font-display text-lg font-bold">New season</h2>
            <p className="text-sm text-muted-foreground">
              Starts a new ladder season. Match history is kept. Choose hard reset (ratings →
              1000) or soft reset (keep Elo, clear season W-L and streaks).
            </p>
            <div className="space-y-2">
              <Label htmlFor="season">Season name</Label>
              <Input
                id="season"
                value={seasonName}
                onChange={(e) => setSeasonName(e.target.value)}
                placeholder="Spring 2026"
                className="h-11"
              />
            </div>
            <div className="flex items-start gap-3">
              <Checkbox
                id="hard-season-reset"
                checked={hardSeasonReset}
                onCheckedChange={(v) => setHardSeasonReset(v === true)}
              />
              <div className="space-y-1 leading-none">
                <Label htmlFor="hard-season-reset" className="cursor-pointer font-medium">
                  Hard reset ratings to 1000
                </Label>
                <p className="text-xs text-muted-foreground">
                  Off = soft reset: keep singles/doubles/pair Elo, reset season stats only.
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              onClick={() => startSeason.mutate()}
              disabled={startSeason.isPending}
            >
              Start season
            </Button>
          </section>
        </>
      )}

      {canManageTemplates && (
        <section className="surface-panel space-y-4 p-5">
          <div>
            <h2 className="font-display text-lg font-bold">Session templates</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Saved court counts for recurring nights. Apply a template on the Session page.
            </p>
          </div>
          {sessionTemplates.length > 0 && (
            <ul className="divide-y divide-border rounded-md border border-border">
              {sessionTemplates.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <div>
                    <p className="font-medium">{t.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t.court_count} court{t.court_count === 1 ? '' : 's'}
                      {t.weekday != null
                        ? ` · ${WEEKDAY_LABELS[t.weekday] ?? t.weekday}`
                        : ''}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => deleteSessionTemplate.mutate(t.id)}
                    disabled={deleteSessionTemplate.isPending}
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[10rem] flex-1 space-y-2">
              <Label htmlFor="template-name">Name</Label>
              <Input
                id="template-name"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="Tuesday league"
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <Label>Courts</Label>
              <Select value={templateCourts} onValueChange={setTemplateCourts}>
                <SelectTrigger className="h-11 w-[5.5rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Weekday (optional)</Label>
              <Select value={templateWeekday} onValueChange={setTemplateWeekday}>
                <SelectTrigger className="h-11 w-[8rem]">
                  <SelectValue placeholder="Any" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Any day</SelectItem>
                  {WEEKDAY_LABELS.map((label, i) => (
                    <SelectItem key={label} value={String(i)}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              onClick={() => addSessionTemplate.mutate()}
              disabled={addSessionTemplate.isPending || !templateName.trim()}
            >
              {addSessionTemplate.isPending ? 'Adding…' : 'Add template'}
            </Button>
          </div>
        </section>
      )}

      <InviteCodeReveal
        code={revealed?.code ?? null}
        role={revealed?.role}
        open={revealOpen}
        onOpenChange={(next) => {
          setRevealOpen(next);
          if (!next) setRevealed(null);
        }}
      />
    </div>
  );
};

export default SettingsPage;
