import { provisionalK, ratingDelta } from './elo';
import { getLocalAuthUid } from './auth';
import { loadDb, mutateDb, nowIso, uid, type LocalDb } from './store';
import type { Database } from '../types';

type RpcName = keyof Database['public']['Functions'];

function fail(message: string) {
  return { data: null, error: { message, details: '', hint: '', code: 'P0001' } };
}

function ok<T>(data: T) {
  return { data, error: null };
}

function requireUser() {
  const id = getLocalAuthUid();
  if (!id) throw new Error('Not authenticated');
  return id;
}

function isMember(db: LocalDb, clubId: string, userId: string) {
  return db.memberships.some((m) => m.club_id === clubId && m.user_id === userId);
}

function requireMember(db: LocalDb, clubId: string, userId: string) {
  if (!isMember(db, clubId, userId)) throw new Error('Not a club member');
}

function activeSeason(db: LocalDb, clubId: string) {
  return db.seasons.find((s) => s.club_id === clubId && s.is_active) || null;
}

function pairKey(a: string, b: string) {
  return a < b ? [a, b] : [b, a];
}

function ensurePair(db: LocalDb, clubId: string, a: string, b: string) {
  const [low, high] = pairKey(a, b);
  let pair = db.pair_ratings.find(
    (p) => p.club_id === clubId && p.player_low_id === low && p.player_high_id === high
  );
  if (!pair) {
    const t = nowIso();
    pair = {
      id: uid(),
      club_id: clubId,
      player_low_id: low,
      player_high_id: high,
      rating: 1500,
      matches_played: 0,
      wins: 0,
      created_at: t,
      updated_at: t,
    };
    db.pair_ratings.push(pair);
  }
  return pair;
}

