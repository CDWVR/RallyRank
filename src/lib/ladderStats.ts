import type { Player } from '@/integrations/supabase/types';

type MatchRow = {
  team1_player1_id: string;
  team1_player2_id: string | null;
  team2_player1_id: string;
  team2_player2_id: string | null;
  winner: string;
  team1_score: number;
  team2_score: number;
};

/** Last N results for a player as W/L chars (newest last). */
export function playerForm(
  matches: MatchRow[],
  playerId: string,
  limit = 5,
  format: 'all' | 'doubles' | 'singles' = 'all'
): string {
  const results: string[] = [];
  for (const m of [...matches].reverse()) {
    const isDoubles = Boolean(m.team1_player2_id && m.team2_player2_id);
    if (format === 'doubles' && !isDoubles) continue;
    if (format === 'singles' && isDoubles) continue;
    const onT1 =
      m.team1_player1_id === playerId || m.team1_player2_id === playerId;
    const onT2 =
      m.team2_player1_id === playerId || m.team2_player2_id === playerId;
    if (!onT1 && !onT2) continue;
    const won =
      (onT1 && m.winner === 'team1') || (onT2 && m.winner === 'team2');
    results.push(won ? 'W' : 'L');
    if (results.length >= limit) break;
  }
  return results.reverse().join('');
}

/**
 * Win rate across both formats, as a whole percentage, or null with no matches.
 * `win_rate` on the player row only counts singles, so a doubles-only player would show 0%.
 */
export function overallWinRate(p: {
  wins: number | null;
  matches_played: number | null;
  doubles_wins: number | null;
  doubles_matches_played: number | null;
}): number | null {
  const played = (p.matches_played ?? 0) + (p.doubles_matches_played ?? 0);
  if (played <= 0) return null;
  return Math.round((((p.wins ?? 0) + (p.doubles_wins ?? 0)) / played) * 100);
}

export type HeadToHead = {
  a: string;
  b: string;
  aName: string;
  bName: string;
  aWins: number;
  bWins: number;
  matches: number;
};

/** Singles H2H records (min 1 match), sorted by total matches. */
export function buildHeadToHeads(
  matches: MatchRow[],
  nameById: Record<string, string>,
  minMatches = 1
): HeadToHead[] {
  const map = new Map<string, { a: string; b: string; aWins: number; bWins: number }>();

  for (const m of matches) {
    if (m.team1_player2_id || m.team2_player2_id) continue;
    const p1 = m.team1_player1_id;
    const p2 = m.team2_player1_id;
    const [a, b] = [p1, p2].sort();
    const key = `${a}:${b}`;
    const prev = map.get(key) || { a, b, aWins: 0, bWins: 0 };
    if (m.winner === 'team1') {
      if (p1 === a) prev.aWins += 1;
      else prev.bWins += 1;
    } else {
      if (p2 === a) prev.aWins += 1;
      else prev.bWins += 1;
    }
    map.set(key, prev);
  }

  return [...map.values()]
    .map((x) => ({
      a: x.a,
      b: x.b,
      aName: nameById[x.a] || '?',
      bName: nameById[x.b] || '?',
      aWins: x.aWins,
      bWins: x.bWins,
      matches: x.aWins + x.bWins,
    }))
    .filter((x) => x.matches >= minMatches)
    .sort((a, b) => b.matches - a.matches || Math.abs(b.aWins - b.bWins) - Math.abs(a.aWins - a.bWins));
}

export function formBadgeClass(ch: string) {
  if (ch === 'W') return 'bg-court text-white';
  if (ch === 'L') return 'bg-destructive/90 text-white';
  return 'bg-muted text-muted-foreground';
}

export type { Player };
