import { describe, expect, it } from 'vitest';
import { overallWinRate } from '../ladderStats';

describe('overallWinRate', () => {
  it('counts doubles, not just singles', () => {
    // A doubles-only player used to show 0% (win_rate counts singles only).
    expect(overallWinRate({ wins: 0, matches_played: 0, doubles_wins: 14, doubles_matches_played: 17 })).toBe(82);
  });
  it('combines both formats', () => {
    expect(overallWinRate({ wins: 3, matches_played: 4, doubles_wins: 5, doubles_matches_played: 6 })).toBe(80);
  });
  it('is null with no matches', () => {
    expect(overallWinRate({ wins: 0, matches_played: 0, doubles_wins: 0, doubles_matches_played: 0 })).toBeNull();
    expect(overallWinRate({ wins: null, matches_played: null, doubles_wins: null, doubles_matches_played: null })).toBeNull();
  });
});
