import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
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
  refreshClubs: () => Promise<void>;
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

  const refreshClubs = useCallback(async () => {
    if (!userId) {
      setClubs([]);
      setMemberships([]);
      setSeason(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    const { data: memberRows, error: memberError } = await supabase
      .from('memberships')
      .select('*')
      .eq('user_id', userId);

    if (memberError) {
      console.error(memberError);
      setIsLoading(false);
      return;
    }

    const membershipList = (memberRows || []) as Membership[];
    setMemberships(membershipList);

    const clubIds = membershipList.map((m) => m.club_id);
    if (clubIds.length === 0) {
      setClubs([]);
      setIsLoading(false);
      return;
    }

    const { data: clubRows, error: clubError } = await supabase
      .from('clubs')
      .select('*')
      .in('id', clubIds);

    if (clubError) {
      console.error(clubError);
      setIsLoading(false);
      return;
    }

    const clubList = (clubRows || []) as Club[];
    setClubs(clubList);

    const stored = localStorage.getItem(ACTIVE_CLUB_KEY);
    const nextId =
      (stored && clubList.some((c) => c.id === stored) && stored) ||
      clubList[0]?.id ||
      null;
    setActiveClubIdState(nextId);
    if (nextId) localStorage.setItem(ACTIVE_CLUB_KEY, nextId);

    setIsLoading(false);
  }, [userId]);

  useEffect(() => {
    refreshClubs();
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
