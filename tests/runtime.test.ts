import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createExecutor, type Executor } from '../src/runtime.js';
import { miniManifest, petstoreManifest, startFakeApi, type FakeApi } from './helpers.js';

let api: FakeApi;
beforeAll(async () => {
  api = await startFakeApi();
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  api.requests.length = 0;
});

async function petstore(options: Parameters<typeof petstoreManifest>[0] = {}, env: Record<string, string> = {}) {
  const { manifest } = await petstoreManifest({ baseUrl: `${api.url}/v1`, ...options });
  return createExecutor(manifest, { env });
}
async function mini(options: Parameters<typeof miniManifest>[0] = {}, env: Record<string, string> = {}) {
  const { manifest } = await miniManifest({ baseUrl: `${api.url}/api/`, ...options });
  return createExecutor(manifest, { env });
}
const last = () => api.requests[api.requests.length - 1]!;

describe('request building', () => {
  let ex: Executor;
  beforeAll(async () => {
    ex = await petstore();
  });

  it('sends a GET with path, query and header parameters', async () => {
    const r = await ex.execute('listPets', { limit: 5, status: 'sold', tags: ['a b', 'c'], 'X-Request-Id': 'r-1' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^HTTP 200/);
    expect(last().method).toBe('GET');
    expect(last().url).toBe('/v1/pets?limit=5&status=sold&tags=a%20b&tags=c');
    expect(last().headers['x-request-id']).toBe('r-1');
  });

  it('preserves JSON response text', async () => {
    const r = await ex.execute('getPet', { petId: 7 });
    expect(last().url).toBe('/v1/pets/7');
    expect(r.text).toContain('"method":"GET"');
  });

  it('encodes path values and rejects traversal', async () => {
    await ex.execute('listOwnerPets', { ownerId: 'a/b c' });
    expect(last().url).toBe('/v1/owners/a%2Fb%20c/pets');
    const bad = await ex.execute('listOwnerPets', { ownerId: '..' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Invalid value/);
  });

  it('serializes deepObject query parameters', async () => {
    await ex.execute('listOwnerPets', { ownerId: 'o1', filter: { species: 'cat', minAge: 2 } });
    expect(decodeURIComponent(last().url)).toBe('/v1/owners/o1/pets?filter[species]=cat&filter[minAge]=2');
  });

  it('reports missing required arguments and unknown tools', async () => {
    expect((await ex.execute('getPet', {})).text).toMatch(/Missing required argument "petId"/);
    expect((await ex.execute('nope', {})).text).toMatch(/Unknown tool/);
    expect((await ex.execute('health', null)).isError).toBe(true);
    expect(api.requests).toHaveLength(0);
  });

  it('turns HTTP errors into tool errors', async () => {
    const r = await ex.execute('getPet', { petId: 404 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('HTTP 404');
    expect(r.text).toContain('not found');
  });

  it('handles empty bodies', async () => {
    const { manifest } = await miniManifest({ baseUrl: `${api.url}/api`, include: ['big'] });
    manifest.tools[0]!.path = '/empty';
    const r = await createExecutor(manifest).execute('big', {});
    expect(r.text).toMatch(/^HTTP 204/);
  });
});

describe('array and style handling', () => {
  it('supports explode=false, pipeDelimited and null/undefined skipping', async () => {
    const ex = await mini();
    await ex.execute('list_items', { ids: [1, 2, 3], pipe: ['a', 'b'], query_id: null });
    expect(decodeURIComponent(last().url)).toBe('/api/items?ids=1,2,3&pipe=a|b');
  });

  it('sends header parameters, joining arrays', async () => {
    const ex = await mini();
    await ex.execute('list_items', { header_id: 'h1' });
    expect(last().headers['id']).toBe('h1');
  });

  it('rejects header values with line breaks', async () => {
    const ex = await mini();
    const r = await ex.execute('list_items', { header_id: 'a\r\nX-Evil: 1' });
    expect(r.isError).toBe(true);
  });
});

describe('request bodies and write protection', () => {
  it('sends JSON bodies when writes are allowed', async () => {
    const ex = await petstore({ allowWrite: true });
    const r = await ex.execute('createPet', { body: { name: 'Rex', status: 'available' } });
    expect(r.isError).toBe(false);
    expect(last().method).toBe('POST');
    expect(last().headers['content-type']).toBe('application/json');
    expect(JSON.parse(last().body)).toEqual({ name: 'Rex', status: 'available' });
  });

  it('sends form bodies, repeating array values', async () => {
    const ex = await petstore({ allowWrite: true });
    await ex.execute('login', { body: { user: 'u', password: 'p w', roles: ['a', 'b'], n: 1 } });
    expect(last().headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(last().body).toBe('user=u&password=p+w&roles=a&roles=b&n=1');
  });

  it('requires a body when the spec does', async () => {
    const ex = await petstore({ allowWrite: true });
    expect((await ex.execute('createPet', {})).text).toMatch(/Missing required argument "body"/);
  });

  it('sends DELETE only with allowWrite', async () => {
    const ex = await petstore({ allowWrite: true });
    await ex.execute('deletePet', { petId: 3 });
    expect(last().method).toBe('DELETE');
  });

  it('refuses write tools at call time even if the manifest contains them', async () => {
    const { manifest } = await petstoreManifest({ allowWrite: true, baseUrl: `${api.url}/v1` });
    manifest.config.allowWrite = false;
    const r = await createExecutor(manifest).execute('createPet', { body: { name: 'x' } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/write operations are disabled/);
    expect(api.requests).toHaveLength(0);
  });
});

describe('authentication from the environment', () => {
  it('sends a bearer token and custom headers, overriding model-supplied values', async () => {
    const ex = await petstore(
      { bearerEnv: 'PET_TOKEN', headerEnv: { 'X-Request-Id': 'PET_REQ' } },
      { PET_TOKEN: ['demo', 'token'].join('-'), PET_REQ: 'fixed' },
    );
    await ex.execute('listPets', { 'X-Request-Id': 'model-value' });
    expect(last().headers['authorization']).toBe(`Bearer ${['demo', 'token'].join('-')}`);
    expect(last().headers['x-request-id']).toBe('fixed');
  });

  it('fails at startup when a variable is missing or unsafe', async () => {
    await expect(petstore({ bearerEnv: 'MISSING_VAR' })).rejects.toThrow(/MISSING_VAR is not set/);
    await expect(petstore({ bearerEnv: 'BAD' }, { BAD: 'a\nb' })).rejects.toThrow(/forbidden/);
  });

  it('never echoes secrets in results', async () => {
    const demoToken = ['demo', 'secret'].join('-');
    const ex = await petstore({ bearerEnv: 'PET_TOKEN' }, { PET_TOKEN: demoToken });
    const r = await ex.execute('getPet', { petId: 1 });
    expect(r.text).not.toContain(demoToken);
  });
});

describe('network safety', () => {
  it('rejects a base URL outside the allowed hosts and bad URLs', async () => {
    const { manifest } = await petstoreManifest({ baseUrl: `${api.url}/v1` });
    manifest.config.allowedHosts = ['other.test'];
    expect(() => createExecutor(manifest)).toThrow(/not in the allowed host list/);
    manifest.config.allowedHosts = [api.host];
    manifest.config.baseUrl = 'ftp://127.0.0.1/x';
    expect(() => createExecutor(manifest)).toThrow(/http or https/);
    manifest.config.baseUrl = 'http://user:pw@127.0.0.1/x';
    expect(() => createExecutor(manifest)).toThrow(/credentials/);
  });

  it('allows a base URL override only within the allowlist', async () => {
    const { manifest } = await petstoreManifest({ baseUrl: 'http://127.0.0.1:1/v1', allowedHosts: [api.host, '127.0.0.1:1'] });
    const ex = createExecutor(manifest, { env: { OPENAPI_MCP_BASE_URL: `${api.url}/v9` } });
    await ex.execute('getPet', { petId: 1 });
    expect(last().url).toBe('/v9/pets/1');
    expect(() => createExecutor(manifest, { env: { OPENAPI_MCP_BASE_URL: 'http://evil.test/' } })).toThrow(/allowed host/);
  });

  it('matches host-only allowlist entries on any port', async () => {
    const { manifest } = await petstoreManifest({ baseUrl: `${api.url}/v1`, allowedHosts: ['127.0.0.1'] });
    expect(createExecutor(manifest).baseUrl).toBe(`${api.url}/v1`);
  });

  it('does not follow redirects', async () => {
    const { manifest } = await miniManifest({ baseUrl: `${api.url}/api`, include: ['redirect'] });
    const r = await createExecutor(manifest).execute('redirect', {});
    expect(r.text).toContain('HTTP 302');
    expect(r.text).toContain('Redirect not followed: http://evil.example/steal');
    expect(api.requests).toHaveLength(1);
  });

  it('truncates large responses', async () => {
    const { manifest } = await miniManifest({ baseUrl: `${api.url}/api`, include: ['big'], maxResponseBytes: 100 });
    const r = await createExecutor(manifest).execute('big', {});
    expect(r.text).toContain('[response truncated at 100 bytes]');
    expect(r.text.length).toBeLessThan(250);
  });

  it('times out slow servers', async () => {
    const { manifest } = await miniManifest({ baseUrl: `${api.url}/api`, include: ['slow'], timeoutMs: 80 });
    const r = await createExecutor(manifest).execute('slow', {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/timed out after 80 ms/);
  });

  it('keeps plain text and invalid JSON as is', async () => {
    const { manifest } = await miniManifest({ baseUrl: `${api.url}/api`, include: ['text'] });
    const ex = createExecutor(manifest);
    expect((await ex.execute('text', {})).text).toBe('HTTP 200 OK\nhello');
    manifest.tools[0]!.path = '/broken-json';
    expect((await createExecutor(manifest).execute('text', {})).text).toContain('{not json');
  });

  it('reports connection failures', async () => {
    const { manifest } = await miniManifest({ baseUrl: 'http://127.0.0.1:1/api', include: ['text'] });
    const r = await createExecutor(manifest).execute('text', {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Request failed/);
  });

  it('detects unresolved path templates', async () => {
    const { manifest } = await petstoreManifest({ baseUrl: `${api.url}/v1`, include: ['getPet'] });
    manifest.tools[0]!.params = [];
    manifest.tools[0]!.inputSchema = { type: 'object' };
    const r = await createExecutor(manifest).execute('getPet', {});
    expect(r.text).toMatch(/Unresolved path parameter/);
  });
});
