import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { generateProject } from '../src/generate.js';
import { buildManifest } from '../src/operations.js';
import { createExecutor, type Manifest, type ParamSpec } from '../src/runtime.js';
import { deref } from '../src/schema.js';
import { parseSpec } from '../src/spec.js';
import { petstorePath, root } from './helpers.js';

function manifest(): Manifest {
  return {
    config: {
      baseUrl: 'https://api.example.test/v1', allowedHosts: ['api.example.test'],
      allowWrite: true, headerEnv: {}, timeoutMs: 1000, maxResponseBytes: 1000,
    },
    tools: [{
      name: 'example', method: 'get', path: '/items/{id}', write: false,
      description: 'Synthetic operation', inputSchema: { type: 'object' },
      params: [{ name: 'id', arg: 'id', in: 'path', required: true }],
    }],
  };
}

describe('configuration validation', () => {
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 2_147_483_648])('rejects invalid timeout %s', (timeoutMs) => {
    const m = manifest();
    m.config.timeoutMs = timeoutMs;
    expect(() => createExecutor(m)).toThrow(/timeoutMs/);
  });

  it.each([0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects invalid response limit %s', (maxResponseBytes) => {
    const m = manifest();
    m.config.maxResponseBytes = maxResponseBytes;
    expect(() => createExecutor(m)).toThrow(/maxResponseBytes/);
  });

  it.each(['https://api.example.test/?x=1', 'https://api.example.test/#fragment'])('rejects ambiguous base URL %s', (baseUrl) => {
    const m = manifest();
    m.config.baseUrl = baseUrl;
    expect(() => createExecutor(m)).toThrow(/query string or fragment/);
  });

  it('validates environment header names and variable identifiers', () => {
    const m = manifest();
    m.config.headerEnv = { 'Invalid Header': 'HEADER_VALUE' };
    expect(() => createExecutor(m)).toThrow(/header name/);
    m.config.headerEnv = { 'X-Test': 'not a variable' };
    expect(() => createExecutor(m)).toThrow(/valid identifiers/);
  });

  it('rejects unsafe runtime URL overrides before reading credentials', () => {
    expect(() => createExecutor(manifest(), { env: { OPENAPI_MCP_BASE_URL: 'https://api.example.test/#x' } })).toThrow(/fragment/);
  });

  it('reports malformed base URLs without echoing their contents', () => {
    const m = manifest();
    m.config.baseUrl = 'invalid-placeholder';
    expect(() => createExecutor(m)).toThrow('Base URL must be a valid absolute HTTP(S) URL');
  });

  it('rejects empty credential variable names', () => {
    const spec = parseSpec('{"openapi":"3.1.0","paths":{}}');
    expect(() => buildManifest(spec, { baseUrl: 'https://api.example.test', bearerEnv: '' })).toThrow(/valid identifiers/);
  });

  it('supports bracketed IPv6 host allowlists with and without an explicit port', () => {
    const m = manifest();
    m.config.baseUrl = 'http://[::1]:1234/v1';
    m.config.allowedHosts = ['[::1]'];
    expect(createExecutor(m).baseUrl).toBe(m.config.baseUrl);
    m.config.allowedHosts = ['[::1]:4321'];
    expect(() => createExecutor(m)).toThrow(/allowed host/);
  });

  it('rejects credentials before persisting a generated manifest', () => {
    const spec = parseSpec('{"openapi":"3.1.0","paths":{}}');
    expect(() => buildManifest(spec, { baseUrl: 'https://user:placeholder@api.example.test' })).toThrow(/credentials/);
  });
});

describe('operation schemas', () => {
  it('keeps every argument when generated prefixes and body names collide', () => {
    const parameters = [
      { name: 'id', in: 'query' }, { name: 'id', in: 'header' },
      { name: 'query_id', in: 'query' }, { name: 'body', in: 'query' },
      { name: 'request_body', in: 'query' },
    ].map((p) => ({ ...p, schema: { type: 'string' } }));
    const spec = parseSpec(JSON.stringify({
      openapi: '3.1.0', servers: [{ url: 'https://api.example.test' }],
      paths: { '/items': { post: { parameters, requestBody: { content: { 'application/json': { schema: true } } } } } },
    }));
    const tool = buildManifest(spec, { allowWrite: true }).manifest.tools[0]!;
    expect(tool.params.map((p) => p.arg)).toEqual(['query_id', 'header_id', 'query_id_2', 'body', 'request_body']);
    expect(tool.body?.arg).toBe('request_body_2');
    expect(Object.keys(tool.inputSchema['properties'] as object)).toHaveLength(6);
  });

  it('preserves JSON media types and boolean schemas with descriptions', () => {
    const spec = parseSpec(JSON.stringify({
      openapi: '3.1.0', servers: [{ url: 'https://api.example.test' }],
      paths: { '/items': { post: {
        parameters: [{ name: 'flag', in: 'query', schema: false, description: 'Forbidden' }],
        requestBody: { description: 'Any JSON', content: { 'application/merge-patch+json': { schema: true } } },
      } } },
    }));
    const tool = buildManifest(spec, { allowWrite: true }).manifest.tools[0]!;
    expect(tool.body?.contentType).toBe('application/merge-patch+json');
    expect(tool.inputSchema['properties']).toEqual({ flag: false, body: true });
  });

  it('does not resolve inherited properties through JSON pointers', () => {
    expect(() => deref({ $ref: '#/constructor' }, {})).toThrow(/Cannot resolve/);
    const expanded = deref(JSON.parse('{"__proto__":{"type":"string"}}'), {});
    expect(Object.hasOwn(expanded as object, '__proto__')).toBe(true);
  });
});

