# Contributing to REA

REA welcomes focused bug fixes, documentation improvements, tests, and reverse-engineering workflow enhancements. Open an issue before a large contract or architecture change so its scope can be agreed before implementation.

## Development setup

REA development requires Node.js 24.18.x and npm 11.16.x. Real-Hopper verification additionally requires either macOS 12+ or an officially supported Linux host (Ubuntu 24.04+, Fedora 41+, or 64-bit Arch) and an installed Hopper application. Linux demo verification uses its own private Xvfb display and does not require a desktop session. Run `nvm use` before installing dependencies.

```bash
npm ci
npm test
```

`npm ci` installs the exact dependencies and prepares the Husky hooks without
building the project. Run `npm run build:cached` when you need the standalone
CLI or MCP server; `npm run build` remains the uncached compiler leaf used by
Turbo. Turbo caches deterministic builds and static checks across Git
worktrees. After a package, lockfile, or managed-skill version change, run
`npm run metadata:generate` before building.

Keep dependencies flowing inward through the existing domain, contracts, provider, application, server, and adapter layers. Parse unknown values at process and protocol boundaries, model expected failures with `Result`, and preserve the canonical tool inventory defined by `TOOL_CONTRACTS` unless a deliberate contract change updates every verifier, generated catalog artifact, and snapshot. Prefer capability- and session-scoped tool advertisement over schema truncation.

Before submitting a pull request, run:

```bash
npm run check:pr
npm run verify:package
npm pack --dry-run
```

`npm run check:fast` runs cached typecheck and lint for rapid local feedback.
`npm run check` adds formatting, dead-code, and package-metadata freshness
checks; use `npm run check:test` when the complete test suite is relevant.
Pre-commit formats then lints staged source files, and pre-push runs
`check:fast`. `check:pr` additionally renders API documentation and checks all
committed generated metadata. Real
provider and replay execution remains uncached, but their deterministic build
prerequisite uses Turbo. CI uploads the rendered TypeDoc site as an `api-docs`
artifact; the generated HTML is not committed.

Local `npm test` runs without coverage, retries, or verbose output. Use `npm run
test:fast` for pure and subprocess groups, `npm run test:integration` for serial
filesystem/process/CLI cases. `npm run test:changed` runs changed and related
non-serial tests once; `npm run test:watch` keeps that selection live. Pure tests
use Vitest threads, while subprocess tests stay in isolated forks. CI splits the
complete suite across two native Vitest
shards, then merges their coverage and JUnit reports. `npm run test:ci` runs the
equivalent unsharded gate locally. Coverage thresholds remain in
`vitest.config.ts`.

CI installs dependencies once for all static checks, cancels superseded PR
runs, and skips package, Windows, and full test lanes for documentation-only
pull requests. TypeDoc renders only in pull-request CI; it does not run in local
commit or pre-push hooks, or in post-merge `main` CI.

Tests that need a temporary directory must use
`createTestTempDirectory` from `tests/fixtures/temporaryDirectory.ts`. The
helper binds exact-path, awaited cleanup to the current Vitest case, including
failure and timeout completion. Run `npm run verify:test-temp-hygiene` to build
REA, execute the complete suite under a fresh `TMPDIR`, and reject any remaining
REA-owned temporary path. Never add a glob cleanup for shared `/tmp/rea-*`
content.

Set `REA_LOG_LEVEL` to `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or
`silent` to control structured JSON diagnostics. MCP mode defaults to `info` and
always writes logs to stderr so the stdio protocol remains intact. One-shot CLI
logging is opt-in and writes to stdout when a level is configured, preserving
machine-readable command output by default. Request arguments, bridge
authentication tokens, and environment data are redacted.

Changes that claim real Hopper behavior must also be tested against the
source-owned, digest-bound conformance manifest. The verifier builds the
platform-native fixtures before starting Hopper:

```bash
npm run verify:hopper
```

On a self-hosted Linux runner with the setup-installed Xvfb dependencies, use:

```bash
npm run verify:hopper:linux
```

Set `REA_HOPPER_CONFORMANCE_MANIFEST_PATH` only to verify another source-built
manifest. The normal commands use `build/conformance/manifest.json`; generated
fixtures and manifests remain ignored and must not be committed.

The macOS and Linux real-Hopper workflows remain separate so a successful mock or package test cannot be reported as platform-runtime proof. Pull requests changing setup, launch, bridge, or Hopper behavior must state which real workflows ran and why either workflow was unavailable.

Describe the behavior change and verification performed in the pull request. Never commit binaries, Hopper documents, credentials, `dist/`, `node_modules/`, or local planning artifacts.

## Maintainer release checklist

Run the full checks, isolated package verifier, package dry run, and two-target real-Hopper verifier described above. Build a local tarball and exercise the executable through the package boundary:

```bash
npm pack
npm exec --yes --package ./morluto-rea-0.1.0.tgz -- rea --help
```

Publish the public package:

```bash
npm publish --access public
```

After npm registry propagation, verify the published CLI and connect the client SDK version pinned in `package.json` to the published server to confirm the canonical tool catalog:

```bash
npx -y rea-agents@latest --help
npx -y rea-agents@latest doctor
npx -y rea-agents@latest setup --yes
npx -y rea-agents@latest mcp
```
