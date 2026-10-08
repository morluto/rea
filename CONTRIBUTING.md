# Contributing to REA

REA welcomes focused bug fixes, documentation improvements, tests, and reverse-engineering workflow enhancements. Open an issue before a large contract or architecture change so its scope can be agreed before implementation.

For capability organization and provider composition, follow the incremental
[migration guide](docs/capability-migration.md). Run `npm run verify:test-discovery`
after adding or moving tests.

When adding or changing an MCP tool, follow the [tool design guide](docs/tool-design.md) and preserve the canonical contracts and generated catalog.

## Development setup

REA development requires Node.js 24.18.x and npm 11.16.x (pinned toolchain via `nvm use`; the supported runtime range is Node.js ^22.19 || ^24.11 || >=26, as the README badge states). Real-Hopper verification additionally requires either macOS 12+ or an officially supported Linux host (Ubuntu 24.04+, Fedora 41+, 64-bit Arch, or CachyOS) and an installed Hopper application. Linux demo verification uses its own private Xvfb display and does not require a desktop session. Run `nvm use` before installing dependencies.

```bash
npm ci
npm run check:fast
```

`npm ci` installs the exact dependencies and prepares the Husky hooks without
building the project. Run `npm run build:cached` when you need the standalone
CLI or MCP server; `npm run build` remains the uncached compiler leaf used by
Turbo. Turbo caches deterministic builds and static checks across Git
worktrees. After a package, lockfile, or managed-skill version change, run
`npm run metadata:generate` before building.

Keep dependencies flowing inward through the existing domain, contracts, provider, application, server, and adapter layers. Parse unknown values at process and protocol boundaries, model expected failures with `Result`, and preserve the canonical tool inventory defined by `TOOL_CONTRACTS` unless a deliberate contract change updates every verifier, generated catalog artifact, and snapshot. Keep tool discovery complete and report capability- and session-scoped availability through `binary_session`.

## Documentation website

The VitePress site uses the Markdown files in `docs/`. Run `npm run docs:dev`
for live editing, `npm run docs:build` to check the production build and
links, and `npm run docs:preview` to preview that build at `/rea/`.

Site navigation lives in `docs/.vitepress/config.ts`. Keep links to guides
relative so they work on GitHub and the website; link to repository files
outside `docs/` using their full GitHub URLs. Generated reference documents
use `npm run docs:generate`; `docs:build` generates them before building the website.

Pull requests run `npm run docs:check`. `.github/workflows/pages.yml` is a
manual VitePress build and does not publish. The public site at
<https://morluto.github.io/rea/> is published only by the manual website
workflow on `main`. The repository's **Settings → Pages → Build and
deployment → Source** must be set to **GitHub Actions** before the first
deployment.

## Development feedback and PR verification

For an ordinary edit, run the relevant regression and cached static checks:

```bash
npm run test:focused -- src/config.test.ts
npm run check:fast
```

`test:local` selects dirty source tests without building; explicit source test
paths run even on a clean tree. `check:changed` adds source tests affected since
the branch merge base with `origin/main`. Use `npm run test:changed -- --base
REVISION` to choose another base. Changed-test selection follows the import
graph and is feedback, not complete correctness evidence. Inspect relevant
boundary and provider behavior explicitly; see [docs/testing.md](docs/testing.md).

Before handing off a PR, run the relevant tests, `npm run check`, and
`npm run docs:check` when contracts or generated metadata change. Record which
checks ran. CI owns complete deterministic tests and aggregate coverage. Use
`npm run check:pr` for a deliberate full local gate on broad changes or when
investigating CI failures; it is not required after each edit, rebase, or push.
Packaging, setup, installation, or distribution changes also require
`npm run verify:package` and `npm pack --dry-run`. Provider behavior changes
require the matching real-provider `verify:*` lane.

`check:fast` runs cached typecheck and lint, reporting diagnostics on failure.
`check` adds formatting, dead-code, and package-metadata freshness checks.
Formatting uses Oxfmt and the committed `.oxfmtrc.json`; generated sources use
the same configuration. Pre-commit formats and lints staged files; pre-push runs
`check:fast`.
`docs:check` builds and validates generated metadata for the current checkout.
The product catalog (`docs/public/product-catalog.json`), portable managed
conformance projections (`docs/verification/managed-conformance-*.json`), and
packaged skill (`skills/`) are ignored build outputs. Edit skill instructions
and references in `skill-src/`; the build adds catalog-dependent metadata to
the packaged copy without rewriting authored files. The generated manifest
commits to that exact packaged skill bundle. It is a portable projection of
the deterministic managed verifier, not a record of optional real-provider runs.
CI validates these outputs and retains them as artifacts instead of pushing
generated-only commits onto feature branches. Reviewed source metadata such as
`src/generatedPackageMetadata.ts` and `docs/error-contract.schema.json` remains
tracked and checked for freshness. Do not commit ignored generated outputs.
Real-provider execution remains uncached; deterministic builds use Turbo.

Local `npm test` runs every deterministic Vitest project without coverage or
retries. CI runs four coverage shards and merges JUnit and timing reports.
CI cancels superseded PR runs and skips package, Windows, and full test lanes
for documentation-only PRs. Coverage thresholds remain in `vitest.config.ts`.

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

Use the [checkpoint release guide](docs/releasing.md). Releases start from an
explicit `release/VERSION` branch cut at a recorded commit. Manually prepare
the bot PR, wait for its exact-head CI and review, merge into that frozen
branch, and manually publish through the official Release workflow. Main
pushes do not update release PRs or publish packages. Both publishers build
the exact SHA tagged by Release Please.

Keep new implementation commits on main for the next release. The workflow
owns packaged-artifact verification, npm publication, the published CLI/MCP
canary, and MCP Registry publication. Sync release metadata back to main after
publication; see the guide for partial-publication recovery and verification.
