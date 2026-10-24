# openapi-to-mcp
[![CI](https://github.com/YusufBeratZengin/openapi-to-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/YusufBeratZengin/openapi-to-mcp/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/openapi-to-mcp)](https://www.npmjs.com/package/openapi-to-mcp) [![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D20-green)](package.json)

[English](README.md) | [Türkçe](README.tr.md)

Turn an OpenAPI 3.0/3.1 document into MCP tools, a stdio server, or a standalone server project.
Local spec loading, typed library APIs and read-only defaults, with just two direct runtime dependencies.
Install from this checkout with Node 24: `npm ci && npm run build`.
Try it: `node dist/bin.js list examples/petstore.yaml`.
![Actual CLI and local API output](docs/demo.svg)

## Demo

```sh
node dist/bin.js list examples/petstore.yaml
node dist/bin.js list examples/petstore.yaml --include 'tag:pets'
node examples/call-tool.mjs
```

The first command prints:

```text
listPets        GET    /pets
getPet          GET    /pets/{petId}
listOwnerPets   GET    /owners/{ownerId}/pets
listCategories  GET    /categories
get_health      GET    /health

5 tools, 4 skipped (4 write-disabled)
```

The last command starts a synthetic loopback API, connects an MCP client to the CLI, calls `getPet`, and shows that `createPet` is unavailable. It needs no API account or credentials. Regenerate the terminal image with `npm run demo` using [scripts/make-demo.mjs](scripts/make-demo.mjs).

## Install

Use the source checkout: `npm ci && npm run build`. Development tools require Node 22.13+ or 24+; the compiled CLI and library support Node 20+. CI checks the toolchain on Node 22/24 and runtime compatibility on Node 20.

The npm name `openapi-to-mcp` may refer to an unrelated project; registry ownership has not been verified for this checkout. The npm badge describes that registry name, not a release of this code. Use the local build until the maintainer resolves the package name. No global installation is required.

## Usage

### CLI

```sh
node dist/bin.js --help
node dist/bin.js list examples/petstore.yaml --allow-write --exclude 'tag:admin'
node dist/bin.js generate examples/petstore.yaml -o is/petstore-mcp
```

`list` previews tools without making API requests or reading authentication variables. `generate` writes six files: `server.mjs`, `runtime.js`, `mcp.js`, `tools.json`, `package.json`, and a README. It refuses to replace any existing generated file; use a fresh directory for a new export. Generated projects contain the manifest and runtime, and need only the MCP SDK at runtime.

To start a generated server, install its dependencies in that output directory and launch `server.mjs` with Node. A stdio server waits for an MCP client and reserves stdout for protocol messages; diagnostics go to stderr.

An MCP client's stdio configuration can point directly to the built CLI:

```json
{
  "mcpServers": {
    "petstore": {
      "command": "node",
      "args": ["dist/bin.js", "serve", "examples/petstore.yaml"]
    }
  }
}
```

Resolve these relative paths from the checkout's working directory, or configure the client with paths appropriate to your installation. The example spec's server is a placeholder; use `--base-url` for a real API. `GET` and `HEAD` are exposed by default; other supported methods require `--allow-write`.

### Library

```js
import { loadSpec, buildManifest, createExecutor } from './dist/index.js';

const spec = await loadSpec('examples/petstore.yaml');
const { manifest, skipped } = buildManifest(spec, { include: ['getPet'] });
console.log(manifest.tools.map((tool) => tool.name), skipped.length);
const executor = createExecutor(manifest, {
  env: {},
  fetch: async () => new Response('{"id":1,"name":"Rex"}', {
    headers: { 'Content-Type': 'application/json' },
  }),
});
console.log((await executor.execute('getPet', { petId: 1 })).text);
```

The injected fetch above keeps the example offline. See [examples/library.mjs](examples/library.mjs) for this runnable example. Without an injected fetch, `execute` sends an HTTP request. It returns `{ isError, text }`; HTTP 4xx/5xx, timeouts and request failures become tool errors.

The package root exports `parseSpec`, `loadSpec`, `resolveBaseUrl`, `buildManifest`, `matchesPattern`, `deref`, `convertSchema`, `createExecutor`, `createMcpServer`, and `generateProject`, along with their public types. `createMcpServer(manifest, deps?, info?)` returns an unconnected SDK server; connect it to a transport. `generateProject(manifest, outDir, options?)` returns the names of the files it writes.

## Examples

- [petstore.yaml](examples/petstore.yaml): OpenAPI 3.0 with local references, recursive schemas, filters, JSON bodies and form bodies.
- [call-tool.mjs](examples/call-tool.mjs): an actual stdio MCP client and local fake HTTP API.
- [library.mjs](examples/library.mjs): the library API with an injected response and no network access. Run `node examples/library.mjs` after building.
- [mini31.json](tests/fixtures/mini31.json): OpenAPI 3.1, nullable unions, colliding names and unsupported uploads.

## Configuration

| CLI option | Library `BuildOptions` | Default / behavior |
| --- | --- | --- |
| `--base-url URL` | `baseUrl` | First top-level `servers` entry, using variable defaults |
| `--allow-host HOST` | `allowedHosts` | Base URL host; repeat to replace the list |
| `--allow-write` | `allowWrite` | `false`; expose other supported methods |
| `--include PATTERN` | `include` | All operations; repeat for OR matches |
| `--exclude PATTERN` | `exclude` | None; exclusions win over inclusions |
| `--bearer-env VAR` | `bearerEnv` | Read the bearer token from the named variable |
| `--header-env H=VAR` | `headerEnv: { H: 'VAR' }` | Read header values from named variables |
| `--timeout MS` | `timeoutMs` | `30000`, integer in `1..2147483647` |
| `--max-response BYTES` | `maxResponseBytes` | `1000000`, positive safe integer |
| `-o, --out DIR` | `generateProject`'s `outDir` | Required by `generate` |
| `-h, --help` / `-v, --version` | — | Help / package version |

Patterns match the tool name, original `operationId`, `tag:NAME`, or `METHOD /path`. Matching is case-insensitive and anchored; `*` matches any sequence and `?` one character. Quote patterns so your shell passes them unchanged.

`OPENAPI_MCP_BASE_URL` overrides the base URL when the executor starts, including in generated servers. Its host must be allowed. A host entry without a port allows any port on that hostname; specify `hostname:port` to restrict it. Redirects are returned without being followed. Base URLs must use HTTP(S) and contain no credentials, query string or fragment.

Authentication values belong in the process environment supplied by your MCP client. Flags and generated manifests store variable **names**, never token values. `Authorization` and `Cookie` are hidden from tool arguments, as are all headers configured with `headerEnv`. Explicitly configure custom authentication headers such as `X-Api-Key`; OpenAPI `securitySchemes` are not wired automatically. Missing authentication variables fail at server startup.

## How it works

1. Parse a local JSON or YAML file and resolve local JSON pointers. Recursive references become an open placeholder schema; expansion has a node budget.
2. Select operations, merge path and operation parameters, assign unique names, and convert OpenAPI schema keywords into JSON Schema.
3. Expose input schemas through the official MCP SDK. Each call serializes path, query, header and JSON/form body values into a bounded HTTP request.

## Limitations and privacy

Supported versions are OpenAPI 3.0.x and 3.1.x. Supported methods are GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS. Only top-level server selection is supported. Remote references, Swagger 2, callbacks, links, cookies as parameters, multipart/binary uploads and OAuth flows are not implemented. JSON and `application/*+json` body media types are preserved; form-urlencoded bodies are supported.

Parameter serialization supports simple paths, form queries, flat `deepObject` queries, space/pipe-delimited arrays and header values. Matrix/label path styles, nested deep objects and parameter `content` encodings are not fully implemented. Recursive schema placeholders lose recursive constraints. Schemas are advertised to clients; the executor checks required arguments but does not perform full JSON Schema validation or insert schema defaults.

Spec parsing, listing and generation are local. Serving sends supplied arguments and configured credentials to your chosen API, and returns its response to the MCP client. Review specs, destinations and client permissions before connecting sensitive data. API responses can contain secrets or malicious instructions; they are passed through as text without redaction. A host allowlist is not DNS or IP isolation, and a GET endpoint can still have side effects. Generated manifests contain the selected API URL, paths and schema descriptions; review them before sharing.

## Development

Use Node 24 and the existing lockfile:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm pack --dry-run --cache ./is/npm-cache
```

Run `npm ci` first when dependencies are absent. `npm test` builds and runs Vitest with V8 coverage. The enforced thresholds are **85% for statements, branches, functions and lines**. Tests use synthetic data, injected fetch implementations or loopback HTTP servers; no external API is required. End-to-end tests exercise stdio and generated projects. CI runs on Ubuntu and Windows. `src/bin.ts` is exercised by the stdio tests but excluded from Vitest's in-process coverage report.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md), and the [Code of Conduct](CODE_OF_CONDUCT.md). GitHub workflows cover CI, CodeQL, weekly dependency updates and tag-triggered publishing. A maintainer must configure npm trusted publishing and resolve the package name before a release.

## License

[MIT](LICENSE), copyright 2026 Yusuf Berat Zengin.