function logMatch(args: Record<string, unknown>) {
  const userId = requireUser();
  const clubId = args.p_club_id as string;
  const t1p1 = args.p_team1_player1_id as string;
  const t1p2 = (args.p_team1_player2_id as string | null) || null;
  const t2p1 = args.p_team2_player1_id as string;
  const t2p2 = (args.p_team2_player2_id as string | null) || null;
  const s1 = args.p_team1_score as number;
  const s2 = args.p_team2_score as number;
  const playedAt = (args.p_played_at as string) || nowIso();
  const sessionId = (args.p_session_id as string | null) || null;
  const note = (args.p_session_note as string | null) || null;
  const disputed = Boolean(args.p_is_disputed);

  let result: Record<string, unknown> | null = null;

  mutateDb((db) => {
    requireMember(db, clubId, userId);
    if (s1 === s2) throw new Error('Ties are not allowed');
    if (!t1p1 || !t2p1) throw new Error('Each team needs at least one player');
    const isDoubles = Boolean(t1p2 && t2p2);
    if (Boolean(t1p2) !== Boolean(t2p2)) {
      throw new Error('Singles and doubles sides must match (both singles or both doubles)');
    }
    const ids = [t1p1, t1p2, t2p1, t2p2].filter(Boolean) as string[];
    if (new Set(ids).size !== ids.length) throw new Error('All players in a match must be distinct');

    if (sessionId) {
      const session = db.club_sessions.find((s) => s.id === sessionId);
      if (!session || session.club_id !== clubId) throw new Error('Invalid session for club');
      if (session.status !== 'open') throw new Error('Session is closed');
    }

    const players = ids.map((id) => {
      const p = db.players.find((x) => x.id === id && x.club_id === clubId);
      if (!p) throw new Error('Players not found in club');
      return p;
    });

    const format = isDoubles ? 'doubles' : 'singles';
    const minMp = Math.min(
      ...players.map((p) => (isDoubles ? p.doubles_matches_played : p.matches_played))
    );
    const k = provisionalK(minMp);
    const winner = s1 > s2 ? 'team1' : 'team2';
    const season = activeSeason(db, clubId);

    const team1Ids = [t1p1, t1p2].filter(Boolean) as string[];
    const team2Ids = [t2p1, t2p2].filter(Boolean) as string[];

    const avg = (list: string[], doubles: boolean) => {
      const vals = list.map((id) => {
        const p = players.find((x) => x.id === id)!;
        return doubles ? p.doubles_rating : p.rating;
      });
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };

    const t1Rating = avg(team1Ids, isDoubles);
    const t2Rating = avg(team2Ids, isDoubles);
    const t1Change = ratingDelta(t1Rating, t2Rating, winner === 'team1', k);
    const t2Change = ratingDelta(t2Rating, t1Rating, winner === 'team2', k);

    const matchId = uid();
    const t = nowIso();
    db.matches.push({
      id: matchId,
      club_id: clubId,
      season_id: season?.id ?? null,
      session_id: sessionId,
      user_id: userId,
      team1_player1_id: t1p1,
      team1_player2_id: t1p2,
      team2_player1_id: t2p1,
      team2_player2_id: t2p2,
      team1_score: s1,
      team2_score: s2,
      winner,
      duration_minutes: 0,
      session_note: note,
      is_disputed: disputed,
      created_at: t,
      updated_at: t,
    });

    const events: Record<string, unknown>[] = [];

    for (const p of players) {
      const onTeam1 = team1Ids.includes(p.id);
      const isWinner = (onTeam1 && winner === 'team1') || (!onTeam1 && winner === 'team2');
      const delta = disputed ? 0 : onTeam1 ? t1Change : t2Change;
      const before = isDoubles ? p.doubles_rating : p.rating;
      const after = disputed ? before : before + delta;
      const streakBefore = isDoubles ? p.doubles_streak_count : p.streak_count ?? 0;

      db.match_history.push({
        id: uid(),
        match_id: matchId,
        player_id: p.id,
        club_id: clubId,
        date: playedAt,
        rating_before: before,
        rating_after: after,
        rating_change: delta,
        score_difference: Math.abs(s1 - s2),
        is_winner: isWinner,
        rating_format: format,
        streak_before: streakBefore,
        created_at: t,
      });

      if (!disputed) {
        if (isDoubles) {
          p.doubles_rating = after;
          p.doubles_matches_played += 1;
          if (isWinner) {
            p.doubles_wins += 1;
            p.doubles_streak_count = (p.doubles_streak_count || 0) + 1;
          } else {
            p.doubles_streak_count = 0;
          }
        } else {
          p.rating = after;
          p.matches_played += 1;
          if (isWinner) {
            p.wins += 1;
            p.streak_count = (p.streak_count || 0) + 1;
          } else {
            p.streak_count = 0;
          }
        }
        p.last_played_at = playedAt;
        p.win_rate =
          (isDoubles ? p.doubles_wins / Math.max(1, p.doubles_matches_played) : p.wins / Math.max(1, p.matches_played));
        p.updated_at = t;
      }

      events.push({
        player_id: p.id,
        rating_before: before,
        rating_after: after,
        rating_change: delta,
        is_winner: isWinner,
        format,
      });
    }

    if (isDoubles && !disputed && t1p2 && t2p2) {
      const pair1 = ensurePair(db, clubId, t1p1, t1p2);
      const pair2 = ensurePair(db, clubId, t2p1, t2p2);
      const p1Before = pair1.rating;
      const p2Before = pair2.rating;
      const p1Delta = ratingDelta(p1Before, p2Before, winner === 'team1', k);
      const p2Delta = ratingDelta(p2Before, p1Before, winner === 'team2', k);
      pair1.rating = p1Before + p1Delta;
      pair2.rating = p2Before + p2Delta;
      pair1.matches_played += 1;
      pair2.matches_played += 1;
      if (winner === 'team1') pair1.wins += 1;
      else pair2.wins += 1;
      pair1.updated_at = t;
      pair2.updated_at = t;
      db.pair_match_history.push(
        {
          id: uid(),
          match_id: matchId,
          pair_id: pair1.id,
          club_id: clubId,
          rating_before: p1Before,
          rating_after: pair1.rating,
          rating_change: p1Delta,
          is_winner: winner === 'team1',
          created_at: t,
        },
        {
          id: uid(),
          match_id: matchId,
          pair_id: pair2.id,
          club_id: clubId,
          rating_before: p2Before,
          rating_after: pair2.rating,
          rating_change: p2Delta,
          is_winner: winner === 'team2',
          created_at: t,
        }
      );
    }

    result = {
      match_id: matchId,
      disputed,
      format,
      events,
    };
  });

  return ok(result);
}