describe('executor regressions', () => {
  it.each([null, '', '.', '..', [], ['..'], {}].map((id) => ({ id })))('rejects invalid required path value $id without fetching', async ({ id }) => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await createExecutor(manifest(), { fetch: fetcher }).execute('example', { id });
    expect(result.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('ignores inherited input properties', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const args: unknown = Object.create({ id: 'inherited' });
    const result = await createExecutor(manifest(), { fetch: fetcher }).execute('example', args);
    expect(result.text).toContain('Missing required argument');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('blocks write methods even when a manifest has an incorrect hint', async () => {
    const m = manifest();
    m.config.allowWrite = false;
    m.tools[0]!.method = 'POST';
    const fetcher = vi.fn<typeof fetch>();
    expect((await createExecutor(m, { fetch: fetcher }).execute('example', { id: 1 })).isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a malformed manifest path that changes the request host', async () => {
    const m = manifest();
    m.config.baseUrl = 'https://api.example.test';
    m.tools[0]!.path = '.other.test/items';
    const fetcher = vi.fn<typeof fetch>();
    const result = await createExecutor(m, { fetch: fetcher }).execute('example', { id: 1 });
    expect(result.text).toContain('outside the allowed list');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports non-JSON request bodies without sending a request', async () => {
    const m = manifest();
    m.tools[0]!.method = 'post';
    m.tools[0]!.body = { arg: 'body', contentType: 'application/json', required: true };
    const fetcher = vi.fn<typeof fetch>();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const result = await createExecutor(m, { fetch: fetcher }).execute('example', { id: 1, body: circular });
    expect(result.text).toContain('JSON-compatible');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends array headers with commas and keeps empty successful responses', async () => {
    const m = manifest();
    m.tools[0]!.params.push({ name: 'X-Values', arg: 'values', in: 'header', required: false });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const result = await createExecutor(m, { fetch: fetcher }).execute('example', { id: 1, values: ['a', 'b'] });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-values': 'a,b' });
    expect(result).toEqual({ isError: false, text: 'HTTP 204' });
  });

  it('accepts omitted input for an operation without arguments', async () => {
    const m = manifest();
    m.tools[0]!.params = [];
    m.tools[0]!.path = '/health';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    expect((await createExecutor(m, { fetch: fetcher }).execute('example', undefined)).isError).toBe(false);
  });

  it('overrides credential headers without case-sensitive duplicates', async () => {
    const m = manifest();
    m.config.headerEnv = { 'X-TEST': 'TEST_VALUE' };
    m.tools[0]!.params.push({ name: 'x-test', arg: 'test', in: 'header', required: false });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    await createExecutor(m, { fetch: fetcher, env: { TEST_VALUE: ['demo', 'value'].join('-') } }).execute('example', { id: 1, test: 'other' });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-test': 'demo-value' });
    expect(Object.keys(fetcher.mock.calls[0]?.[1]?.headers ?? {})).not.toContain('X-TEST');
  });

  it.each([
    [{ in: 'path', explode: true }, { a: 'b c' }, '/v1/items/a=b%20c'],
    [{ in: 'path' }, { a: 2 }, '/v1/items/a,2'],
    [{ in: 'path' }, [1, 2], '/v1/items/1,2'],
    [{ in: 'query', style: 'spaceDelimited' }, [1, 2], '/v1/items?id=1%202'],
    [{ in: 'query', explode: false }, { a: 1 }, '/v1/items?id=a%2C1'],
    [{ in: 'query' }, { a: 1, b: true }, '/v1/items?a=1&b=true'],
  ] as const)('serializes supported parameter style %j', async (options, id, expected) => {
    const m = manifest();
    m.tools[0]!.path = options.in === 'path' ? '/items/{id}' : '/items';
    m.tools[0]!.params[0] = { name: 'id', arg: 'id', required: true, ...options } as ParamSpec;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    await createExecutor(m, { fetch: fetcher }).execute('example', { id });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`https://api.example.test${expected}`);
  });
});

describe('CLI and generator regressions', () => {
  const scratch = path.join(root, '.tmp-test', 'regressions');
  const temporary: string[] = [];
  afterAll(async () => {
    for (const dir of temporary) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing generated project', async () => {
    await mkdir(scratch, { recursive: true });
    const dir = await mkdtemp(path.join(scratch, 'generator-'));
    temporary.push(dir);
    await writeFile(path.join(dir, 'server.mjs'), '// user edits\n');
    await expect(generateProject(manifest(), dir)).rejects.toThrow(/Refusing to overwrite/);
    expect(await readFile(path.join(dir, 'server.mjs'), 'utf8')).toBe('// user edits\n');
    await expect(readFile(path.join(dir, 'tools.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects extra positional arguments instead of silently ignoring them', async () => {
    let stderr = '';
    const code = await main(['list', petstorePath, 'extra.yaml'], {
      stderr: { write: (s) => { stderr += s; } }, stdout: { write: () => true },
    });
    expect(code).toBe(1);
    expect(stderr).toContain('exactly one');
  });
});
