import { describe, expect, it } from 'vitest';
import { loadSpec, parseSpec, resolveBaseUrl } from '../src/spec.js';
import { petstorePath } from './helpers.js';

describe('parseSpec', () => {
  it('reads YAML and JSON', () => {
    expect(parseSpec('openapi: 3.0.1\npaths: {}\n').openapi).toBe('3.0.1');
    expect(parseSpec('{"openapi":"3.1.0","paths":{}}').openapi).toBe('3.1.0');
  });

  it('rejects other versions, missing paths and non-objects', () => {
    expect(() => parseSpec('swagger: "2.0"\npaths: {}')).toThrow(/openapi/);
    expect(() => parseSpec('openapi: 4.0.0\npaths: {}')).toThrow(/Unsupported/);
    expect(() => parseSpec('openapi: 3.0.0')).toThrow(/paths/);
    expect(() => parseSpec('- a\n- b')).toThrow(/object/);
    expect(() => parseSpec('a: [unclosed')).toThrow(/Cannot parse/);
  });
});

describe('loadSpec', () => {
  it('loads the petstore example', async () => {
    const spec = await loadSpec(petstorePath);
    expect(Object.keys(spec.paths)).toContain('/pets/{petId}');
  });

  it('reports a missing file', async () => {
    await expect(loadSpec('does-not-exist.yaml')).rejects.toThrow(/Cannot read spec file/);
  });
});

describe('resolveBaseUrl', () => {
  const spec = (servers: unknown) => parseSpec(JSON.stringify({ openapi: '3.0.0', paths: {}, servers }));

  it('uses an override first', () => {
    expect(resolveBaseUrl(spec(undefined), 'http://x.test/api')).toBe('http://x.test/api');
  });

  it('fills server variables with their defaults', () => {
    const s = spec([{ url: 'https://{env}.example.com/v{ver}', variables: { env: { default: 'api' }, ver: { default: 2 } } }]);
    expect(resolveBaseUrl(s)).toBe('https://api.example.com/v2');
  });

  it('fails clearly when no usable server exists', () => {
    expect(() => resolveBaseUrl(spec(undefined))).toThrow(/--base-url/);
    expect(() => resolveBaseUrl(spec([{ url: '/relative' }]))).toThrow(/not absolute/);
    expect(() => resolveBaseUrl(spec([{ url: 'https://{x}.test' }]))).toThrow(/no default/);
  });
});
