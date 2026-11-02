import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  // HS256 secret shared with PostgREST (PGRST_JWT_SECRET); PostgREST rejects shorter ones.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  POSTGREST_URL: z.url(),
  // PostgREST's login password; startup migrations apply it to the authenticator role.
  // An empty value (`AUTHENTICATOR_PASSWORD=`) counts as unset, so it warns instead of failing the boot.
  AUTHENTICATOR_PASSWORD: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Config = z.infer<typeof schema>;

/** Reads and validates env; throws with every missing/invalid variable listed so a bad deploy fails at boot. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid server configuration: ${problems}`);
  }
  return parsed.data;
}
