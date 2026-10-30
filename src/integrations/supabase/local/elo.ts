/** Pure Elo helpers mirrored from public.log_match (K=40 if <8 matches, else 32). */

export function expectedScore(rating: number, opponentRating: number): number {
  return 1 / (1 + 10 ** ((opponentRating - rating) / 400));
}

export function ratingDelta(
  rating: number,
  opponentRating: number,
  won: boolean,
  k: number
): number {
  const expected = expectedScore(rating, opponentRating);
  const score = won ? 1 : 0;
  return Math.round(k * (score - expected));
}

export function provisionalK(minMatchesPlayed: number): number {
  return minMatchesPlayed < 8 ? 40 : 32;
}
