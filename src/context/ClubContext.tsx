import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/context/AuthContext';
import type { Club, ClubRole, Membership, Season } from '@/integrations/supabase/types';

type ClubContextType = {
  clubs: Club[];
  memberships: Membership[];
  club: Club | null;
  role: ClubRole | null;
  season: Season | null;
  isLoading: boolean;
  setActiveClubId: (id: string) => void;
  refreshClubs: (options?: { silent?: boolean }) => Promise<void>;
  refreshSeason: () => Promise<void>;
  createClub: (name: string) => Promise<Club>;
  joinClub: (code: string) => Promise<Club>;
};

const ClubContext = createContext<ClubContextType | undefined>(undefined);

const ACTIVE_CLUB_KEY = 'rallyrank.activeClubId';

export const ClubProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  // Keyed on the id, not the object: a session refresh must not reload every club query.
  const userId = user?.id ?? null;
  const [clubs, setClubs] = useState<Club[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [activeClubId, setActiveClubIdState] = useState<string | null>(
    () => localStorage.getItem(ACTIVE_CLUB_KEY)
  );
  const [season, setSeason] = useState<Season | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Refreshes can overlap (initial load, mutations, tab becoming visible). Each one takes a generation
  // number; only the newest may write state, so an older, slower response can't overwrite newer data.
  const generation = useRef(0);
  const inFlight = useRef(0);
  // A visibility check that arrived mid-load; run once when the load finishes (repeats coalesce).
  const recheckQueued = useRef(false);

  const refreshClubs = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!userId) {
      setClubs([]);
      setMemberships([]);
      setSeason(null);
      setIsLoading(false);
      return;
    }
    // A background re-check never overlaps a running load, so it can't end or supersede it. The running
    // load may have read memberships before the change that prompted this check, so queue one re-check.
    if (silent && inFlight.current > 0) {
      recheckQueued.current = true;
      return;
    }

    const gen = ++generation.current;
    inFlight.current += 1;
    // A background refresh must not swap the page for a loading screen.
    if (!silent) setIsLoading(true);
    try {
      const { data: memberRows, error: memberError } = await supabase
        .from('memberships')
        .select('*')
        .eq('user_id', userId);
      if (memberError) {
        console.error(memberError);
        return;
      }
      const membershipList = (memberRows || []) as Membership[];

      let clubList: Club[] = [];
      const clubIds = membershipList.map((m) => m.club_id);
      if (clubIds.length > 0) {
        const { data: clubRows, error: clubError } = await supabase.from('clubs').select('*').in('id', clubIds);
        if (clubError) {
          console.error(clubError);
          return;
        }
        clubList = (clubRows || []) as Club[];
      }

      if (gen !== generation.current) return;
      setMemberships(membershipList);
      setClubs(clubList);
      if (clubList.length === 0) return;

      const stored = localStorage.getItem(ACTIVE_CLUB_KEY);
      const nextId =
        (stored && clubList.some((c) => c.id === stored) && stored) ||
        clubList[0]?.id ||
        null;
      setActiveClubIdState(nextId);
      if (nextId) localStorage.setItem(ACTIVE_CLUB_KEY, nextId);
    } finally {
      inFlight.current -= 1;
      // Only the latest foreground load ends the loading state.
      if (!silent && gen === generation.current) setIsLoading(false);
      if (inFlight.current === 0 && recheckQueued.current) {
        recheckQueued.current = false;
        void refreshClubs({ silent: true });
      }
    }
  }, [userId]);

  useEffect(() => {
    refreshClubs();
  }, [refreshClubs]);

  // Memberships can change elsewhere (removed from a club, role changed on another device). Re-check when
  // the tab becomes visible again, quietly; session refreshes deliberately no longer trigger a reload.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshClubs({ silent: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshClubs]);

  const refreshSeason = useCallback(async () => {
    if (!activeClubId) {
      setSeason(null);
      return;
    }

    const { data } = await supabase
      .from('seasons')
      .select('*')
      .eq('club_id', activeClubId)
      .eq('is_active', true)
      .maybeSingle();
    setSeason((data as Season) || null);
  }, [activeClubId]);

  useEffect(() => {
    void refreshSeason();
  }, [refreshSeason]);

  const setActiveClubId = (id: string) => {
    setActiveClubIdState(id);
    localStorage.setItem(ACTIVE_CLUB_KEY, id);
  };

  const createClub = async (name: string) => {
    const { data, error } = await supabase.rpc('create_club', { p_name: name });
    if (error) throw error;
    const club = data as Club;
    await refreshClubs();
    setActiveClubId(club.id);
    return club;
  };

  const joinClub = async (code: string) => {
    const { data, error } = await supabase.rpc('join_club_with_code', { p_code: code });
    if (error) throw error;
    const club = data as Club;
    await refreshClubs();
    setActiveClubId(club.id);
    return club;
  };

  const club = useMemo(
    () => clubs.find((c) => c.id === activeClubId) || null,
    [clubs, activeClubId]
  );

  const role = useMemo(() => {
    if (!club || !user) return null;
    const m = memberships.find((x) => x.club_id === club.id && x.user_id === user.id);
    return (m?.role as ClubRole) || null;
  }, [club, memberships, user]);

  const value: ClubContextType = {
    clubs,
    memberships,
    club,
    role,
    season,
    isLoading,
    setActiveClubId,
    refreshClubs,
    refreshSeason,
    createClub,
    joinClub,
  };

  return <ClubContext.Provider value={value}>{children}</ClubContext.Provider>;
};

export const useClub = () => {
  const ctx = useContext(ClubContext);
  if (!ctx) throw new Error('useClub must be used within ClubProvider');
  return ctx;
};
