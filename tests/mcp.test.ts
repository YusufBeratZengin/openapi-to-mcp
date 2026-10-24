import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp.js';
import { petstoreManifest, startFakeApi, type FakeApi } from './helpers.js';

let api: FakeApi;
beforeAll(async () => {
  api = await startFakeApi();
});
afterAll(async () => {
  await api.close();
});

async function connect(options: Parameters<typeof petstoreManifest>[0] = {}) {
  const { manifest } = await petstoreManifest({ baseUrl: `${api.url}/v1`, ...options });
  const server = createMcpServer(manifest, { env: {} }, { name: 'test', version: '9.9.9' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'client', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, server };
}

describe('MCP server', () => {
  it('lists tools with JSON Schema inputs and annotations', async () => {
    const { client } = await connect({ allowWrite: true });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('listPets');
    expect(names).toContain('deletePet');
    const get = tools.find((t) => t.name === 'getPet')!;
    expect(get.inputSchema.required).toEqual(['petId']);
    expect(get.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tools.find((t) => t.name === 'deletePet')!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
    expect(client.getServerVersion()).toMatchObject({ name: 'test', version: '9.9.9' });
    await client.close();
  });

  it('calls a tool end to end against the fake API', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'getPet', arguments: { petId: 12 } });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain('/v1/pets/12');
    expect(api.requests.at(-1)?.url).toBe('/v1/pets/12');
    await client.close();
  });

  it('returns tool errors instead of throwing', async () => {
    const { client } = await connect();
    const missing = await client.callTool({ name: 'getPet', arguments: {} });
    expect(missing.isError).toBe(true);
    const unknown = await client.callTool({ name: 'createPet', arguments: { body: { name: 'x' } } });
    expect(unknown.isError).toBe(true);
    const noArgs = await client.callTool({ name: 'get_health' });
    expect(noArgs.isError).toBe(false);
    await client.close();
  });
});
