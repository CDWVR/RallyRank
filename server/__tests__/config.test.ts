// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.ts';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost/db',
  JWT_SECRET: 'x'.repeat(32),
  POSTGREST_URL: 'http://localhost:3001',
};

describe('loadConfig', () => {
  it('treats an empty AUTHENTICATOR_PASSWORD as unset instead of failing the boot', () => {
    expect(loadConfig({ ...base, AUTHENTICATOR_PASSWORD: '' }).AUTHENTICATOR_PASSWORD).toBeUndefined();
    expect(loadConfig(base).AUTHENTICATOR_PASSWORD).toBeUndefined();
    expect(loadConfig({ ...base, AUTHENTICATOR_PASSWORD: 'secret' }).AUTHENTICATOR_PASSWORD).toBe('secret');
  });
});
