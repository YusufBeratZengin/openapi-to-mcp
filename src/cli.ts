import { parseArgs } from 'node:util';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { generateProject, ownPackage } from './generate.js';
import { createMcpServer } from './mcp.js';
import { buildManifest, type BuildOptions } from './operations.js';
import { loadSpec } from './spec.js';

export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  env: Record<string, string | undefined>;
  /** Replaces the stdio transport (used by tests). */
  transport?: Transport;
}

const HELP = `openapi-to-mcp - turn an OpenAPI 3.x spec into MCP tools

Usage:
  openapi-to-mcp serve    <spec> [options]     run a stdio MCP server
  openapi-to-mcp generate <spec> -o <dir> [options]   write a standalone server project
  openapi-to-mcp list     <spec> [options]     show the tools that would be exposed

Options:
  --base-url <url>        API base URL (default: first entry of "servers")
  --allow-host <host>     allowed request host, repeatable (default: host of the base URL)
  --allow-write           expose other supported methods (default: GET/HEAD only)
  --include <pattern>     keep only matching operations, repeatable
  --exclude <pattern>     drop matching operations, repeatable
                          patterns match operationId, "tag:<name>" or "METHOD /path"; * is a wildcard
  --bearer-env <VAR>      send "Authorization: Bearer $VAR"
  --header-env <H=VAR>    send header H with the value of $VAR, repeatable
  --timeout <ms>          request timeout (default 30000)
  --max-response <bytes>  response size limit (default 1000000)
  -o, --out <dir>         output directory for "generate"
  -h, --help              show this help
  -v, --version           show the version

Credentials are only ever read from environment variables, never from flags.
`;

class UsageError extends Error {}

function positiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new UsageError(`${flag} must be a positive integer`);
  }
  return n;
}

export async function main(argv: string[], io?: Partial<CliIo>): Promise<number> {
  const out: CliIo = {
    stdout: io?.stdout ?? process.stdout,
    stderr: io?.stderr ?? process.stderr,
    env: io?.env ?? process.env,
    ...(io?.transport ? { transport: io.transport } : {}),
  };
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'base-url': { type: 'string' },
        'allow-host': { type: 'string', multiple: true },
        'allow-write': { type: 'boolean' },
        include: { type: 'string', multiple: true },
        exclude: { type: 'string', multiple: true },
        'bearer-env': { type: 'string' },
        'header-env': { type: 'string', multiple: true },
        timeout: { type: 'string' },
        'max-response': { type: 'string' },
        out: { type: 'string', short: 'o' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });

    if (values.version) {
      out.stdout.write(`${ownPackage().version}\n`);
      return 0;
    }
    const [command, specPath] = positionals;
    if (values.help || !command) {
      out.stdout.write(HELP);
      return 0;
    }
    if (!['serve', 'generate', 'list'].includes(command)) {
      throw new UsageError(`Unknown command "${command}"`);
    }
    if (!specPath) {
      throw new UsageError(`Missing <spec> argument for "${command}"`);
    }
    if (positionals.length > 2) {
      throw new UsageError('Expected exactly one <spec> argument');
    }

    const headerEnv: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const entry of values['header-env'] ?? []) {
      const eq = entry.indexOf('=');
      if (eq <= 0 || eq === entry.length - 1) {
        throw new UsageError(`--header-env expects HEADER=VAR, got "${entry}"`);
      }
      headerEnv[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    const options: BuildOptions = {
      allowWrite: values['allow-write'] ?? false,
      headerEnv,
    };
    if (values['base-url']) {
      options.baseUrl = values['base-url'];
    }
    if (values['allow-host']) {
      options.allowedHosts = values['allow-host'];
    }
    if (values.include) {
      options.include = values.include;
    }
    if (values.exclude) {
      options.exclude = values.exclude;
    }
    if (values['bearer-env'] !== undefined) {
      options.bearerEnv = values['bearer-env'];
    }
    const timeout = positiveInt(values.timeout, '--timeout');
    if (timeout) {
      options.timeoutMs = timeout;
    }
    const maxResponse = positiveInt(values['max-response'], '--max-response');
    if (maxResponse) {
      options.maxResponseBytes = maxResponse;
    }

    const spec = await loadSpec(specPath);
    const { manifest, skipped } = buildManifest(spec, options);

    if (command === 'list') {
      const width = Math.max(4, ...manifest.tools.map((t) => t.name.length));
      for (const tool of manifest.tools) {
        out.stdout.write(`${tool.name.padEnd(width)}  ${tool.method.toUpperCase().padEnd(6)} ${tool.path}\n`);
      }
      out.stdout.write(`\n${manifest.tools.length} tools, ${skipped.length} skipped (${summarize(skipped)})\n`);
      return 0;
    }

    if (skipped.length > 0) {
      out.stderr.write(`Skipped ${skipped.length} operations: ${summarize(skipped)}\n`);
    }
    if (manifest.tools.length === 0) {
      throw new UsageError('No operations left after filtering');
    }

    if (command === 'generate') {
      if (!values.out) {
        throw new UsageError('generate needs -o <dir>');
      }
      const name = `${(spec['info'] as { title?: string } | undefined)?.title ?? 'api'}-mcp`;
      const files = await generateProject(manifest, values.out, { name });
      out.stdout.write(`Generated ${files.length} files in ${values.out}\n`);
      out.stdout.write(`Next: cd ${values.out} && npm install && node server.mjs\n`);
      return 0;
    }

    const server = createMcpServer(manifest, { env: out.env }, { version: ownPackage().version });
    await server.connect(out.transport ?? new StdioServerTransport());
    out.stderr.write(`openapi-to-mcp: serving ${manifest.tools.length} tools for ${manifest.config.baseUrl}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    out.stderr.write(`Error: ${message}\n`);
    if (error instanceof UsageError || (error as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      out.stderr.write('Run with --help for usage.\n');
    }
    return 1;
  }
}

function summarize(skipped: { reason: string }[]): string {
  const counts = new Map<string, number>();
  for (const s of skipped) {
    counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  }
  return counts.size === 0 ? 'none' : [...counts].map(([r, n]) => `${n} ${r}`).join(', ');
}
