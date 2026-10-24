import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { petstorePath, root } from './helpers.js';

function run(args: string[], env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  const done = main(args, {
    stdout: { write: (t: string) => (stdout += t) },
    stderr: { write: (t: string) => (stderr += t) },
    env,
  });
  return done.then((code) => ({ code, stdout, stderr }));
}

const scratch = path.join(root, '.tmp-test');
mkdirSync(scratch, { recursive: true });
const tmp = mkdtempSync(path.join(scratch, 'cli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('cli', () => {
  it('prints help and version', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('openapi-to-mcp serve');
    expect((await run([])).stdout).toContain('Usage:');
    const version = await run(['--version']);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('lists the read-only tools by default', async () => {
    const r = await run(['list', petstorePath]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('listPets');
    expect(r.stdout).not.toContain('createPet');
    expect(r.stdout).toMatch(/5 tools, 4 skipped \(4 write-disabled\)/);
    const w = await run(['list', petstorePath, '--allow-write', '--exclude', 'tag:admin', '--include', '*Pet*']);
    expect(w.stdout).toContain('createPet');
    expect(w.stdout).not.toContain('deletePet');
  });

  it('fails clearly on bad input', async () => {
    expect((await run(['bogus', petstorePath])).stderr).toContain('Unknown command');
    expect((await run(['serve'])).stderr).toContain('Missing <spec>');
    expect((await run(['list', 'nope.yaml'])).stderr).toContain('Cannot read spec file');
    expect((await run(['list', petstorePath, '--timeout', 'abc'])).stderr).toContain('positive integer');
    expect((await run(['list', petstorePath, '--header-env', 'broken'])).stderr).toContain('HEADER=VAR');
    expect((await run(['list', petstorePath, '--nonsense'])).code).toBe(1);
    expect((await run(['list', petstorePath, '--include', 'zzz'])).stdout).toContain('0 tools');
    const empty = await run(['serve', petstorePath, '--include', 'zzz']);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain('No operations left');
    expect((await run(['generate', petstorePath])).stderr).toContain('-o <dir>');
  });

  it('accepts every option together', async () => {
    const r = await run([
      'list', petstorePath, '--base-url', 'http://localhost:1/v1', '--allow-host', 'localhost:1',
      '--bearer-env', 'T', '--header-env', 'X-A=A', '--timeout', '1000', '--max-response', '10',
    ]);
    expect(r.code).toBe(0);
  });

  it('generates a standalone project', async () => {
    const out = path.join(tmp, 'gen');
    const r = await run(['generate', petstorePath, '-o', out, '--allow-write']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Generated 6 files');
    for (const f of ['server.mjs', 'runtime.js', 'mcp.js', 'tools.json', 'package.json', 'README.md']) {
      expect(existsSync(path.join(out, f))).toBe(true);
    }
    const pkg = JSON.parse(readFileSync(path.join(out, 'package.json'), 'utf8')) as { name: string; dependencies: object };
    expect(pkg.name).toBe('petstore-mcp');
    expect(pkg.dependencies).toHaveProperty('@modelcontextprotocol/sdk');
    const tools = JSON.parse(readFileSync(path.join(out, 'tools.json'), 'utf8')) as { tools: unknown[]; config: { allowWrite: boolean } };
    expect(tools.tools.length).toBeGreaterThan(5);
    expect(tools.config.allowWrite).toBe(true);
    expect(readFileSync(path.join(out, 'README.md'), 'utf8')).toContain('Write operations: enabled');
  });

  it('serves over the given transport', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '1' });
    const r = await Promise.all([
      main(['serve', petstorePath], {
        stdout: { write: () => true }, stderr: { write: () => true }, env: {}, transport: a,
      }),
      client.connect(b),
    ]);
    expect(r[0]).toBe(0);
    await client.close();
  });

  it('fails to serve when a required variable is missing', async () => {
    const r = await run(['serve', petstorePath, '--bearer-env', 'NOT_SET_ANYWHERE']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('NOT_SET_ANYWHERE is not set');
  });
});
