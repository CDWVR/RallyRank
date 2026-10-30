import { describe, expect, it } from 'vitest';
import { expectedScore, provisionalK, ratingDelta } from '../elo';
import { uid } from '../store';

describe('local elo helpers', () => {
  it('generates uuid-shaped ids without requiring crypto.randomUUID', () => {
    const id = uid();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('uses provisional K until 8 matches', () => {
    expect(provisionalK(0)).toBe(40);
    expect(provisionalK(7)).toBe(40);
    expect(provisionalK(8)).toBe(32);
  });

  it('computes expected score for equal ratings as 0.5', () => {
    expect(expectedScore(1500, 1500)).toBeCloseTo(0.5);
  });

  it('applies a singles rating change for an equal-rating win with K=40', () => {
    // equal ratings → expected 0.5 → delta = round(40 * 0.5) = 20
    expect(ratingDelta(1500, 1500, true, 40)).toBe(20);
    expect(ratingDelta(1500, 1500, false, 40)).toBe(-20);
  });
});