function undoMatch(args: Record<string, unknown>) {
  const userId = requireUser();
  const matchId = args.p_match_id as string;

  mutateDb((db) => {
    const match = db.matches.find((m) => m.id === matchId);
    if (!match?.club_id) throw new Error('Match not found');
    requireMember(db, match.club_id, userId);

    const history = db.match_history.filter((h) => h.match_id === matchId);
    for (const h of history) {
      const player = db.players.find((p) => p.id === h.player_id);
      if (!player || h.rating_change === 0) continue;
      if (h.rating_format === 'doubles') {
        player.doubles_rating = h.rating_before;
        player.doubles_matches_played = Math.max(0, player.doubles_matches_played - 1);
        if (h.is_winner) player.doubles_wins = Math.max(0, player.doubles_wins - 1);
        player.doubles_streak_count = h.streak_before ?? 0;
      } else {
        player.rating = h.rating_before;
        player.matches_played = Math.max(0, player.matches_played - 1);
        if (h.is_winner) player.wins = Math.max(0, player.wins - 1);
        player.streak_count = h.streak_before ?? 0;
      }
      player.updated_at = nowIso();
    }

    const pairHist = db.pair_match_history.filter((h) => h.match_id === matchId);
    for (const h of pairHist) {
      const pair = db.pair_ratings.find((p) => p.id === h.pair_id);
      if (!pair) continue;
      pair.rating = h.rating_before;
      pair.matches_played = Math.max(0, pair.matches_played - 1);
      if (h.is_winner) pair.wins = Math.max(0, pair.wins - 1);
      pair.updated_at = nowIso();
    }

    db.match_history = db.match_history.filter((h) => h.match_id !== matchId);
    db.pair_match_history = db.pair_match_history.filter((h) => h.match_id !== matchId);
    db.matches = db.matches.filter((m) => m.id !== matchId);
  });

  return ok({ undone: true });
}

