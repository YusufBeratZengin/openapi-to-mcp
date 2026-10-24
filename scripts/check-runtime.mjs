// Compatibility check for the compiled public API with production dependencies.
// CI runs this on Node 20, independently of the newer Vitest development engine.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadSpec, buildManifest, createMcpServer } from '../dist/index.js';

const spec = await loadSpec('examples/petstore.yaml');
const { manifest } = buildManifest(spec, { include: ['getPet'] });
const server = createMcpServer(manifest, {
  env: {},
  fetch: async (url) => {
    assert.equal(String(url), 'https://petstore.example.com/v1/pets/1');
    return new Response('{"id":1}', { headers: { 'Content-Type': 'application/json' } });
  },
});
const client = new Client({ name: 'runtime-check', version: '1.0.0' });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['getPet']);
  const response = await client.callTool({ name: 'getPet', arguments: { petId: 1 } });
  assert.equal(response.isError, false);
  assert.match(response.content[0].text, /"id":\s*1/);
  const missing = await client.callTool({ name: 'getPet', arguments: {} });
  assert.equal(missing.isError, true);
} finally {
  await client.close();
  await server.close();
}
console.log('Compiled API and MCP handshake passed.');
