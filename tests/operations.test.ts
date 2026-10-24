import { describe, expect, it } from 'vitest';
import { matchesPattern } from '../src/operations.js';
import { miniManifest, petstoreManifest } from './helpers.js';

const names = (m: { manifest: { tools: { name: string }[] } }) => m.manifest.tools.map((t) => t.name);

describe('buildManifest on the petstore', () => {
  it('exposes only read operations by default', async () => {
    const r = await petstoreManifest();
    expect(names(r)).toEqual(['listPets', 'getPet', 'listOwnerPets', 'listCategories', 'get_health']);
    expect(r.skipped.filter((s) => s.reason === 'write-disabled')).toHaveLength(4);
    expect(r.manifest.tools.every((t) => !t.write)).toBe(true);
  });

  it('adds write operations with allowWrite', async () => {
    const r = await petstoreManifest({ allowWrite: true });
    expect(names(r)).toEqual(
      expect.arrayContaining(['createPet', 'updatePet', 'deletePet', 'login']),
    );
    expect(r.manifest.config.allowWrite).toBe(true);
  });

  it('defaults base URL and host allowlist from the spec', async () => {
    const { config } = (await petstoreManifest()).manifest;
    expect(config.baseUrl).toBe('https://petstore.example.com/v1');
    expect(config.allowedHosts).toEqual(['petstore.example.com']);
    const custom = (await petstoreManifest({ baseUrl: 'http://localhost:1/x', allowedHosts: ['a.test'] })).manifest.config;
    expect(custom.baseUrl).toBe('http://localhost:1/x');
    expect(custom.allowedHosts).toEqual(['a.test']);
  });

  it('builds a JSON Schema input from query, header and path parameters', async () => {
    const { manifest } = await petstoreManifest();
    const list = manifest.tools.find((t) => t.name === 'listPets')!;
    expect(list.inputSchema).toEqual({
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Maximum number of pets to return' },
        status: { type: 'string', enum: ['available', 'pending', 'sold'] },
        tags: { type: 'array', items: { type: 'string' } },
        'X-Request-Id': { type: 'string' },
      },
      additionalProperties: false,
    });
    expect(list.description).toContain('GET /pets');
    // Authorization is never a tool argument.
    expect(list.params.map((p) => p.name)).not.toContain('Authorization');
  });

  it('merges path-level parameters resolved through $ref', async () => {
    const get = (await petstoreManifest()).manifest.tools.find((t) => t.name === 'getPet')!;
    expect(get.inputSchema).toMatchObject({
      properties: { petId: { type: 'integer', description: 'Numeric pet id' } },
      required: ['petId'],
    });
  });

  it('builds request bodies, dropping readOnly fields and converting 3.0 keywords', async () => {
    const { manifest } = await petstoreManifest({ allowWrite: true });
    const create = manifest.tools.find((t) => t.name === 'createPet')!;
    expect(create.body).toEqual({ arg: 'body', contentType: 'application/json', required: true });
    expect(create.inputSchema).toMatchObject({
      required: ['body'],
      properties: {
        body: {
          required: ['name'],
          properties: {
            name: { type: 'string' },
            nickname: { type: ['string', 'null'] },
            weight: { type: 'number', exclusiveMinimum: 0 },
          },
        },
      },
    });
    const props = (create.inputSchema as { properties: { body: { properties: object } } }).properties.body.properties;
    expect(props).not.toHaveProperty('id');
    expect(manifest.tools.find((t) => t.name === 'login')!.body?.contentType).toBe('application/x-www-form-urlencoded');
    expect(manifest.tools.find((t) => t.name === 'updatePet')!.body?.required).toBe(false);
  });

  it('expands recursive schemas without looping', async () => {
    const { manifest } = await petstoreManifest();
    expect(JSON.stringify(manifest)).toBeTruthy();
  });
});

describe('filters', () => {
  it('include and exclude by operationId, tag, METHOD /path and wildcard', async () => {
    expect(names(await petstoreManifest({ include: ['getPet'] }))).toEqual(['getPet']);
    expect(names(await petstoreManifest({ include: ['tag:pets'] }))).toEqual(['listPets', 'getPet']);
    expect(names(await petstoreManifest({ include: ['get /owners/*'] }))).toEqual(['listOwnerPets']);
    expect(names(await petstoreManifest({ include: ['list*'], exclude: ['listCategories'] }))).toEqual([
      'listPets',
      'listOwnerPets',
    ]);
    const r = await petstoreManifest({ allowWrite: true, exclude: ['tag:admin'] });
    expect(names(r)).not.toContain('deletePet');
    expect(names(r)).not.toContain('login');
    expect(r.skipped.map((s) => s.reason)).toContain('excluded');
  });

  it('matchesPattern is case-insensitive and anchored', () => {
    expect(matchesPattern('GETPET', ['getPet'])).toBe(true);
    expect(matchesPattern('get', ['getPet'])).toBe(false);
    expect(matchesPattern('a.c', ['abc'])).toBe(false);
  });
});

describe('buildManifest edge cases (3.1 document)', () => {
  it('sanitizes and de-duplicates names, renames clashing arguments', async () => {
    const r = await miniManifest({ allowWrite: true, baseUrl: 'http://127.0.0.1:9/api' });
    expect(names(r)).toContain('list_items');
    expect(names(r)).toContain('list_items_2');
    const list = r.manifest.tools.find((t) => t.name === 'list_items')!;
    expect(Object.keys((list.inputSchema as { properties: object }).properties)).toEqual(
      expect.arrayContaining(['query_id', 'header_id', 'ids', 'pipe']),
    );
    const post = r.manifest.tools.find((t) => t.method === 'post' && t.path === '/items')!;
    expect(post.name).toBe('post_items');
    expect(post.body).toEqual({ arg: 'request_body', contentType: 'application/vnd.api+json', required: true });
    expect(post.inputSchema).toMatchObject({ properties: { request_body: { description: 'The item' } } });
  });

  it('skips operations whose body type is unsupported', async () => {
    const r = await miniManifest({ allowWrite: true });
    expect(names(r)).not.toContain('upload');
    expect(r.skipped).toContainEqual({ operation: 'POST /upload', reason: 'unsupported-body' });
  });

  it('hides headers that are filled from the environment', async () => {
    const r = await miniManifest({ headerEnv: { 'x-api-key': 'KEY' } });
    const who = r.manifest.tools.find((t) => t.name === 'whoami')!;
    expect(who.params).toEqual([]);
    const open = await miniManifest();
    expect(open.manifest.tools.find((t) => t.name === 'whoami')!.params).toHaveLength(1);
  });

  it('marks not-included operations', async () => {
    const r = await miniManifest({ include: ['whoami'] });
    expect(names(r)).toEqual(['whoami']);
    expect(r.skipped.some((s) => s.reason === 'not-included')).toBe(true);
  });
});
