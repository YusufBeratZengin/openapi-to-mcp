import { describe, expect, it } from 'vitest';
import { convertSchema, deref } from '../src/schema.js';

const root = {
  components: {
    schemas: {
      A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } },
      B: { type: 'string', description: 'bee' },
      Tree: { type: 'object', properties: { kids: { type: 'array', items: { $ref: '#/components/schemas/Tree' } } } },
      'a/b~c': { type: 'integer' },
    },
  },
};

describe('deref', () => {
  it('inlines nested local refs', () => {
    expect(deref({ $ref: '#/components/schemas/A' }, root)).toEqual({
      type: 'object',
      properties: { b: { type: 'string', description: 'bee' } },
    });
  });

  it('merges sibling keys and decodes JSON pointer escapes', () => {
    expect(deref({ $ref: '#/components/schemas/B', description: 'override' }, root)).toEqual({
      type: 'string',
      description: 'override',
    });
    expect(deref({ $ref: '#/components/schemas/a~1b~0c' }, root)).toEqual({ type: 'integer' });
  });

  it('stops at circular references', () => {
    const out = deref({ $ref: '#/components/schemas/Tree' }, root) as {
      properties: { kids: { items: { description: string } } };
    };
    expect(out.properties.kids.items.description).toMatch(/Recursive/);
  });

  it('rejects remote and unresolved refs', () => {
    expect(() => deref({ $ref: 'https://example.com/x.json' }, root)).toThrow(/local/);
    expect(() => deref({ $ref: '#/components/schemas/Nope' }, root)).toThrow(/Cannot resolve/);
    expect(() => deref({ $ref: '#/components/schemas/B/type/deeper' }, root)).toThrow(/Cannot resolve/);
  });

  it('refuses reference bombs', () => {
    const schemas: Record<string, unknown> = { s0: { type: 'string' } };
    for (let i = 1; i < 30; i++) {
      schemas[`s${i}`] = { a: { $ref: `#/s${i - 1}` }, b: { $ref: `#/s${i - 1}` } };
    }
    const bomb: Record<string, unknown> = { ...schemas };
    expect(() => deref({ $ref: '#/s29' }, bomb)).toThrow(/too many nodes/);
  });
});

describe('convertSchema', () => {
  it('turns nullable into a type union and drops OpenAPI-only keys', () => {
    expect(convertSchema({ type: 'string', nullable: true, example: 'x', xml: {}, enum: ['a'] })).toEqual({
      type: ['string', 'null'],
      enum: ['a', null],
    });
  });

  it('rewrites boolean exclusive bounds', () => {
    expect(convertSchema({ type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 5, exclusiveMaximum: false })).toEqual({
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 5,
    });
  });

  it('recurses into nested schemas and keeps boolean schemas', () => {
    const out = convertSchema({
      type: 'object',
      properties: { a: { type: 'string', nullable: true } },
      items: { type: 'integer', example: 1 },
      additionalProperties: false,
      oneOf: [{ type: 'string', example: 's' }],
    });
    expect(out).toEqual({
      type: 'object',
      properties: { a: { type: ['string', 'null'] } },
      items: { type: 'integer' },
      additionalProperties: false,
      oneOf: [{ type: 'string' }],
    });
    expect(convertSchema(true)).toBe(true);
  });

  it('removes readOnly properties from request bodies only', () => {
    const schema = {
      type: 'object',
      required: ['id', 'name'],
      properties: { id: { type: 'integer', readOnly: true }, name: { type: 'string' } },
    };
    expect(convertSchema(schema, true)).toEqual({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' } },
    });
    expect((convertSchema(schema) as { properties: object }).properties).toHaveProperty('id');
  });
});
