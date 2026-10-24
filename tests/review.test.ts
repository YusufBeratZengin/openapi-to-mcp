import { describe, expect, it, vi } from 'vitest';
import { buildManifest } from '../src/operations.js';
import { createExecutor } from '../src/runtime.js';
import { deref } from '../src/schema.js';
import { parseSpec } from '../src/spec.js';

function specWith(operation: object) {
  return parseSpec(JSON.stringify({
    openapi: '3.1.0', servers: [{ url: 'https://api.example.test' }],
    paths: { '/items': { get: { operationId: 'listItems', ...operation } } },
  }));
}

describe('review regressions', () => {
  it.each(['application/json', 'application/problem+json'])('preserves exact %s response text and number precision (#3)', async (contentType) => {
    const text = '{"id":9007199254740993,"small":1.234567890123456789,"huge":1e400}\n';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(text, {
      headers: { 'Content-Type': contentType },
    }));
    const { manifest } = buildManifest(specWith({}));
    expect(await createExecutor(manifest, { fetch: fetcher }).execute('listItems', {})).toEqual({
      isError: false, text: `HTTP 200\n${text}`,
    });
  });

  it('builds a manifest with literal $ref fields in response examples (#10)', () => {
    const spec = specWith({
      responses: { '200': { description: 'OK', content: { 'application/json': {
        example: { $ref: 'invoice-42' },
        examples: { invoice: { value: { $ref: 'invoice-43' } } },
      } } } },
    });
    expect(buildManifest(spec).manifest.tools).toHaveLength(1);
  });

  it('preserves literal schema data while resolving actual schemas and Example objects (#10)', () => {
    const literal = { $ref: '#/components/schemas/Item', nested: { $ref: 'invoice-42' } };
    const schema = {
      type: 'object', example: literal, default: literal, enum: [literal], const: literal,
      examples: [literal],
      properties: Object.fromEntries(['example', 'default', 'enum', 'const', 'examples', 'value', '$ref']
        .map((name) => [name, { $ref: '#/components/schemas/Item' }])),
    };
    const root = { components: {
      schemas: { Item: { type: 'string' } }, examples: { Invoice: { value: literal } },
    } };
    const out = deref({ schema, examples: { invoice: { $ref: '#/components/examples/Invoice' } } }, root);
    expect(out).toEqual({
      schema: { ...schema, properties: Object.fromEntries(Object.keys(schema.properties)
        .map((name) => [name, { type: 'string' }])) },
      examples: { invoice: { value: literal } },
    });
  });

  it.each([
    [undefined, 'role,admin,firstName,Alex'],
    [false, 'role,admin,firstName,Alex'],
    [true, 'role=admin,firstName=Alex'],
  ] as const)('serializes simple object headers with explode=%s (#11)', async (explode, expected) => {
    const spec = specWith({ parameters: [{
      name: 'X-Profile', in: 'header', style: 'simple',
      ...(explode === undefined ? {} : { explode }),
      schema: { type: 'object' },
    }] });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
    const { manifest } = buildManifest(spec);
    const result = await createExecutor(manifest, { fetch: fetcher }).execute('listItems', {
      'X-Profile': { role: 'admin', firstName: 'Alex' },
    });
    expect(result.isError).toBe(false);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-profile': expected });
  });

  it.each([{ 'bad\r\nname': 'value' }, { name: 'bad\r\nvalue' }])('rejects line breaks in serialized header objects (#11)', async (value) => {
    const { manifest } = buildManifest(specWith({ parameters: [{
      name: 'X-Profile', in: 'header', explode: true, schema: { type: 'object' },
    }] }));
    const fetcher = vi.fn<typeof fetch>();
    const result = await createExecutor(manifest, { fetch: fetcher }).execute('listItems', { 'X-Profile': value });
    expect(result.isError).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
