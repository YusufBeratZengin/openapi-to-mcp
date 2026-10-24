import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { petstorePath, root, startFakeApi, type FakeApi } from './helpers.js';

let api: FakeApi;
const scratch = path.join(root, '.tmp-test');
mkdirSync(scratch, { recursive: true });
const tmp = mkdtempSync(path.join(scratch, 'e2e-'));
const demoToken = ['demo', 'e2e', 'value'].join('-');

beforeAll(async () => {
  api = await startFakeApi();
});
afterAll(async () => {
  await api.close();
  rmSync(tmp, { recursive: true, force: true });
});

function text(result: unknown): string {
  const content = (result as { content: { text: string }[] }).content;
  return content.map((c) => c.text).join('\n');
}

describe('end to end over stdio', () => {
  it('"serve" turns tool calls into real HTTP requests', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(root, 'dist', 'bin.js'), 'serve', petstorePath,
        '--base-url', `${api.url}/v1`, '--bearer-env', 'PETSTORE_TOKEN',
      ],
      env: { PETSTORE_TOKEN: demoToken },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('listPets');
      expect(tools.map((t) => t.name)).not.toContain('createPet');

      const res = await client.callTool({ name: 'listPets', arguments: { limit: 3, status: 'sold' } });
      expect(res.isError).toBe(false);
      expect(text(res)).toContain('/v1/pets?limit=3&status=sold');
      const seen = api.requests.at(-1)!;
      expect(seen.headers['authorization']).toBe(`Bearer ${demoToken}`);

      const denied = await client.callTool({ name: 'createPet', arguments: { body: { name: 'x' } } });
      expect(denied.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('"generate" output runs as an independent MCP server', async () => {
    const out = path.join(tmp, 'generated');
    const code = await main(
      ['generate', petstorePath, '-o', out, '--base-url', `${api.url}/v1`, '--allow-write', '--exclude', 'tag:admin'],
      { stdout: { write: () => true }, stderr: { write: () => true }, env: {} },
    );
    expect(code).toBe(0);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(out, 'server.mjs')],
      cwd: out,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('createPet');
      expect(names).not.toContain('deletePet');
      const res = await client.callTool({ name: 'createPet', arguments: { body: { name: 'Milo' } } });
      expect(res.isError).toBe(false);
      const seen = api.requests.at(-1)!;
      expect(seen.method).toBe('POST');
      expect(seen.url).toBe('/v1/pets');
      expect(JSON.parse(seen.body)).toEqual({ name: 'Milo' });
    } finally {
      await client.close();
    }
  });
});