export async function callRpc(fn: string, args: Record<string, unknown> = {}) {
  try {
    switch (fn as RpcName | string) {
      case 'create_club': {
        const userId = requireUser();
        const name = String(args.p_name || '').trim();
        if (!name) return fail('Club name required');
        let club = null as ReturnType<typeof loadDb>['clubs'][number] | null;
        mutateDb((db) => {
          const t = nowIso();
          const id = uid();
          club = {
            id,
            name,
            slug: name.toLowerCase().replace(/\s+/g, '-').slice(0, 40),
            share_token: uid().replace(/-/g, '').slice(0, 12),
            created_by: userId,
            created_at: t,
            updated_at: t,
          };
          db.clubs.push(club);
          db.memberships.push({
            id: uid(),
            club_id: id,
            user_id: userId,
            role: 'owner',
            created_at: t,
          });
          db.seasons.push({
            id: uid(),
            club_id: id,
            name: 'Season 1',
            starts_at: t,
            ends_at: null,
            is_active: true,
            created_at: t,
          });
        });
        return ok(club);
      }

      case 'join_club_with_code': {
        const userId = requireUser();
        const code = String(args.p_code || '')
          .trim()
          .toUpperCase();
        let club = null as ReturnType<typeof loadDb>['clubs'][number] | null;
        mutateDb((db) => {
          const invite = db.invites.find(
            (i) => i.code.toUpperCase() === code && !i.revoked_at && !i.used_at
          );
          if (!invite) throw new Error('Invalid invite code');
          if (!isMember(db, invite.club_id, userId)) {
            db.memberships.push({
              id: uid(),
              club_id: invite.club_id,
              user_id: userId,
              role: invite.role || 'member',
              created_at: nowIso(),
            });
          }
          club = db.clubs.find((c) => c.id === invite.club_id) || null;
        });
        return ok(club);
      }

      case 'create_player': {
        const userId = requireUser();
        const clubId = args.p_club_id as string;
        let player = null as ReturnType<typeof loadDb>['players'][number] | null;
        mutateDb((db) => {
          requireMember(db, clubId, userId);
          const season = activeSeason(db, clubId);
          const t = nowIso();
          player = {
            id: uid(),
            club_id: clubId,
            season_id: season?.id ?? null,
            name: String(args.p_name || 'Player'),
            age: (args.p_age as number | null) ?? null,
            position: null,
            rating: 1500,
            doubles_rating: 1500,
            matches_played: 0,
            doubles_matches_played: 0,
            wins: 0,
            doubles_wins: 0,
            win_rate: 0,
            streak_count: 0,
            doubles_streak_count: 0,
            last_played_at: null,
            user_id: null,
            is_guest: Boolean(args.p_is_guest),
            archived_at: null,
            created_at: t,
            updated_at: t,
          };
          db.players.push(player);
        });
        return ok(player);
      }

      case 'update_player_profile': {
        const userId = requireUser();
        let player = null as ReturnType<typeof loadDb>['players'][number] | null;
        mutateDb((db) => {
          player = db.players.find((p) => p.id === args.p_player_id) || null;
          if (!player?.club_id) throw new Error('Player not found');
          requireMember(db, player.club_id, userId);
          player.name = String(args.p_name || player.name);
          if (args.p_age !== undefined) player.age = args.p_age as number | null;
          player.updated_at = nowIso();
        });
        return ok(player);
      }

      case 'archive_player': {
        const userId = requireUser();
        mutateDb((db) => {
          const player = db.players.find((p) => p.id === args.p_player_id);
          if (!player?.club_id) throw new Error('Player not found');
          requireMember(db, player.club_id, userId);
          player.archived_at = nowIso();
          player.updated_at = nowIso();
        });
        return ok(null);
      }

      case 'promote_guest': {
        const userId = requireUser();
        mutateDb((db) => {
          const player = db.players.find((p) => p.id === args.p_player_id);
          if (!player?.club_id) throw new Error('Player not found');
          requireMember(db, player.club_id, userId);
          player.is_guest = false;
          player.updated_at = nowIso();
        });
        return ok(null);
      }

      case 'link_player_to_user': {
        const userId = requireUser();
        mutateDb((db) => {
          const player = db.players.find((p) => p.id === args.p_player_id);
          if (!player?.club_id) throw new Error('Player not found');
          requireMember(db, player.club_id, userId);
          player.user_id = userId;
          player.updated_at = nowIso();
        });
        return ok(null);
      }

      case 'unlink_player': {
        const userId = requireUser();
        mutateDb((db) => {
          const player = db.players.find((p) => p.id === args.p_player_id);
          if (!player?.club_id) throw new Error('Player not found');
          requireMember(db, player.club_id, userId);
          player.user_id = null;
          player.updated_at = nowIso();
        });
        return ok(null);
      }

      case 'log_match':
        return logMatch(args);

      case 'undo_match':
        return undoMatch(args);

      case 'set_match_disputed': {
        const userId = requireUser();
        let match = null as ReturnType<typeof loadDb>['matches'][number] | null;
        mutateDb((db) => {
          match = db.matches.find((m) => m.id === args.p_match_id) || null;
          if (!match?.club_id) throw new Error('Match not found');
          requireMember(db, match.club_id, userId);
          match.is_disputed = Boolean(args.p_is_disputed);
          match.updated_at = nowIso();
        });
        return ok(match);
      }

      case 'get_or_open_session': {
        const userId = requireUser();
        const clubId = args.p_club_id as string;
        let session = null as ReturnType<typeof loadDb>['club_sessions'][number] | null;
        mutateDb((db) => {
          requireMember(db, clubId, userId);
          session = db.club_sessions.find((s) => s.club_id === clubId && s.status === 'open') || null;
          if (!session) {
            const t = nowIso();
            session = {
              id: uid(),
              club_id: clubId,
              opened_by: userId,
              court_count: Number(args.p_court_count) || 2,
              status: 'open',
              attendee_ids: [],
              team_a_ids: [],
              team_b_ids: [],
              courts: [],
              created_at: t,
              updated_at: t,
              closed_at: null,
            };
            db.club_sessions.push(session);
          }
        });
        return ok(session);
      }

      case 'save_session_state': {
        const userId = requireUser();
        mutateDb((db) => {
          const session = db.club_sessions.find((s) => s.id === args.p_session_id);
          if (!session) throw new Error('Session not found');
          requireMember(db, session.club_id, userId);
          if (args.p_court_count != null) session.court_count = Number(args.p_court_count);
          if (args.p_attendee_ids) session.attendee_ids = args.p_attendee_ids as string[];
          if (args.p_team_a_ids) session.team_a_ids = args.p_team_a_ids as string[];
          if (args.p_team_b_ids) session.team_b_ids = args.p_team_b_ids as string[];
          if (args.p_courts !== undefined) session.courts = args.p_courts as never;
          session.updated_at = nowIso();
        });
        return ok(null);
      }

      case 'close_session': {
        const userId = requireUser();
        mutateDb((db) => {
          const session = db.club_sessions.find((s) => s.id === args.p_session_id);
          if (!session) throw new Error('Session not found');
          requireMember(db, session.club_id, userId);
          session.status = 'closed';
          session.closed_at = nowIso();
          session.updated_at = nowIso();
        });
        return ok(null);
      }

      case 'create_invite': {
        const userId = requireUser();
        const clubId = args.p_club_id as string;
        let invite = null as ReturnType<typeof loadDb>['invites'][number] | null;
        mutateDb((db) => {
          requireMember(db, clubId, userId);
          const t = nowIso();
          invite = {
            id: uid(),
            club_id: clubId,
            code: uid().replace(/-/g, '').slice(0, 8).toUpperCase(),
            role: String(args.p_role || 'member'),
            expires_at: null,
            created_by: userId,
            used_by: null,
            used_at: null,
            revoked_at: null,
            created_at: t,
          };
          db.invites.push(invite);
        });
        return ok(invite);
      }

      case 'revoke_invite': {
        const userId = requireUser();
        mutateDb((db) => {
          const invite = db.invites.find((i) => i.id === args.p_invite_id);
          if (!invite) throw new Error('Invite not found');
          requireMember(db, invite.club_id, userId);
          invite.revoked_at = nowIso();
        });
        return ok(null);
      }

      case 'rename_club': {
        const userId = requireUser();
        let club = null as ReturnType<typeof loadDb>['clubs'][number] | null;
        mutateDb((db) => {
          requireMember(db, args.p_club_id as string, userId);
          club = db.clubs.find((c) => c.id === args.p_club_id) || null;
          if (!club) throw new Error('Club not found');
          club.name = String(args.p_name || club.name);
          club.updated_at = nowIso();
        });
        return ok(club);
      }

      case 'rotate_share_token': {
        const userId = requireUser();
        let club = null as ReturnType<typeof loadDb>['clubs'][number] | null;
        mutateDb((db) => {
          requireMember(db, args.p_club_id as string, userId);
          club = db.clubs.find((c) => c.id === args.p_club_id) || null;
          if (!club) throw new Error('Club not found');
          club.share_token = uid().replace(/-/g, '').slice(0, 12);
          club.updated_at = nowIso();
        });
        return ok(club);
      }

      case 'leave_club': {
        const userId = requireUser();
        mutateDb((db) => {
          db.memberships = db.memberships.filter(
            (m) => !(m.club_id === args.p_club_id && m.user_id === userId)
          );
        });
        return ok(null);
      }

      case 'remove_member': {
        const userId = requireUser();
        mutateDb((db) => {
          requireMember(db, args.p_club_id as string, userId);
          db.memberships = db.memberships.filter(
            (m) => !(m.club_id === args.p_club_id && m.user_id === args.p_user_id)
          );
        });
        return ok(null);
      }

      case 'update_member_role': {
        const userId = requireUser();
        mutateDb((db) => {
          requireMember(db, args.p_club_id as string, userId);
          const m = db.memberships.find(
            (x) => x.club_id === args.p_club_id && x.user_id === args.p_user_id
          );
          if (!m) throw new Error('Member not found');
          m.role = String(args.p_role || m.role);
        });
        return ok(null);
      }

      case 'transfer_ownership': {
        const userId = requireUser();
        mutateDb((db) => {
          requireMember(db, args.p_club_id as string, userId);
          const owner = db.memberships.find(
            (m) => m.club_id === args.p_club_id && m.user_id === userId
          );
          const next = db.memberships.find(
            (m) => m.club_id === args.p_club_id && m.user_id === args.p_new_owner_id
          );
          if (!owner || !next) throw new Error('Members not found');
          owner.role = 'admin';
          next.role = 'owner';
        });
        return ok(null);
      }

      case 'start_season': {
        const userId = requireUser();
        const clubId = args.p_club_id as string;
        let season = null as ReturnType<typeof loadDb>['seasons'][number] | null;
        mutateDb((db) => {
          requireMember(db, clubId, userId);
          const t = nowIso();
          db.seasons.forEach((s) => {
            if (s.club_id === clubId && s.is_active) {
              s.is_active = false;
              s.ends_at = t;
            }
          });
          season = {
            id: uid(),
            club_id: clubId,
            name: String(args.p_name || 'New Season'),
            starts_at: t,
            ends_at: null,
            is_active: true,
            created_at: t,
          };
          db.seasons.push(season);
          if (args.p_hard_reset) {
            db.players.forEach((p) => {
              if (p.club_id !== clubId) return;
              p.rating = 1500;
              p.doubles_rating = 1500;
              p.matches_played = 0;
              p.doubles_matches_played = 0;
              p.wins = 0;
              p.doubles_wins = 0;
              p.streak_count = 0;
              p.doubles_streak_count = 0;
              p.season_id = season!.id;
              p.updated_at = t;
            });
          }
        });
        return ok(season);
      }

      case 'get_public_ladder': {
        const token = String(args.p_share_token || '');
        const db = loadDb();
        const club = db.clubs.find((c) => c.share_token === token);
        if (!club) return fail('Ladder not found');
        const players = db.players
          .filter((p) => p.club_id === club.id && !p.archived_at)
          .sort((a, b) => b.doubles_rating - a.doubles_rating);
        return ok({ club: { id: club.id, name: club.name }, players });
      }

      case 'ensure_pair_rating': {
        const userId = requireUser();
        let pair = null as ReturnType<typeof loadDb>['pair_ratings'][number] | null;
        mutateDb((db) => {
          requireMember(db, args.p_club_id as string, userId);
          pair = ensurePair(db, args.p_club_id as string, args.p_player_a as string, args.p_player_b as string);
        });
        return ok(pair);
      }

      default:
        return fail(`RPC ${fn} is not implemented in local mode`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}
