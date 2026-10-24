import type { JsonObject } from './runtime.js';

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_NODES = 200_000;
const DATA_KEYS = new Set(['example', 'default', 'enum', 'const', 'value']);
// Entries of these maps are named objects, not keywords or Reference Objects.
const OBJECT_MAPS = new Set([
  'properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas',
  'schemas', 'responses', 'headers', 'content', 'paths', 'callbacks', 'links',
  'requestBodies', 'securitySchemes', 'encoding', 'variables', 'examples',
]);

/** Inline local `$ref` outside literal data. Circular references become an open schema. */
export function deref(node: unknown, root: JsonObject): unknown {
  let count = 0;

  const lookup = (ref: string): unknown => {
    if (!ref.startsWith('#/')) {
      throw new Error(`Only local $ref values are supported, got "${ref}"`);
    }
    let cur: unknown = root;
    for (const raw of ref.slice(2).split('/')) {
      const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      if (!isObject(cur) && !Array.isArray(cur)) {
        throw new Error(`Cannot resolve $ref "${ref}"`);
      }
      if (!Object.hasOwn(cur, key)) {
        throw new Error(`Cannot resolve $ref "${ref}"`);
      }
      cur = (cur as Record<string, unknown>)[key];
      if (cur === undefined) {
        throw new Error(`Cannot resolve $ref "${ref}"`);
      }
    }
    return cur;
  };

  const walk = (value: unknown, stack: string[], isMap = false): unknown => {
    if (++count > MAX_NODES) {
      throw new Error('Spec expands to too many nodes while resolving $ref');
    }
    if (Array.isArray(value)) {
      return value.map((v) => walk(v, stack));
    }
    if (!isObject(value)) {
      return value;
    }
    const ref = value['$ref'];
    if (!isMap && typeof ref === 'string') {
      const { $ref: _ignored, ...siblings } = value;
      void _ignored;
      if (stack.includes(ref)) {
        return { description: 'Recursive reference (not expanded)' };
      }
      const target = walk(lookup(ref), [...stack, ref]);
      const extra = walk(siblings, stack);
      return isObject(target) ? { ...target, ...(extra as JsonObject) } : target;
    }
    const out: JsonObject = Object.create(null) as JsonObject;
    for (const [k, v] of Object.entries(value)) {
      if (!isMap && (DATA_KEYS.has(k) || (k === 'examples' && Array.isArray(v)))) {
        out[k] = v;
      } else {
        out[k] = walk(v, stack, !isMap && OBJECT_MAPS.has(k));
      }
    }
    return out;
  };

  return walk(node, []);
}

const DROPPED = new Set(['example', 'xml', 'externalDocs', 'discriminator']);
const SCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions'];
const SCHEMA_LISTS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const SCHEMA_SINGLE = ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'contains'];

/** Convert an OpenAPI 3.0/3.1 schema object into plain JSON Schema. */
export function convertSchema(schema: unknown, forRequest = false): unknown {
  if (!isObject(schema)) {
    return schema;
  }
  const out: JsonObject = Object.create(null) as JsonObject;
  for (const [k, v] of Object.entries(schema)) {
    if (DROPPED.has(k)) {
      continue;
    }
    if (SCHEMA_MAPS.includes(k) && isObject(v)) {
      const mapped: JsonObject = Object.create(null) as JsonObject;
      for (const [name, sub] of Object.entries(v)) {
        mapped[name] = convertSchema(sub, forRequest);
      }
      out[k] = mapped;
    } else if (SCHEMA_LISTS.includes(k) && Array.isArray(v)) {
      out[k] = v.map((sub) => convertSchema(sub, forRequest));
    } else if (SCHEMA_SINGLE.includes(k)) {
      out[k] = convertSchema(v, forRequest);
    } else {
      out[k] = v;
    }
  }

  if (out['nullable'] === true) {
    if (typeof out['type'] === 'string') {
      out['type'] = [out['type'], 'null'];
    }
    if (Array.isArray(out['enum']) && !out['enum'].includes(null)) {
      out['enum'] = [...out['enum'], null];
    }
  }
  delete out['nullable'];

  for (const [flag, bound] of [
    ['exclusiveMinimum', 'minimum'],
    ['exclusiveMaximum', 'maximum'],
  ] as const) {
    if (out[flag] === true && typeof out[bound] === 'number') {
      out[flag] = out[bound];
      delete out[bound];
    } else if (out[flag] === false) {
      delete out[flag];
    }
  }

  if (forRequest && isObject(out['properties'])) {
    const props = out['properties'];
    const dropped = Object.keys(props).filter((n) => isObject(props[n]) && props[n]['readOnly'] === true);
    for (const name of dropped) {
      delete props[name];
    }
    if (Array.isArray(out['required'])) {
      out['required'] = out['required'].filter((n) => !dropped.includes(n as string));
    }
  }
  return out;
}
