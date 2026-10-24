// Runtime that turns a tool call into a real HTTP request.
// This file has no imports on purpose: `generate` copies the compiled
// output verbatim into the generated server.

export type JsonObject = Record<string, unknown>;

export interface ParamSpec {
  /** Parameter name as written in the OpenAPI document. */
  name: string;
  /** Property name in the tool input schema. */
  arg: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  style?: string;
  explode?: boolean;
}

export interface BodySpec {
  arg: string;
  contentType: string;
  required: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  method: string;
  path: string;
  params: ParamSpec[];
  body?: BodySpec;
  inputSchema: JsonObject;
  /** True for anything that is not GET or HEAD. */
  write: boolean;
}

export interface RuntimeConfig {
  baseUrl: string;
  allowedHosts: string[];
  allowWrite: boolean;
  /** Name of the environment variable that holds a bearer token. */
  bearerEnv?: string;
  /** Header name to environment variable name. */
  headerEnv: Record<string, string>;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface Manifest {
  tools: ToolSpec[];
  config: RuntimeConfig;
}

export interface ToolResult {
  isError: boolean;
  text: string;
}

export interface ExecutorDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

export interface Executor {
  baseUrl: string;
  execute(name: string, args: unknown): Promise<ToolResult>;
}

const FORBIDDEN_HEADER_VALUE = /[\r\n\0]/;

/** Validate persisted configuration before generating or running a server. */
export function validateConfig(config: RuntimeConfig): void {
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch {
    throw new Error('Base URL must be a valid absolute HTTP(S) URL');
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('Base URL must be http or https');
  }
  if (base.username || base.password) {
    throw new Error('Base URL must not contain credentials; use --bearer-env or --header-env');
  }
  if (base.search || base.hash) {
    throw new Error('Base URL must not contain a query string or fragment');
  }
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 2_147_483_647) {
    throw new Error('timeoutMs must be a positive integer no greater than 2147483647');
  }
  if (!Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes <= 0) {
    throw new Error('maxResponseBytes must be a positive safe integer');
  }
  for (const header of Object.keys(config.headerEnv)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header)) {
      throw new Error('Invalid environment header name');
    }
  }
  const variables = [...Object.values(config.headerEnv), ...(config.bearerEnv === undefined ? [] : [config.bearerEnv])];
  if (variables.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    throw new Error('Credential environment variable names must be valid identifiers');
  }
}

