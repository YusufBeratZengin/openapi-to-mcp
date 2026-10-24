# Contributing

Use Node.js 24 for development (the current toolchain also supports Node 22.13+).
The compiled library and CLI support Node 20+. CI runs the full checks on Node
22/24 and checks the compiled runtime with production dependencies on Node 20,
on both Ubuntu and Windows.

```sh
npm ci
npm run check    # lint, typecheck, build, tests with coverage (>= 85%)
```

Tests never use external APIs: they use injected fetch functions or a local fake HTTP server and talk to it through the real MCP client and built CLI (`dist/bin.js`). `npm test` builds first, because the end-to-end tests run the compiled output and `generate` copies compiled files. Generated projects are written under the ignored `.tmp-test/` folder. All four coverage thresholds (statements, branches, functions, lines) are 85%.

## Guidelines

- Keep runtime dependencies minimal (currently only the official MCP SDK and `yaml`).
- `src/runtime.ts` must stay free of imports: `generate` copies its compiled output into generated servers.
- Do not weaken the security defaults (read-only, host allowlist, environment-only credentials, no redirects) without a clear discussion in an issue.
- Add a test for every behavior change. A regression test should fail without the fix.
- Use only synthetic data in tests and examples: fake tokens built from fragments, no personal data, no local paths.
- Update `README.md`, `README.tr.md` and `CHANGELOG.md` when user-facing behavior changes.
- Regenerate the README demo image with `npm run demo` after changing CLI output.

## Commit style

Small [Conventional Commits](https://www.conventionalcommits.org/) in English: `feat`, `fix`, `docs`, `test`, `ci`, `chore`.

## Releasing

1. Move the Unreleased notes into a dated version section in `CHANGELOG.md`.
2. Bump the version in `package.json` (SemVer; breaking changes bump the minor while the project is 0.x).
3. Commit as `chore(release): vX.Y.Z`, then tag `vX.Y.Z` and push the tag.
4. `publish.yml` checks that the tag equals the package version, runs lint, typecheck and tests, and publishes with npm provenance through trusted publishing (OIDC). Configure the trusted publisher on npmjs.com for this repository and the workflow file `publish.yml` (environment `npm`) first. Only if trusted publishing is unavailable, a maintainer can explicitly configure an `NPM_TOKEN` repository secret as `NODE_AUTH_TOKEN`; the included workflow uses OIDC only.
5. Dry run before tagging: `npm publish --dry-run`.

The npm name may belong to an unrelated package; registry ownership has not been verified for this checkout. The current name is preserved. Before the first release, a maintainer must verify ownership and, if necessary, decide on an available scope or package name. Do not assume the npm badge refers to a release of this code.
