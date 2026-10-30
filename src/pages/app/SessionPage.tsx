import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useClub } from '@/context/ClubContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import EmptyState from '@/components/ui/EmptyState';
import type { Player, SessionTemplate } from '@/integrations/supabase/types';
import { balanceTeams, teamRating, winChance } from '@/lib/teamBalance';
import { saveSessionTeamsPrefill, SESSION_ATTENDEES_KEY } from '@/lib/sessionPrefill';
import { buildSessionSummary, type SessionSummary } from '@/lib/sessionSummary';

import {
  emptyCourts,
  parseCourts,
  serializeCourts,
  waitingPlayerIds,
  type CourtSlot,
} from '@/lib/courtBoard';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

type ClubSession = {
  id: string;
  club_id: string;
  court_count: number;
  status: string;
  attendee_ids: string[];
  team_a_ids: string[];
  team_b_ids: string[];
  courts?: unknown;
  created_at: string;
};

const SessionPage: React.FC = () => {
  const { club } = useClub();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const [courtCount, setCourtCount] = useState(1);
  const [courts, setCourts] = useState<CourtSlot[]>(() => emptyCourts(1));
  const [hydrated, setHydrated] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [appliedTemplateId, setAppliedTemplateId] = useState<string>('');
  const trackedSessionId = useRef<string | null>(null);

  const { data: sessionTemplates = [] } = useQuery({
    queryKey: ['session_templates', club?.id],
    enabled: !!club?.id,
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

  const { data: players = [], isLoading } = useQuery({
    queryKey: ['players', club?.id],
    enabled: !!club?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('players')
        .select('*')
        .eq('club_id', club!.id)
        .is('archived_at', null)
        .order('name');
      if (error) throw error;
      return data as Player[];
    },
  });

  const playerMap = useMemo(
    () => Object.fromEntries(players.map((p) => [p.id, p])),
    [players]
  );

  const { data: session } = useQuery({
    queryKey: ['club-session', club?.id],
    enabled: !!club?.id,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_or_open_session', {
        p_club_id: club!.id,
      });
      if (error) throw error;
      return data as ClubSession;
    },
  });


  useEffect(() => {
    setHydrated(false);
    setSelected([]);
    setCourts(emptyCourts(1));
    setCourtCount(1);
    setAppliedTemplateId('');
  }, [club?.id]);

  useEffect(() => {
    if (!club?.id || !session || hydrated) return;

    if (session.attendee_ids?.length) {
      setSelected(session.attendee_ids);
    } else {
      const raw = localStorage.getItem(`${SESSION_ATTENDEES_KEY}.${club.id}`);
      if (raw) {
        try {
          setSelected(JSON.parse(raw));
        } catch {
          /* ignore */
        }
      }
    }

    const count = session.court_count || 1;
    setCourtCount(count);

    let nextCourts = parseCourts(session.courts, count);
    if (
      nextCourts.every((c) => !c.teamA.length && !c.teamB.length) &&
      (session.team_a_ids?.length || session.team_b_ids?.length)
    ) {
      nextCourts = emptyCourts(count);
      nextCourts[0] = {
        teamA: session.team_a_ids || [],
        teamB: session.team_b_ids || [],
        status: 'playing',
      };
    }
    setCourts(nextCourts);
    setHydrated(true);
  }, [club?.id, session, hydrated]);

  useEffect(() => {
    if (!club?.id) return;
    localStorage.setItem(`${SESSION_ATTENDEES_KEY}.${club.id}`, JSON.stringify(selected));
  }, [selected, club?.id]);

  const persist = useCallback(
    async (next: {
      selected?: string[];
      courts?: CourtSlot[];
      courtsCount?: number;
    }) => {
      if (!session?.id) return;
      const nextCourts = next.courts ?? courts;
      const primary = nextCourts[0] || { teamA: [], teamB: [] };
      const { error } = await supabase.rpc('save_session_state', {
        p_session_id: session.id,
        p_attendee_ids: next.selected ?? selected,
        p_team_a_ids: primary.teamA,
        p_team_b_ids: primary.teamB,
        p_court_count: next.courtsCount ?? courtCount,
        p_courts: serializeCourts(nextCourts),
      });
      if (error) {
        console.error(error);
        toast.error(error.message || 'Failed to save session');
      } else queryClient.invalidateQueries({ queryKey: ['club-session', club?.id] });
    },
    [session?.id, selected, courts, courtCount, queryClient, club?.id]
  );

  const applyCourtTemplate = useCallback(
    (templateId: string) => {
      setAppliedTemplateId(templateId);
      if (!templateId) return;
      const template = sessionTemplates.find((t) => t.id === templateId);
      if (!template) return;
      const n = template.court_count;
      setCourtCount(n);
      const next = parseCourts(serializeCourts(courts), n);
      setCourts(next);
      void persist({ courts: next, courtsCount: n });
    },
    [sessionTemplates, courts, persist]
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      const cleared = emptyCourts(courtCount);
      setCourts(cleared);
      void persist({ selected: next, courts: cleared });
      return next;
    });
  };

  const attendees = useMemo(
    () => players.filter((p) => selected.includes(p.id)),
    [players, selected]
  );

  const waiting = useMemo(
    () => waitingPlayerIds(selected, courts).map((id) => playerMap[id]).filter(Boolean),
    [selected, courts, playerMap]
  );

  const assignCourt = (index: number, pool: Player[]) => {
    if (pool.length < 2) {
      toast.error('Need at least 2 players to fill a court');
      return;
    }
    const balanced = balanceTeams(pool);
    const next = courts.map((c, i) =>
      i === index
        ? {
            teamA: balanced.teamA.map((p) => p.id),
            teamB: balanced.teamB.map((p) => p.id),
            status: 'playing' as const,
          }
        : c
    );
    setCourts(next);
    if (club?.id && index === 0) {
      saveSessionTeamsPrefill(club.id, {
        teamA: balanced.teamA.map((p) => p.id),
        teamB: balanced.teamB.map((p) => p.id),
      });
    }
    void persist({ courts: next });
  };

  const clearCourt = (index: number) => {
    const next = courts.map((c, i) =>
      i === index ? { teamA: [], teamB: [], status: 'open' as const } : c
    );
    setCourts(next);
    void persist({ courts: next });
  };

  const runBalanceCourt1 = () => {
    if (attendees.length < 2) return;
    assignCourt(0, attendees);
  };

  const fillNextOpenCourt = () => {
    const openIdx = courts.findIndex((c) => c.status === 'open' || (!c.teamA.length && !c.teamB.length));
    if (openIdx < 0) {
      toast.message('All courts are filled — clear one first');
      return;
    }
    assignCourt(openIdx, waiting);
  };

  const loadSummary = async () => {
    if (!session?.id || !club?.id) return;
    setSummaryLoading(true);
    try {
      const { data: sessionMatches, error: matchError } = await supabase
        .from('matches')
        .select('id')
        .eq('club_id', club.id)
        .eq('session_id', session.id);
      if (matchError) throw matchError;

      let matches = sessionMatches;

      // Fallback for matches logged before session_id existed
      if (!matches?.length) {
        const fallback = await supabase
          .from('matches')
          .select('id')
          .eq('club_id', club.id)
          .gte('created_at', session.created_at);
        if (fallback.error) throw fallback.error;
        matches = fallback.data;
      }

      const matchIds = (matches || []).map((m) => m.id);
      let history: {
        player_id: string | null;
        rating_change: number;
        is_winner: boolean;
        players?: { name?: string | null } | null;
      }[] = [];

      if (matchIds.length > 0) {
        const { data: rows, error: histError } = await supabase
          .from('match_history')
          .select('player_id, rating_change, is_winner, players(name)')
          .in('match_id', matchIds);
        if (histError) throw histError;
        history = rows || [];
      }

      setSummary(
        buildSessionSummary({
          startedAt: session.created_at,
          attendeeCount: selected.length || session.attendee_ids?.length || 0,
          matchCount: matchIds.length,
          history,
        })
      );
      setSummaryOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not build summary');
    } finally {
      setSummaryLoading(false);
    }
  };

  const addGuest = useMutation({
    mutationFn: async () => {
      if (!club) throw new Error('No club');
      const trimmed = guestName.trim();
      if (!trimmed) throw new Error('Enter a guest name');
      const { data, error } = await supabase.rpc('create_player', {
        p_club_id: club.id,
        p_name: trimmed,
        p_age: null,
        p_is_guest: true,
      });
      if (error) throw error;
      return data as Player;
    },
    onSuccess: (guest) => {
      queryClient.invalidateQueries({ queryKey: ['players', club?.id] });
      setSelected((prev) => {
        const next = [...prev, guest.id];
        void persist({ selected: next });
        return next;
      });
      setGuestName('');
      toast.success(`${guest.name} added as guest`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const closeMutation = useMutation({
    mutationFn: async () => {
      if (!session?.id) throw new Error('No session');
      const { error } = await supabase.rpc('close_session', { p_session_id: session.id });
      if (error) throw error;
    },
    onSuccess: () => {
      setSummaryOpen(false);
      setSummary(null);
      setSelected([]);
      setCourts(emptyCourts(1));
      setCourtCount(1);
      setHydrated(false);
      if (club?.id) {
        localStorage.removeItem(`${SESSION_ATTENDEES_KEY}.${club.id}`);
      }
      queryClient.invalidateQueries({ queryKey: ['club-session', club?.id] });
      queryClient.invalidateQueries({ queryKey: ['players'] });
      toast.success('Session closed');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!isLoading && players.length === 0) {
    return (
      <EmptyState
        title="No players yet"
        description="Add players to the roster before balancing a session."
        actionLabel="Add players"
        actionTo="/app/roster"
      />
    );
  }

  const primary = courts[0];
  const hasPrimary =
    Boolean(primary?.teamA.length || primary?.teamB.length);
  const rematchQs = hasPrimary
    ? `from=session&session=${session?.id || ''}`
    : '';
  const topMovers = summary?.movers.slice(0, 8) ?? [];
  const durationLabel = summary ? new Date(summary.startedAt).toLocaleString() : '';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold text-ink">Session</h1>
          <p className="text-muted-foreground">
            Attendance, courts, and tonight’s matches in one place.
          </p>
        </div>
        {session && (
          <Button
            variant="outline"
            className="h-11"
            onClick={() => void loadSummary()}
            disabled={summaryLoading}
          >
            {summaryLoading ? 'Summarizing…' : 'Close session'}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {sessionTemplates.length > 0 && (
          <div className="flex items-center gap-2">
            <label htmlFor="session-template" className="text-sm font-medium">
              Template
            </label>
            <Select
              value={appliedTemplateId || undefined}
              onValueChange={applyCourtTemplate}
            >
              <SelectTrigger id="session-template" className="h-11 w-[11rem]">
                <SelectValue placeholder="Apply template" />
              </SelectTrigger>
              <SelectContent>
                {sessionTemplates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} ({t.court_count}c)
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="flex items-center gap-2">
          <label htmlFor="court-count" className="text-sm font-medium">
            Courts
          </label>
          <Select
            value={String(courtCount)}
            onValueChange={(v) => {
              const n = Number(v);
              setCourtCount(n);
              setAppliedTemplateId('');
              const next = parseCourts(serializeCourts(courts), n);
              setCourts(next);
              void persist({ courts: next, courtsCount: n });
            }}
          >
            <SelectTrigger id="court-count" className="h-11 w-[5.5rem]">
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
        <Button onClick={runBalanceCourt1} disabled={attendees.length < 2} className="h-11">
          Balance court 1 ({attendees.length})
        </Button>
        {courtCount > 1 && (
          <Button
            variant="outline"
            className="h-11"
            onClick={fillNextOpenCourt}
            disabled={waiting.length < 2}
          >
            Fill next court ({waiting.length} waiting)
          </Button>
        )}
        <Button asChild variant="outline" className="h-11" disabled={!hasPrimary}>
          <Link to={`/app/matches/new?${rematchQs}`}>Log this match</Link>
        </Button>
        {hasPrimary && (
          <Button asChild variant="ghost" className="h-11" disabled={!hasPrimary}>
            <Link to={`/app/matches/new?${rematchQs}`}>Rematch same teams</Link>
          </Button>
        )}
      </div>

      <section className="surface-panel p-4">
        <h2 className="mb-3 font-display text-lg font-bold">Attendance</h2>
        <div className="mb-3 flex flex-wrap gap-2">
          <Input
            value={guestName}
            onChange={(e) => setGuestName(e.target.value)}
            placeholder="Guest name"
            className="h-11 max-w-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addGuest.mutate();
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={() => addGuest.mutate()}
            disabled={addGuest.isPending || !guestName.trim()}
          >
            {addGuest.isPending ? 'Adding…' : 'Add guest'}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {players.map((p) => {
            const on = selected.includes(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => toggle(p.id)}
                className={cn(
                  'touch-target rounded-full border px-4 py-2 text-sm font-medium transition-colors',
                  on
                    ? 'border-court bg-court text-white'
                    : 'border-border bg-background text-foreground hover:border-court/50'
                )}
              >
                {p.name}
                {p.is_guest ? (
                  <span className="ml-1 text-[10px] uppercase opacity-80">guest</span>
                ) : null}
                <span className="ml-2 opacity-70">{p.doubles_rating}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-display text-lg font-bold">Court board</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {courts.map((court, idx) => {
            const teamA = court.teamA.map((id) => playerMap[id]).filter(Boolean);
            const teamB = court.teamB.map((id) => playerMap[id]).filter(Boolean);
            const ratingA = teamRating(teamA);
            const ratingB = teamRating(teamB);
            const filled = teamA.length + teamB.length > 0;
            return (
              <div key={idx} className="surface-panel p-5">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div>
                    <h3 className="font-display text-xl font-bold">Court {idx + 1}</h3>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      {filled ? 'Playing' : 'Open'}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {filled ? (
                      <>
                        <Button
                          asChild
                          size="sm"
                          variant="outline"
                        >
                          <Link
                            to={`/app/matches/new?from=session&session=${session?.id || ''}&court=${idx}`}
                            onClick={() => {
                              if (club?.id) {
                                saveSessionTeamsPrefill(club.id, {
                                  teamA: court.teamA,
                                  teamB: court.teamB,
                                });
                              }
                            }}
                          >
                            Log
                          </Link>
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => clearCourt(idx)}>
                          Clear
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={waiting.length < 2}
                        onClick={() => assignCourt(idx, waiting)}
                      >
                        Fill from waiting
                      </Button>
                    )}
                  </div>
                </div>
                {filled ? (
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    {[
                      { label: 'Team A', players: teamA, rating: ratingA, chance: winChance(ratingA, ratingB) },
                      { label: 'Team B', players: teamB, rating: ratingB, chance: winChance(ratingB, ratingA) },
                    ].map((team) => (
                      <div key={team.label}>
                        <p className="text-xs uppercase text-muted-foreground">{team.label}</p>
                        <p className="font-display text-lg font-bold tabular-nums">{team.rating}</p>
                        <p className="mb-1 text-xs text-muted-foreground">{team.chance}% win</p>
                        <ul className="space-y-1">
                          {team.players.map((p) => (
                            <li key={p.id}>{p.name}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Empty — fill from waiting players.</p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="surface-panel p-4">
        <h2 className="mb-2 font-display text-lg font-bold">Waiting</h2>
        {waiting.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody waiting — all attendees are on court.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {waiting.map((p) => (
              <span
                key={p.id}
                className="rounded-full border border-border px-3 py-1.5 text-sm"
              >
                {p.name}
                <span className="ml-1.5 text-muted-foreground">{p.doubles_rating}</span>
              </span>
            ))}
          </div>
        )}
      </section>

      <Dialog open={summaryOpen} onOpenChange={setSummaryOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-2xl">Tonight’s summary</DialogTitle>
            <DialogDescription>
              Session opened {durationLabel}. Closing clears attendance for next time.
            </DialogDescription>
          </DialogHeader>

          {summary && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
                  <p className="text-xs uppercase text-muted-foreground">Here</p>
                  <p className="font-display text-2xl font-bold tabular-nums">
                    {summary.attendeeCount}
                  </p>
                </div>
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
                  <p className="text-xs uppercase text-muted-foreground">Matches</p>
                  <p className="font-display text-2xl font-bold tabular-nums">
                    {summary.matchCount}
                  </p>
                </div>
              </div>

              <div>
                <h3 className="mb-2 text-sm font-semibold">Rating movers</h3>
                {topMovers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No rated matches logged for this session yet.
                  </p>
                ) : (
                  <ul className="divide-y divide-border rounded-md border border-border">
                    {topMovers.map((m) => (
                      <li
                        key={m.playerId}
                        className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                      >
                        <div className="min-w-0">
                          <p className="truncate font-medium">{m.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {m.wins}–{m.matches - m.wins} tonight
                          </p>
                        </div>
                        <span
                          className={cn(
                            'shrink-0 font-display text-lg font-bold tabular-nums',
                            m.netChange > 0
                              ? 'text-court'
                              : m.netChange < 0
                                ? 'text-destructive'
                                : 'text-muted-foreground'
                          )}
                        >
                          {m.netChange > 0 ? '+' : ''}
                          {m.netChange}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => setSummaryOpen(false)}>
              Keep open
            </Button>
            <Button
              type="button"
              onClick={() => closeMutation.mutate()}
              disabled={closeMutation.isPending}
            >
              {closeMutation.isPending ? 'Closing…' : 'Close session'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SessionPage;
