import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createExecutor } from './runtime.js';
import type { ExecutorDeps, Manifest } from './runtime.js';

export interface ServerInfo {
  name?: string;
  version?: string;
}

/** Create an MCP server (not yet connected) that exposes the manifest as tools. */
export function createMcpServer(
  manifest: Manifest,
  deps: ExecutorDeps = {},
  info: ServerInfo = {},
): Server {
  const executor = createExecutor(manifest, deps);
  const server = new Server(
    { name: info.name ?? 'openapi-to-mcp', version: info.version ?? '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: manifest.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object'; properties?: Record<string, unknown> },
      annotations: {
        readOnlyHint: !tool.write,
        destructiveHint: tool.method === 'delete',
        openWorldHint: true,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await executor.execute(request.params.name, request.params.arguments ?? {});
    return { content: [{ type: 'text' as const, text: result.text }], isError: result.isError };
  });

  return server;
}
