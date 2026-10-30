/**
 * CI invariants for remaining audit remediations (L-01 / L-02).
 * Does not need a live database.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrations = join(root, 'db', 'migrations');

function mustContain(file, needles) {
  const path = join(migrations, file);
  if (!existsSync(path)) throw new Error(`Missing migration: ${file}`);
  const text = readFileSync(path, 'utf8');
  for (const n of needles) {
    if (!text.includes(n)) throw new Error(`${file} missing expected text:\n  ${n}`);
  }
}

mustContain('20260322195000_l01_drop_stale_overloads.sql', [
  'drop function if exists public.log_match',
  'drop function if exists public.start_season(uuid, text)',
]);

mustContain('20260322196000_db005_restore_streak_on_undo.sql', [
  'streak_before',
  'doubles_streak_count = coalesce(r.streak_before, 0)',
  'streak_count = coalesce(r.streak_before, 0)',
]);

// SEC-001: role guards (`club_role(x) not in (...)`) only fail closed if club_role never returns NULL.
mustContain('20260323000000_sec001_club_role_fail_closed.sql', ["'none'"]);

const matchNew = readFileSync(join(root, 'src', 'pages', 'app', 'MatchNewPage.tsx'), 'utf8');
for (const key of ['p_session_id', 'p_session_note', 'p_is_disputed']) {
  if (!matchNew.includes(key)) {
    throw new Error(`MatchNewPage must always pass ${key} to log_match (L-01)`);
  }
}

console.log('check-remediation-invariants: ok');
