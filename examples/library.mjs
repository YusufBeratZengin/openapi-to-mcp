import { loadSpec, buildManifest, createExecutor } from '../dist/index.js';

const spec = await loadSpec('examples/petstore.yaml');
const { manifest, skipped } = buildManifest(spec, { include: ['getPet'] });
console.log(manifest.tools.map((tool) => tool.name), skipped.length);
const executor = createExecutor(manifest, {
  env: {},
  fetch: async () => new Response('{"id":1,"name":"Rex"}', {
    headers: { 'Content-Type': 'application/json' },
  }),
});
console.log((await executor.execute('getPet', { petId: 1 })).text);
