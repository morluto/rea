# Contributing to REA

REA welcomes focused bug fixes, documentation improvements, tests, and reverse-engineering workflow enhancements. Open an issue before a large contract or architecture change so its scope can be agreed before implementation.

## Development setup

REA development requires Node.js 24.18.x and npm 11.16.x. Real-Hopper verification additionally requires either macOS 12+ or an officially supported Linux host (Ubuntu 24.04+, Fedora 41+, or 64-bit Arch) and an installed Hopper application. Linux demo verification uses its own private Xvfb display and does not require a desktop session. Run `nvm use` before installing dependencies.

```bash
npm ci
npm run rebuild:native # only when the packaged PTY binary is incompatible
npm test
```

`npm ci` installs the exact dependencies, builds the compiled runtime through
the package `prepare` lifecycle, and prepares the Husky hook. Run
`npm run build` again after source changes when you need the standalone CLI or
MCP server without running the test prebuild.

Keep dependencies flowing inward through the existing domain, contracts, provider, application, server, and adapter layers. Parse unknown values at process and protocol boundaries, model expected failures with `Result`, and preserve the canonical tool inventory defined by `TOOL_CONTRACTS` unless a deliberate contract change updates every verifier, generated catalog artifact, and snapshot. Prefer capability- and session-scoped tool advertisement over schema truncation.

Before submitting a pull request, run:

```bash
npm run check
npm run verify:package
npm pack --dry-run
```

`npm install` builds the compiled runtime and prepares the Husky pre-commit
hook. Commits format and lint staged files with lint-staged, then typecheck the
complete project. The normal test and CI coverage runs enforce the thresholds
in `vitest.config.ts`; `npm run lint:dead` rejects unused files, exports, and
dependencies.

Set `REA_LOG_LEVEL` to `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or
`silent` to control structured JSON diagnostics. MCP mode defaults to `info` and
always writes logs to stderr so the stdio protocol remains intact. One-shot CLI
logging is opt-in and writes to stdout when a level is configured, preserving
machine-readable command output by default. Request arguments, bridge
authentication tokens, and environment data are redacted.

Changes that claim real Hopper behavior must also be tested against two distinct binaries:

```bash
HOPPER_TARGET_PATH=/path/to/target-a \
HOPPER_SECOND_TARGET_PATH=/path/to/distinct-target-b \
npm run verify:hopper
```

On a self-hosted Linux runner with the setup-installed Xvfb dependencies, use:

```bash
HOPPER_TARGET_PATH=/path/to/target-a \
HOPPER_SECOND_TARGET_PATH=/path/to/distinct-target-b \
npm run verify:hopper:linux
```

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
npx -y rea-agents --help
npx -y rea-agents doctor
npx -y rea-agents setup --yes
npx -y rea-agents mcp
```