function fail(text: string): ToolResult {
  return { isError: true, text };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

function hostMatches(url: URL, allowed: string[]): boolean {
  return allowed.some((entry) => {
    const e = entry.toLowerCase();
    return e === url.host.toLowerCase() || e === url.hostname.toLowerCase();
  });
}

function pathValue(param: ParamSpec, value: unknown): string {
  if (Array.isArray(value)) {
    const encoded = value.map((v) => encodeURIComponent(scalar(v))).join(',');
    if (encoded === '' || encoded === '.' || encoded === '..') {
      throw new Error(`Invalid value for path parameter "${param.name}"`);
    }
    return encoded;
  }
  if (isObject(value)) {
    const sep = param.explode ? '=' : ',';
    const encoded = Object.entries(value)
      .map(([k, v]) => `${encodeURIComponent(k)}${sep}${encodeURIComponent(scalar(v))}`)
      .join(',');
    if (encoded === '') {
      throw new Error(`Invalid value for path parameter "${param.name}"`);
    }
    return encoded;
  }
  const text = scalar(value);
  if (text === '.' || text === '..' || text === '') {
    throw new Error(`Invalid value for path parameter "${param.name}"`);
  }
  return encodeURIComponent(text);
}

function queryPairs(param: ParamSpec, value: unknown): string[] {
  const key = param.name;
  const style = param.style ?? 'form';
  const explode = param.explode ?? style === 'form';
  const pair = (k: string, v: unknown): string =>
    `${encodeURIComponent(k)}=${encodeURIComponent(scalar(v))}`;
  if (Array.isArray(value)) {
    if (explode && style === 'form') {
      return value.map((v) => pair(key, v));
    }
    const sep = style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ',';
    return [pair(key, value.map((v) => scalar(v)).join(sep))];
  }
  if (isObject(value)) {
    if (style === 'deepObject') {
      return Object.entries(value).map(([k, v]) => pair(`${key}[${k}]`, v));
    }
    if (explode) {
      return Object.entries(value).map(([k, v]) => pair(k, v));
    }
    return [pair(key, Object.entries(value).map(([k, v]) => `${k},${scalar(v)}`).join(','))];
  }
  return [pair(key, value)];
}

async function readLimited(
  res: Response,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) {
    return { text: '', truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(buf), truncated };
}

export function createExecutor(manifest: Manifest, deps: ExecutorDeps = {}): Executor {
  const env = deps.env ?? (typeof process !== 'undefined' ? process.env : {});
  const doFetch = deps.fetch ?? fetch;
  const { config } = manifest;

  validateConfig(config);

  const override = env['OPENAPI_MCP_BASE_URL'];
  if (override) {
    validateConfig({ ...config, baseUrl: override });
  }
  const base = new URL(override ? override : config.baseUrl);
  if (!hostMatches(base, config.allowedHosts)) {
    throw new Error(`Base URL host "${base.host}" is not in the allowed host list`);
  }
  const basePath = base.pathname.replace(/\/+$/, '');

  const authHeaders: Record<string, string> = Object.create(null) as Record<string, string>;
  const readEnv = (header: string, varName: string): string => {
    const value = env[varName];
    if (value === undefined || value === '') {
      throw new Error(`Environment variable ${varName} is not set (needed for header "${header}")`);
    }
    if (FORBIDDEN_HEADER_VALUE.test(value)) {
      throw new Error(`Environment variable ${varName} contains forbidden characters`);
    }
    return value;
  };
  if (config.bearerEnv) {
    authHeaders['authorization'] = `Bearer ${readEnv('Authorization', config.bearerEnv)}`;
  }
  for (const [header, varName] of Object.entries(config.headerEnv)) {
    authHeaders[header.toLowerCase()] = readEnv(header, varName);
  }

  const tools = new Map(manifest.tools.map((t) => [t.name, t]));

  async function execute(name: string, rawArgs: unknown): Promise<ToolResult> {
    const tool = tools.get(name);
    if (!tool) {
      return fail(`Unknown tool "${name}"`);
    }
    if ((tool.write || !['get', 'head'].includes(tool.method.toLowerCase())) && !config.allowWrite) {
      return fail(
        `Tool "${name}" uses ${tool.method.toUpperCase()}; write operations are disabled (enable with --allow-write)`,
      );
    }
    const args = Object.assign(Object.create(null) as JsonObject, isObject(rawArgs) ? rawArgs : {});
    for (const p of tool.params) {
      if (p.required && (args[p.arg] === undefined || args[p.arg] === null)) {
        return fail(`Missing required argument "${p.arg}"`);
      }
    }
    if (tool.body?.required && args[tool.body.arg] === undefined) {
      return fail(`Missing required argument "${tool.body.arg}"`);
    }

    let path = tool.path;
    const query: string[] = [];
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
    };
    try {
      for (const p of tool.params) {
        const value = args[p.arg];
        if (value === undefined || value === null) {
          continue;
        }
        if (p.in === 'path') {
          path = path.split(`{${p.name}}`).join(pathValue(p, value));
        } else if (p.in === 'query') {
          query.push(...queryPairs(p, value));
        } else {
          const text = Array.isArray(value) ? value.map(scalar).join(',')
            : isObject(value) ? Object.entries(value)
              .map(([k, v]) => `${k}${p.explode ? '=' : ','}${scalar(v)}`).join(',')
              : scalar(value);
          if (FORBIDDEN_HEADER_VALUE.test(text)) {
            throw new Error(`Invalid value for header "${p.name}"`);
          }
          headers[p.name.toLowerCase()] = text;
        }
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    if (/\{[^}]+\}/.test(path)) {
      return fail('Unresolved path parameter in URL template');
    }

    let body: string | undefined;
    const bodyValue = tool.body ? args[tool.body.arg] : undefined;
    try {
      if (tool.body && bodyValue !== undefined) {
        headers['Content-Type'] = tool.body.contentType;
        if (tool.body.contentType === 'application/x-www-form-urlencoded') {
          const form = new URLSearchParams();
          if (isObject(bodyValue)) {
            for (const [k, v] of Object.entries(bodyValue)) {
              if (Array.isArray(v)) {
                v.forEach((item) => form.append(k, scalar(item)));
              } else {
                form.append(k, scalar(v));
              }
            }
          }
          body = form.toString();
        } else {
          body = JSON.stringify(bodyValue);
        }
      }
    } catch {
      return fail('Cannot serialize request body; provide JSON-compatible input');
    }
    Object.assign(headers, authHeaders);

    const url = new URL(
      `${base.origin}${basePath}${path}${query.length > 0 ? `?${query.join('&')}` : ''}`,
    );
    if (url.host !== base.host || !hostMatches(url, config.allowedHosts)) {
      return fail('Refusing request to a host outside the allowed list');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await doFetch(url, {
        method: tool.method.toUpperCase(),
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
      const { text, truncated } = await readLimited(res, config.maxResponseBytes);
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      const lines = [`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`];
      if (location) {
        lines.push(`Redirect not followed: ${location}`);
      }
      if (text) {
        lines.push(text);
      }
      if (truncated) {
        lines.push(`[response truncated at ${config.maxResponseBytes} bytes]`);
      }
      return { isError: res.status >= 400, text: lines.join('\n') };
    } catch (error) {
      if (controller.signal.aborted) {
        return fail(`Request timed out after ${config.timeoutMs} ms`);
      }
      return fail(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return { baseUrl: base.href, execute };
}
