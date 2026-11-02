import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/context/AuthContext';
import { useClub } from '@/context/ClubContext';
import { Button } from '@/components/ui/button';
import type { Player } from '@/integrations/supabase/types';
import { toast } from 'sonner';
import { describeError } from '@/lib/errors';

/**
 * After joining a club, let the member claim an unlinked roster row
 * or skip and stay as a member without a ladder identity.
 */
const ClaimPlayerPage: React.FC = () => {
  const { user } = useAuth();
  const { club } = useClub();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data: alreadyLinked } = useQuery({
    queryKey: ['my-player', club?.id, user?.id],
    enabled: !!club?.id && !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('players')
        .select('id')
        .eq('club_id', club!.id)
        .eq('user_id', user!.id)
        .is('archived_at', null)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const { data: unclaimed = [], isLoading } = useQuery({
    queryKey: ['unclaimed-players', club?.id],
    enabled: !!club?.id && !alreadyLinked,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('players')
        .select('*')
        .eq('club_id', club!.id)
        .is('user_id', null)
        .is('archived_at', null)
        .eq('is_guest', false)
        .order('name');
      if (error) throw error;
      return (data || []) as Player[];
    },
  });

  useEffect(() => {
    if (alreadyLinked) {
      navigate('/app', { replace: true });
    }
  }, [alreadyLinked, navigate]);

  const claim = async (playerId: string) => {
    setBusyId(playerId);
    const { error } = await supabase.rpc('link_player_to_user', {
      p_player_id: playerId,
    });
    setBusyId(null);
    if (error) {
      toast.error(describeError(error));
      return;
    }
    queryClient.invalidateQueries({ queryKey: ['players'] });
    toast.success('Roster linked to your account');
    navigate('/app');
  };

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="font-display text-3xl font-bold text-ink">Claim your spot</h1>
        <p className="text-muted-foreground">
          If you’re already on the club roster, pick your name. Or skip and stay as a member
          without a ladder row.
        </p>
      </div>

      <div className="surface-panel p-5">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading roster…</p>
        ) : unclaimed.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No unclaimed players. Ask a coach to add you on the roster, then claim from your
            profile.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {unclaimed.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-medium">{p.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Doubles {p.doubles_rating} · Singles {p.rating}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => void claim(p.id)}
                  disabled={busyId === p.id}
                >
                  {busyId === p.id ? 'Linking…' : 'This is me'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Button variant="outline" className="w-full" onClick={() => navigate('/app')}>
        Skip for now
      </Button>
    </div>
  );
};

export default ClaimPlayerPage;
