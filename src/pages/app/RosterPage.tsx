import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useClub } from '@/context/ClubContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import EmptyState from '@/components/ui/EmptyState';
import type { Player } from '@/integrations/supabase/types';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { describeError } from '@/lib/errors';

const RosterPage: React.FC = () => {
  const { club } = useClub();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [asGuest, setAsGuest] = useState(false);
  const [open, setOpen] = useState(false);
  const [editPlayer, setEditPlayer] = useState<Player | null>(null);

  const { data: players = [], isLoading } = useQuery({
    queryKey: ['players', club?.id],
    enabled: !!club?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('players')
        .select('*')
        .eq('club_id', club!.id)
        .is('archived_at', null)
        .order('doubles_rating', { ascending: false });
      if (error) throw error;
      return data as Player[];
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!club) throw new Error('No club');
      if (editPlayer) {
        const { error } = await supabase.rpc('update_player_profile', {
          p_player_id: editPlayer.id,
          p_name: name.trim(),
          p_age: age ? Number(age) : null,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.rpc('create_player', {
          p_club_id: club.id,
          p_name: name.trim(),
          p_age: age ? Number(age) : null,
          p_is_guest: asGuest,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['players', club?.id] });
      toast.success(editPlayer ? 'Player updated' : asGuest ? 'Guest added' : 'Player added');
      setOpen(false);
      setName('');
      setAge('');
      setAsGuest(false);
      setEditPlayer(null);
    },
    onError: (e: unknown) => toast.error(describeError(e)),
  });

  const archiveMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!confirm('Archive this player? They leave the active roster but match history stays.')) {
        return false;
      }
      const { error } = await supabase.rpc('archive_player', { p_player_id: id });
      if (error) throw error;
      return true;
    },
    onSuccess: (ok) => {
      if (!ok) return;
      queryClient.invalidateQueries({ queryKey: ['players', club?.id] });
      toast.success('Player archived');
    },
    onError: (e: unknown) => toast.error(describeError(e)),
  });

  const promoteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc('promote_guest', { p_player_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['players', club?.id] });
      toast.success('Guest promoted to full roster');
    },
    onError: (e: unknown) => toast.error(describeError(e)),
  });

  const openCreate = () => {
    setEditPlayer(null);
    setName('');
    setAge('');
    setAsGuest(false);
    setOpen(true);
  };

  const openEdit = (p: Player) => {
    setEditPlayer(p);
    setName(p.name);
    setAge(p.age?.toString() || '');
    setAsGuest(false);
    setOpen(true);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-ink">Roster</h1>
          <p className="text-muted-foreground">Manage players for {club?.name}.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="h-11" onClick={openCreate}>
              Add player
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editPlayer ? 'Edit player' : 'Add player'}</DialogTitle>
            </DialogHeader>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                saveMutation.mutate();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="h-11"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="age">Age (optional)</Label>
                <Input
                  id="age"
                  type="number"
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  className="h-11"
                />
              </div>
              {!editPlayer && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={asGuest}
                    onChange={(e) => setAsGuest(e.target.checked)}
                  />
                  Guest only (hidden from public ladder until promoted)
                </label>
              )}
              <Button type="submit" className="w-full" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? 'Saving…' : 'Save'}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {!isLoading && players.length === 0 ? (
        <EmptyState
          title="Empty roster"
          description="Add players so you can balance sessions and log matches."
          actionLabel="Add player"
          onAction={openCreate}
        />
      ) : (
        <div className="surface-panel overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Player</th>
                <th className="px-4 py-3 font-medium">Doubles</th>
                <th className="hidden px-4 py-3 font-medium sm:table-cell">Singles</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">W–L (D)</th>
                <th className="px-4 py-3 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {players.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-3">
                    <Link to={`/app/roster/${p.id}`} className="font-medium hover:text-court">
                      {p.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {p.is_guest ? 'Guest' : 'Elo ladder'}
                      {p.user_id ? ' · linked' : ''}
                      <span className="sm:hidden">
                        {' '}
                        · S {p.rating}
                      </span>
                    </p>
                  </td>
                  <td className="px-4 py-3 font-display font-bold tabular-nums">
                    {p.doubles_rating}
                  </td>
                  <td className="hidden px-4 py-3 tabular-nums text-muted-foreground sm:table-cell">
                    {p.rating}
                  </td>
                  <td className="hidden px-4 py-3 tabular-nums md:table-cell">
                    {p.doubles_wins}–{Math.max(0, p.doubles_matches_played - p.doubles_wins)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {p.is_guest && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => promoteMutation.mutate(p.id)}
                        disabled={promoteMutation.isPending}
                      >
                        Promote
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => archiveMutation.mutate(p.id)}
                      disabled={archiveMutation.isPending}
                    >
                      Archive
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default RosterPage;
