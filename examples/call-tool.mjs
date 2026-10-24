// Runnable example: start a tiny local "petstore" API, serve the spec over stdio
// with the built CLI, and call a tool through the official MCP client.
// Run `npm run build` first, then `node examples/call-tool.mjs`.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '..', 'dist', 'bin.js');
const spec = path.join(here, 'petstore.yaml');
const demoToken = ['demo', 'token'].join('-');

const api = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/v1/pets/1' && req.headers.authorization === `Bearer ${demoToken}`) {
    res.end(JSON.stringify({ id: 1, name: 'Rex', status: 'available' }));
  } else {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'unauthorized' }));
  }
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${api.address().port}/v1`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bin, 'serve', spec, '--base-url', baseUrl, '--bearer-env', 'PETSTORE_TOKEN'],
  env: { PETSTORE_TOKEN: demoToken },
  stderr: 'ignore',
});
const client = new Client({ name: 'example', version: '1.0.0' });
try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`tools: ${tools.map((t) => t.name).join(', ')}`);

  console.log('> getPet {"petId":1}');
  const ok = await client.callTool({ name: 'getPet', arguments: { petId: 1 } });
  console.log(ok.content[0].text);

  console.log('> createPet {"body":{"name":"Milo"}}');
  const blocked = await client.callTool({ name: 'createPet', arguments: { body: { name: 'Milo' } } });
  console.log(`isError=${blocked.isError}: ${blocked.content[0].text}`);

} finally {
  await client.close();
  api.closeAllConnections();
  await new Promise((resolve) => api.close(resolve));
}
