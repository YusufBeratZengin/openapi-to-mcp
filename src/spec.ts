import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { JsonObject } from './runtime.js';

export type OpenApiDocument = JsonObject & { openapi: string; paths: JsonObject };

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse an OpenAPI 3.0 / 3.1 document from JSON or YAML text. */
export function parseSpec(text: string): OpenApiDocument {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (error) {
    throw new Error(`Cannot parse spec: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!isObject(doc)) {
    throw new Error('Spec must be a JSON or YAML object');
  }
  const version = doc['openapi'];
  if (typeof version !== 'string' || !/^3\.[01]\./.test(version)) {
    throw new Error(
      `Unsupported or missing "openapi" version (${String(version)}); only 3.0.x and 3.1.x are supported`,
    );
  }
  if (!isObject(doc['paths'])) {
    throw new Error('Spec has no "paths" object');
  }
  return doc as OpenApiDocument;
}

export async function loadSpec(file: string): Promise<OpenApiDocument> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read spec file "${file}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return parseSpec(text);
}

/** Pick the base URL: explicit override first, then `servers[0]` with variable defaults. */
export function resolveBaseUrl(spec: OpenApiDocument, override?: string): string {
  if (override) {
    return override;
  }
  const servers = spec['servers'];
  const first = Array.isArray(servers) ? (servers[0] as unknown) : undefined;
  if (!isObject(first) || typeof first['url'] !== 'string') {
    throw new Error('Spec has no servers entry; pass --base-url');
  }
  let url = first['url'];
  const vars = isObject(first['variables']) ? first['variables'] : {};
  url = url.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const v = vars[name];
    if (isObject(v) && (typeof v['default'] === 'string' || typeof v['default'] === 'number')) {
      return String(v['default']);
    }
    throw new Error(`Server URL variable "${name}" has no default; pass --base-url`);
  });
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Server URL "${url}" is not absolute; pass --base-url`);
  }
  return url;
}
