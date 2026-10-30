import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalClient } from '../client';
import { resetLocalData } from '../store';

describe('local supabase client', () => {
  beforeEach(() => {
    resetLocalData();
  });

  it('allows sign-up and seeds a demo club with players', async () => {
    const client = createLocalClient();
    const { data, error } = await client.auth.signUp({
      email: 'dev@example.com',
      password: 'password123',
    });
    expect(error).toBeNull();
    expect(data.session?.user.email).toBe('dev@example.com');
    expect(data.user?.email_confirmed_at).toBeTruthy();

    const { data: memberships, error: mErr } = await client
      .from('memberships')
      .select('*')
      .eq('user_id', data.user!.id);
    expect(mErr).toBeNull();
    expect(memberships?.length).toBe(1);

    const clubId = (memberships as { club_id: string }[])[0].club_id;
    const { data: players, error: pErr } = await client
      .from('players')
      .select('*')
      .eq('club_id', clubId)
      .is('archived_at', null);
    expect(pErr).toBeNull();
    expect((players as unknown[]).length).toBeGreaterThanOrEqual(6);
  });

  it('updates singles ratings via log_match', async () => {
    const client = createLocalClient();
    const { data: auth } = await client.auth.signUp({
      email: 'elo@example.com',
      password: 'password123',
    });
    const userId = auth.user!.id;
    const { data: memberships } = await client.from('memberships').select('*').eq('user_id', userId);
    const clubId = (memberships as { club_id: string }[])[0].club_id;
    const { data: players } = await client
      .from('players')
      .select('*')
      .eq('club_id', clubId)
      .is('archived_at', null);

    const list = players as { id: string; rating: number; matches_played: number }[];
    const a = list[0];
    const b = list[1];
    const beforeA = a.rating;

    const { data, error } = await client.rpc('log_match', {
      p_club_id: clubId,
      p_team1_player1_id: a.id,
      p_team1_player2_id: null,
      p_team2_player1_id: b.id,
      p_team2_player2_id: null,
      p_team1_score: 21,
      p_team2_score: 15,
      p_played_at: new Date().toISOString(),
      p_session_id: null,
      p_session_note: null,
      p_is_disputed: false,
    });
    expect(error).toBeNull();
    expect((data as { match_id: string }).match_id).toBeTruthy();

    const { data: afterPlayers } = await client.from('players').select('*').eq('id', a.id).single();
    const after = afterPlayers as { rating: number; matches_played: number };
    expect(after.matches_played).toBe(a.matches_played + 1);
    expect(after.rating).not.toBe(beforeA);
  });
});
