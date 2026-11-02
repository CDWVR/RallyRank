// @vitest-environment node
// Production runs `node server/index.ts`, which only strips types. Vitest transpiles, so syntax that needs
// transpiling (parameter properties, enums, namespaces) would pass every other test and still crash the
// deployed server at boot. Load each server module the way production does.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// index.ts starts the server, so it is checked through the modules it imports.
const modules = fs.readdirSync(serverDir).filter((f) => f.endsWith('.ts') && f !== 'index.ts');

describe('server modules load under Node type stripping', () => {
  it.each(modules)('%s', (file) => {
    const url = new URL(`file://${path.join(serverDir, file)}`).href;
    expect(() =>
      execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], {
        stdio: 'pipe',
        timeout: 20_000,
      })
    ).not.toThrow();
  });
});
