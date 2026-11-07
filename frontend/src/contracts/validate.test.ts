import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMessage } from './validate';

const dir = new URL('../../../contracts/fixtures/', import.meta.url);
const read = (sub: string) =>
  readdirSync(new URL(sub, dir)).map((f) => [f, readFileSync(new URL(`${sub}${f}`, dir), 'utf8')] as const);

describe('shared fixtures', () => {
  it.each(read('valid/'))('accepts valid fixture %s', (_name, text) => {
    expect(() => parseMessage(text)).not.toThrow();
  });

  const invalid = read('invalid/').map(([f, t]) => [f, JSON.parse(t)] as const);

  it.each(invalid.filter(([, c]) => c.layer === 'structural'))('rejects structural fixture %s', (_name, c) => {
    expect(() => parseMessage(c.raw)).toThrowError(expect.objectContaining({ code: c.expectedCode }));
  });

  it('documents which fixtures only the backend rejects', () => {
    // Cross-field rules are not expressible in JSON Schema; the backend enforces them.
    const semantic = invalid.filter(([, c]) => c.layer === 'semantic').map(([f]) => f);
    expect(semantic.length).toBeGreaterThan(0);
  });
});

describe('schema version', () => {
  it('rejects a message from the previous schema version', () => {
    const msg = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/valid/heartbeat.json', import.meta.url), 'utf8'));
    expect(() => parseMessage(JSON.stringify(msg))).not.toThrow();
    expect(() => parseMessage(JSON.stringify({ ...msg, schemaVersion: '0.1.0' }))).toThrowError(
      expect.objectContaining({ code: 'schema_version_mismatch' }),
    );
  });
});
