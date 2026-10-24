import { convertSchema, deref } from './schema.js';
import { resolveBaseUrl, type OpenApiDocument } from './spec.js';
import { validateConfig } from './runtime.js';
import type {
  BodySpec,
  JsonObject,
  Manifest,
  ParamSpec,
  RuntimeConfig,
  ToolSpec,
} from './runtime.js';

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'] as const;
const READ_METHODS = new Set(['get', 'head']);
const HIDDEN_HEADERS = new Set(['authorization', 'cookie', 'content-type', 'accept']);

export interface BuildOptions {
  baseUrl?: string;
  allowedHosts?: string[];
  allowWrite?: boolean;
  /** Keep only operations matching one of these patterns. */
  include?: string[];
  /** Drop operations matching one of these patterns. */
  exclude?: string[];
  bearerEnv?: string;
  /** Header name to environment variable name. */
  headerEnv?: Record<string, string>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface SkippedOperation {
  operation: string;
  reason: 'write-disabled' | 'excluded' | 'not-included' | 'unsupported-body';
}

export interface BuildResult {
  manifest: Manifest;
  skipped: SkippedOperation[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * A filter pattern matches the tool name, the operationId, `tag:<name>`,
 * or `METHOD /path`. `*` and `?` are wildcards.
 */
export function matchesPattern(pattern: string, keys: string[]): boolean {
  const re = globToRegExp(pattern.trim());
  return keys.some((k) => re.test(k));
}

function toolNameFor(method: string, path: string, operationId: unknown): string {
  let raw: string;
  if (typeof operationId === 'string' && operationId.trim() !== '') {
    raw = operationId;
  } else {
    const words = path.replace(/[{}]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
    raw = [method, ...words].join('_');
  }
  const cleaned = raw.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || method).slice(0, 64);
}

function describe(op: JsonObject, method: string, path: string): string {
  const parts: string[] = [];
  if (typeof op['summary'] === 'string' && op['summary'].trim()) {
    parts.push(op['summary'].trim());
  }
  if (typeof op['description'] === 'string' && op['description'].trim()) {
    const d = op['description'].trim();
    if (!parts.includes(d)) {
      parts.push(d);
    }
  }
  parts.push(`${method.toUpperCase()} ${path}`);
  return parts.join('\n\n');
}

function pickBody(content: unknown): { contentType: string; schema: unknown } | undefined {
  if (!isObject(content)) {
    return undefined;
  }
  const types = Object.keys(content);
  const json =
    types.find((t) => t.toLowerCase().split(';')[0]?.trim() === 'application/json') ??
    types.find((t) => /^application\/[\w.+-]*\+json$/i.test(t.split(';')[0]?.trim() ?? ''));
  if (json) {
    const media = content[json];
    return { contentType: json, schema: isObject(media) ? media['schema'] : undefined };
  }
  const form = types.find((t) => t.toLowerCase().startsWith('application/x-www-form-urlencoded'));
  if (form) {
    const media = content[form];
    return {
      contentType: 'application/x-www-form-urlencoded',
      schema: isObject(media) ? media['schema'] : undefined,
    };
  }
  return undefined;
}

/** Turn an OpenAPI document into an MCP tool manifest plus runtime config. */
export function buildManifest(spec: OpenApiDocument, options: BuildOptions = {}): BuildResult {
  const baseUrl = resolveBaseUrl(spec, options.baseUrl);
  const baseHost = new URL(baseUrl).host;
  const allowedHosts = options.allowedHosts && options.allowedHosts.length > 0
    ? options.allowedHosts
    : [baseHost];
  const headerEnv = options.headerEnv ?? {};
  const hidden = new Set([...HIDDEN_HEADERS, ...Object.keys(headerEnv).map((h) => h.toLowerCase())]);
  const allowWrite = options.allowWrite ?? false;

  const tools: ToolSpec[] = [];
  const skipped: SkippedOperation[] = [];
  const usedNames = new Set<string>();

  for (const [path, pathItemRaw] of Object.entries(spec.paths)) {
    const pathItem = deref(pathItemRaw, spec);
    if (!isObject(pathItem)) {
      continue;
    }
    for (const method of METHODS) {
      const op = pathItem[method];
      if (!isObject(op)) {
        continue;
      }
      const label = `${method.toUpperCase()} ${path}`;
      let name = toolNameFor(method, path, op['operationId']);
      for (let i = 2; usedNames.has(name); i++) {
        name = `${name.slice(0, 60)}_${i}`;
      }
      const tags = Array.isArray(op['tags']) ? op['tags'].map((t) => `tag:${String(t)}`) : [];
      const keys = [name, label, ...tags];
      if (typeof op['operationId'] === 'string') {
        keys.push(op['operationId']);
      }

      if (options.include && options.include.length > 0 && !options.include.some((p) => matchesPattern(p, keys))) {
        skipped.push({ operation: label, reason: 'not-included' });
        continue;
      }
      if (options.exclude?.some((p) => matchesPattern(p, keys))) {
        skipped.push({ operation: label, reason: 'excluded' });
        continue;
      }
      const write = !READ_METHODS.has(method);
      if (write && !allowWrite) {
        skipped.push({ operation: label, reason: 'write-disabled' });
        continue;
      }

      // Path-level parameters first, operation-level ones override by (name, in).
      const merged = new Map<string, JsonObject>();
      for (const list of [pathItem['parameters'], op['parameters']]) {
        if (!Array.isArray(list)) {
          continue;
        }
        for (const p of list) {
          if (isObject(p) && typeof p['name'] === 'string' && typeof p['in'] === 'string') {
            merged.set(`${p['in']}:${p['name']}`, p);
          }
        }
      }
      const raw = [...merged.values()].filter(
        (p) =>
          (p['in'] === 'path' || p['in'] === 'query' || p['in'] === 'header') &&
          !(p['in'] === 'header' && hidden.has(String(p['name']).toLowerCase())),
      );
      const counts = new Map<string, number>();
      for (const p of raw) {
        counts.set(String(p['name']), (counts.get(String(p['name'])) ?? 0) + 1);
      }

      const properties: JsonObject = Object.create(null) as JsonObject;
      const required: string[] = [];
      const params: ParamSpec[] = [];
      for (const p of raw) {
        const pname = String(p['name']);
        const location = p['in'] as ParamSpec['in'];
        const preferred = (counts.get(pname) ?? 0) > 1 ? `${location}_${pname}` : pname;
        let arg = preferred;
        for (let suffix = 2; Object.hasOwn(properties, arg); suffix++) {
          arg = `${preferred}_${suffix}`;
        }
        let schema: unknown = p['schema'];
        if (schema === undefined && isObject(p['content'])) {
          const first = Object.values(p['content'])[0];
          schema = isObject(first) ? first['schema'] : undefined;
        }
        const prop = convertSchema(schema ?? {});
        if (isObject(prop) && typeof p['description'] === 'string' && prop['description'] === undefined) {
          prop['description'] = p['description'];
        }
        properties[arg] = prop;
        const isRequired = location === 'path' || p['required'] === true;
        if (isRequired) {
          required.push(arg);
        }
        const spec: ParamSpec = { name: pname, arg, in: location, required: isRequired };
        if (typeof p['style'] === 'string') {
          spec.style = p['style'];
        }
        if (typeof p['explode'] === 'boolean') {
          spec.explode = p['explode'];
        }
        params.push(spec);
      }

      let body: BodySpec | undefined;
      const requestBody = op['requestBody'];
      if (isObject(requestBody) && write && method !== 'options') {
        const picked = pickBody(requestBody['content']);
        if (!picked) {
          skipped.push({ operation: label, reason: 'unsupported-body' });
          continue;
        }
        let arg = Object.hasOwn(properties, 'body') ? 'request_body' : 'body';
        for (let suffix = 2; Object.hasOwn(properties, arg); suffix++) {
          arg = `request_body_${suffix}`;
        }
        const bodySchema = convertSchema(picked.schema ?? {}, true);
        if (isObject(bodySchema) && typeof requestBody['description'] === 'string' && bodySchema['description'] === undefined) {
          bodySchema['description'] = requestBody['description'];
        }
        properties[arg] = bodySchema;
        const bodyRequired = requestBody['required'] === true;
        if (bodyRequired) {
          required.push(arg);
        }
        body = { arg, contentType: picked.contentType, required: bodyRequired };
      }

      usedNames.add(name);
      const tool: ToolSpec = {
        name,
        description: describe(op, method, path),
        method,
        path,
        params,
        inputSchema: {
          type: 'object',
          properties,
          ...(required.length > 0 ? { required } : {}),
          additionalProperties: false,
        },
        write,
      };
      if (body) {
        tool.body = body;
      }
      tools.push(tool);
    }
  }

  const config: RuntimeConfig = {
    baseUrl,
    allowedHosts,
    allowWrite,
    headerEnv,
    timeoutMs: options.timeoutMs ?? 30_000,
    maxResponseBytes: options.maxResponseBytes ?? 1_000_000,
  };
  if (options.bearerEnv !== undefined) {
    config.bearerEnv = options.bearerEnv;
  }
  validateConfig(config);
  return { manifest: { tools, config }, skipped };
}
