// src/disposition/rollup.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRollup } from './rollup';

const dirs: string[] = [];
function tmpFile(contents: string): string {
  const d = mkdtempSync(join(tmpdir(), 'e05-'));
  dirs.push(d);
  const p = join(d, 'disposition-rollup.json');
  writeFileSync(p, contents);
  return p;
}
afterEach(() => { dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });

describe('loadRollup', () => {
  it('parses a valid rollup', () => {
    const p = tmpFile(JSON.stringify({ generatedFrom: 1, domains: { security: { a: 2, m: 0, o: 0, d: 0, n: 2, bucket: 'high-trust' } }, topics: {} }));
    const r = loadRollup(p);
    expect(r?.domains.security.bucket).toBe('high-trust');
  });

  it('missing file -> null (fail-closed)', () => {
    expect(loadRollup('/nonexistent/disposition-rollup.json')).toBeNull();
  });

  it('corrupt JSON -> null (fail-closed)', () => {
    expect(loadRollup(tmpFile('{ not json'))).toBeNull();
  });

  it('JSON missing required shape -> null', () => {
    expect(loadRollup(tmpFile(JSON.stringify({ foo: 1 })))).toBeNull();
  });
});
