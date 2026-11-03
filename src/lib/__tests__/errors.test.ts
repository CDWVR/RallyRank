import { describe, expect, it } from 'vitest';
import { describeError } from '../errors';

describe('describeError', () => {
  it('reads the message of plain PostgREST error objects, which are not Error instances', () => {
    const err = { code: 'P0001', message: 'Club name is required', details: null, hint: null };
    expect(err instanceof Error).toBe(false);
    expect(describeError(err, 'Could not create club')).toBe('Club name is required');
  });

  it('explains a rejected JWT instead of showing "JWSError JWSInvalidSignature"', () => {
    expect(describeError({ code: 'PGRST301', message: 'JWSError JWSInvalidSignature' })).toMatch(/server configuration problem/);
    expect(describeError({ code: 'PGRST300', message: 'Server lacks JWT secret' })).toMatch(/server configuration problem/);
  });

  it('treats an expired token as an expired session, and a missing function as not temporary', () => {
    expect(describeError({ code: 'PGRST301', message: 'JWT expired' })).toMatch(/session has expired/);
    expect(describeError({ code: 'PGRST202', message: 'Could not find the function' })).toMatch(/contact the admin/);
    expect(describeError({ code: 'PGRST205', message: 'Could not find the table' })).toMatch(/still updating/);
  });

  it('keeps Error messages, maps network failures, and falls back for empty values', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError(new TypeError('Failed to fetch'))).toMatch(/Can't reach the server/);
    expect(describeError({ message: '' }, 'fallback')).toBe('fallback');
    expect(describeError(undefined, 'fallback')).toBe('fallback');
  });
});
