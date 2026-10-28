import { describe, expect, it } from 'vitest';
import { resolvePath } from '../pathUtils';

describe('resolvePath', () => {
  it('prefixes the build base path, whatever page is open', () => {
    // vitest runs with base "/", so the prefix is empty; on Pages it is the repository path.
    expect(resolvePath('/favicon.svg')).toBe(`${import.meta.env.BASE_URL.replace(/\/$/, '')}/favicon.svg`);
    expect(resolvePath('favicon.svg')).toBe(resolvePath('/favicon.svg'));
  });
});
