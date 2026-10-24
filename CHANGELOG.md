# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- Preserve raw HTTP response text without rounding JSON numbers.
- Keep literal `$ref` fields in examples and schema data while resolving actual references.
- Serialize object headers using simple style and the explode flag.
- Preserve JSON media types, boolean schemas and every argument when generated names collide.
- Reject invalid runtime limits, credential-bearing base URLs, inherited reference/input properties and null path arguments.
- Recheck write methods at execution, normalize credential header casing and refuse to overwrite generated files.
- Separate Node 20 runtime checks from the Node 22/24 development toolchain in CI.

### Added
- English and Turkish READMEs, offline library example and regression tests.
- Enforce 85% coverage for branches as well as statements, functions and lines.

## [0.1.0] - 2026-10-23

### Added
- `serve`: stdio MCP server that turns tool calls into HTTP requests.
- `generate`: writes a standalone MCP server project.
- `list`: shows which tools a spec would expose.
- OpenAPI 3.0 and 3.1 (JSON or YAML) with local `$ref` resolution, circular reference handling and conversion of 3.0 keywords to JSON Schema.
- Path, query, header and body parameters, including array, object and `deepObject` styles; JSON and form-urlencoded bodies.
- Safety defaults: read-only operations, base URL host allowlist, environment-only credentials, include/exclude filters, no redirects, response size limit and timeout.
- Library API (`buildManifest`, `createExecutor`, `createMcpServer`, `generateProject`).
