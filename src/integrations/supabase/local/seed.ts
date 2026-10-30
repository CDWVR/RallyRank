import type { LocalDb } from './store';
import { nowIso, uid } from './store';

const DEMO_NAMES = [
  'Alex Chen',
  'Jordan Lee',
  'Sam Rivera',
  'Taylor Kim',
  'Casey Brooks',
  'Riley Quinn',
  'Morgan Diaz',
  'Jamie Park',
];

/** Ensure the user owns a demo club with season + roster (idempotent per user). */
export function ensureDemoClub(db: LocalDb, userId: string): void {
  const existing = db.memberships.find((m) => m.user_id === userId);
  if (existing) return;

  const clubId = uid();
  const seasonId = uid();
  const t = nowIso();
  const share = uid().replace(/-/g, '').slice(0, 12);
  const inviteCode = uid().replace(/-/g, '').slice(0, 8).toUpperCase();

  db.clubs.push({
    id: clubId,
    name: 'Demo Club',
    slug: 'demo-club',
    share_token: share,
    created_by: userId,
    created_at: t,
    updated_at: t,
  });

  db.memberships.push({
    id: uid(),
    club_id: clubId,
    user_id: userId,
    role: 'owner',
    created_at: t,
  });

  db.seasons.push({
    id: seasonId,
    club_id: clubId,
    name: 'Season 1',
    starts_at: t,
    ends_at: null,
    is_active: true,
    created_at: t,
  });

  db.invites.push({
    id: uid(),
    club_id: clubId,
    code: inviteCode,
    role: 'member',
    expires_at: null,
    created_by: userId,
    used_by: null,
    used_at: null,
    revoked_at: null,
    created_at: t,
  });

  DEMO_NAMES.forEach((name, i) => {
    const rating = 1400 + (i - 3) * 40;
    db.players.push({
      id: uid(),
      club_id: clubId,
      season_id: seasonId,
      name,
      age: 20 + i,
      position: null,
      rating,
      doubles_rating: rating,
      matches_played: i,
      doubles_matches_played: i,
      wins: Math.floor(i / 2),
      doubles_wins: Math.floor(i / 2),
      win_rate: i === 0 ? 0 : 0.5,
      streak_count: 0,
      doubles_streak_count: 0,
      last_played_at: null,
      user_id: null,
      is_guest: false,
      archived_at: null,
      created_at: t,
      updated_at: t,
    });
  });
}
