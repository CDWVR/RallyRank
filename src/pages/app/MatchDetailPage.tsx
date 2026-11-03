import React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useClub } from '@/context/ClubContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Match } from '@/integrations/supabase/types';
import { toast } from 'sonner';
import { describeError } from '@/lib/errors';

const MatchDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { club, role } = useClub();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: match } = useQuery({
    queryKey: ['match', id],
    enabled: !!id && !!club?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('matches')
        .select(
          `
          *,
          team1_player1:players!team1_player1_id(id, name, rating),
          team1_player2:players!team1_player2_id(id, name, rating),
          team2_player1:players!team2_player1_id(id, name, rating),
          team2_player2:players!team2_player2_id(id, name, rating)
        `
        )
        .eq('id', id!)
        .eq('club_id', club!.id)
        .single();
      if (error) throw error;
      return data as Match & {
        team1_player1: { id: string; name: string; rating: number } | null;
        team1_player2: { id: string; name: string; rating: number } | null;
        team2_player1: { id: string; name: string; rating: number } | null;
        team2_player2: { id: string; name: string; rating: number } | null;
      };
    },
  });

  const { data: events = [] } = useQuery({
    queryKey: ['match-events', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('match_history')
        .select('*, players(name)')
        .eq('match_id', id!);
      if (error) throw error;
      return data || [];
    },
  });

  const { data: isLatest } = useQuery({
    queryKey: ['match-is-latest', club?.id, id],
    enabled: !!club?.id && !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('matches')
        .select('id')
        .eq('club_id', club!.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data?.id === id;
    },
  });

  const undoMutation = useMutation({
    mutationFn: async () => {
      if (
        !confirm(
          'Undo this match? Ratings will be restored from the recorded rating events. Only the most recent club match can be undone.'
        )
      ) {
        return false;
      }
      const { error } = await supabase.rpc('undo_match', { p_match_id: id! });
      if (error) throw error;
      return true;
    },
    onSuccess: (ok) => {
      if (!ok) return;
      queryClient.invalidateQueries({ queryKey: ['matches'] });
      queryClient.invalidateQueries({ queryKey: ['players'] });
      queryClient.invalidateQueries({ queryKey: ['match'] });
      queryClient.invalidateQueries({ queryKey: ['pair-ratings'] });
      toast.success('Match undone — ratings restored');
      navigate('/app/matches');
    },
    onError: (e: unknown) => toast.error(describeError(e)),
  });

  const disputeMutation = useMutation({
    mutationFn: async (disputed: boolean) => {
      const { data, error } = await supabase.rpc('set_match_disputed', {
        p_match_id: id!,
        p_disputed: disputed,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_data, disputed) => {
      queryClient.invalidateQueries({ queryKey: ['match', id] });
      queryClient.invalidateQueries({ queryKey: ['matches'] });
      toast.success(disputed ? 'Match marked as disputed' : 'Dispute flag cleared');
    },
    onError: (e: unknown) => toast.error(describeError(e)),
  });

  if (!match) return <p className="text-muted-foreground">Loading…</p>;

  const t1 = [match.team1_player1, match.team1_player2].filter(Boolean);
  const t2 = [match.team2_player1, match.team2_player2].filter(Boolean);
  const canManage =
    role === 'owner' || role === 'admin' || role === 'coach';
  const canUndo = canManage && isLatest;

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <Button asChild variant="ghost" className="-ml-2">
        <Link to="/app/matches">← Matches</Link>
      </Button>

      <div className="surface-panel p-6 text-center">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <p className="text-sm text-muted-foreground">
            {new Date(match.created_at).toLocaleString()}
          </p>
          {match.is_disputed && (
            <Badge variant="secondary">Disputed — no Elo change</Badge>
          )}
        </div>
        <p className="mt-4 font-display text-5xl font-bold tabular-nums">
          {match.team1_score}–{match.team2_score}
        </p>
        <div className="mt-6 grid grid-cols-2 gap-4 text-left">
          <div>
            <p className="text-xs uppercase text-muted-foreground">Team A</p>
            {t1.map((p: { id: string; name: string }) => (
              <p key={p.id} className="font-medium">
                {p.name}
              </p>
            ))}
          </div>
          <div>
            <p className="text-xs uppercase text-muted-foreground">Team B</p>
            {t2.map((p: { id: string; name: string }) => (
              <p key={p.id} className="font-medium">
                {p.name}
              </p>
            ))}
          </div>
        </div>
        {match.session_note && (
          <div className="mt-6 rounded-md border border-border bg-muted/30 px-4 py-3 text-left text-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Session note
            </p>
            <p className="mt-1 whitespace-pre-wrap text-ink">{match.session_note}</p>
          </div>
        )}
      </div>

      <section className="surface-panel p-5">
        <h2 className="mb-3 font-display text-lg font-bold">Rating events</h2>
        <ul className="divide-y divide-border">
          {events.map(
            (e: {
              id: string;
              players?: { name?: string };
              rating_before: number;
              rating_after: number;
              rating_change: number;
              rating_format?: string;
            }) => {
              const formatLabel =
                e.rating_format === 'doubles'
                  ? 'Doubles Elo'
                  : e.rating_format === 'singles'
                    ? 'Singles Elo'
                    : null;
              return (
                <li key={e.id} className="flex justify-between gap-3 py-2 text-sm">
                  <span>
                    {e.players?.name || 'Player'}
                    {formatLabel ? (
                      <span className="ml-1.5 text-xs text-muted-foreground">{formatLabel}</span>
                    ) : null}
                  </span>
                  <span className="font-mono shrink-0">
                    {e.rating_before} → {e.rating_after} ({e.rating_change >= 0 ? '+' : ''}
                    {e.rating_change})
                  </span>
                </li>
              );
            }
          )}
        </ul>
      </section>

      {canManage && (
        <div className="surface-panel space-y-2 p-5">
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={disputeMutation.isPending}
            onClick={() => disputeMutation.mutate(!match.is_disputed)}
          >
            {disputeMutation.isPending
              ? 'Updating…'
              : match.is_disputed
                ? 'Clear dispute flag'
                : 'Mark as disputed'}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Updates the disputed flag only. To reverse ratings, use undo on the latest match.
          </p>
        </div>
      )}

      {canUndo && (
        <div className="space-y-2">
          <Button
            variant="destructive"
            className="w-full"
            onClick={() => undoMutation.mutate()}
            disabled={undoMutation.isPending}
          >
            {undoMutation.isPending ? 'Undoing…' : 'Undo match (restore ratings)'}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Only the club’s most recent match can be undone so the ladder stays consistent.
          </p>
        </div>
      )}

      {canManage && isLatest === false && (
        <p className="text-center text-sm text-muted-foreground">
          Older matches can’t be undone. Undo newer matches first, or start a new season.
        </p>
      )}
    </div>
  );
};

export default MatchDetailPage;
