import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/context/AuthContext';
import { useClub } from '@/context/ClubContext';
import type { Player } from '@/integrations/supabase/types';
import { Button } from '@/components/ui/button';
import { overallWinRate } from '@/lib/ladderStats';
import { toast } from 'sonner';

const PlayerProfilePage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const { club, season, role } = useClub();
  const queryClient = useQueryClient();

  const { data: player } = useQuery({
    queryKey: ['player', id],
    enabled: !!id && !!club?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('players')
        .select('*')
        .eq('id', id!)
        .eq('club_id', club!.id)
        .single();
      if (error) throw error;
      return data as Player;
    },
  });

  const { data: history = [] } = useQuery({
    queryKey: ['player-history', id, season?.id],
    enabled: !!id && !!club?.id,
    queryFn: async () => {
      let q = supabase
        .from('match_history')
        .select('date, rating_after, rating_change, is_winner, match_id, rating_format')
        .eq('player_id', id!)
        .eq('club_id', club!.id)
        .order('date', { ascending: true });

      if (season?.id) {
        const { data: seasonMatches } = await supabase
          .from('matches')
          .select('id')
          .eq('club_id', club!.id)
          .eq('season_id', season.id);
        const ids = (seasonMatches || []).map((m) => m.id);
        if (ids.length === 0) return [];
        q = q.in('match_id', ids);
      }

      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },
  });

  const linkMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('link_player_to_user', { p_player_id: id! });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['player', id] });
      queryClient.invalidateQueries({ queryKey: ['players'] });
      toast.success('Linked to your account');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const unlinkMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('unlink_player', { p_player_id: id! });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['player', id] });
      queryClient.invalidateQueries({ queryKey: ['players'] });
      toast.success('Unlinked');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!player) {
    return <p className="text-muted-foreground">Loading player…</p>;
  }

  const winRate = overallWinRate(player);

  const chartData = history.map((h, i) => ({
    i: i + 1,
    rating: h.rating_after,
    format: h.rating_format,
    label: new Date(h.date).toLocaleDateString(),
  }));

  const isLinkedToMe = Boolean(player.user_id && user?.id === player.user_id);
  const canClaim = !player.user_id;
  const canUnlink = Boolean(
    isLinkedToMe || (player.user_id && (role === 'owner' || role === 'admin'))
  );

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" className="-ml-2">
        <Link to="/app/roster">← Roster</Link>
      </Button>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-ink">{player.name}</h1>
          <p className="text-muted-foreground">
            {player.doubles_matches_played} doubles · {player.matches_played} singles
            {isLinkedToMe ? ' · linked to you' : player.user_id ? ' · linked' : ''}
          </p>
        </div>
        <div className="flex gap-6 text-right">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Doubles</p>
            <p className="font-display text-5xl font-bold tabular-nums text-court">
              {player.doubles_rating}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Singles</p>
            <p className="font-display text-3xl font-bold tabular-nums text-ink">
              {player.rating}
            </p>
          </div>
        </div>
      </div>

      {(canClaim || canUnlink) && (
        <div className="flex flex-wrap gap-2">
          {canClaim && (
            <Button
              variant="outline"
              onClick={() => linkMutation.mutate()}
              disabled={linkMutation.isPending}
            >
              {linkMutation.isPending ? 'Linking…' : 'This is me — link account'}
            </Button>
          )}
          {canUnlink && (
            <Button
              variant="ghost"
              onClick={() => unlinkMutation.mutate()}
              disabled={unlinkMutation.isPending}
            >
              Unlink
            </Button>
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-4">
        <div className="surface-panel p-4">
          <p className="text-xs uppercase text-muted-foreground">Doubles W–L</p>
          <p className="font-display text-2xl font-bold">
            {player.doubles_wins}–{Math.max(0, player.doubles_matches_played - player.doubles_wins)}
          </p>
        </div>
        <div className="surface-panel p-4">
          <p className="text-xs uppercase text-muted-foreground">Singles W–L</p>
          <p className="font-display text-2xl font-bold">
            {player.wins}–{Math.max(0, player.matches_played - player.wins)}
          </p>
        </div>
        <div className="surface-panel p-4">
          <p className="text-xs uppercase text-muted-foreground">Win rate</p>
          <p className="font-display text-2xl font-bold">
            {winRate != null ? `${winRate}%` : '—'}
          </p>
        </div>
        <div className="surface-panel p-4">
          <p className="text-xs uppercase text-muted-foreground">Doubles streak</p>
          <p className="font-display text-2xl font-bold">{player.doubles_streak_count || 0}</p>
        </div>
      </div>

      <section className="surface-panel p-5">
        <h2 className="mb-4 font-display text-lg font-bold">
          Rating history{season?.name ? ` · ${season.name}` : ''}
        </h2>
        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground">No rated matches yet.</p>
        ) : (
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(150 12% 86%)" />
                <XAxis dataKey="i" tick={{ fontSize: 12 }} />
                <YAxis domain={['auto', 'auto']} tick={{ fontSize: 12 }} />
                <Tooltip
                  formatter={(v: number, _name, item) => {
                    const fmt = item?.payload?.format;
                    const label =
                      fmt === 'doubles' ? 'Doubles' : fmt === 'singles' ? 'Singles' : 'Rating';
                    return [v, label];
                  }}
                  labelFormatter={(_, payload) =>
                    payload?.[0]?.payload?.label || ''
                  }
                />
                <Line
                  type="monotone"
                  dataKey="rating"
                  stroke="hsl(152 55% 28%)"
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>
    </div>
  );
};

export default PlayerProfilePage;
