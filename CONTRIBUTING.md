# Contributing to REA

REA welcomes focused bug fixes, documentation improvements, tests, and reverse-engineering workflows. For large contract or architecture changes, explain the intended scope and link the relevant issue or design discussion.

## Choosing a contribution

Explain the concrete problem, keep related corrections together, and report
verification and unavailable coverage. Contributions should justify their review
and maintenance cost. Keep cosmetic polish with useful fixes; confusing or
incorrect user instructions warrant standalone corrections. Collect other
cosmetic-only suggestions in an issue rather than separate PRs.

For capability organization and provider composition, use the
[architecture map](docs/architecture.mermaid). Production factories in
`src/composition/` construct fresh providers without starting engines or acquiring
targets; optional adapter failures must preserve successful peers. Run
`npm run verify:test-discovery` after adding or moving tests. Resolved import
boundaries are checked by `npm run verify:module-boundaries`, included in lint.

When adding or changing an MCP tool, follow the [tool design guide](docs/tool-design.md) and preserve the canonical contracts and generated catalog.

## Development setup

Use the development toolchain pinned in `.nvmrc` and
`package.json#packageManager`. Run `nvm use` before installing dependencies;
installed-package runtime support is documented in
[installation](docs/installation.md#start-setup).

```bash
npm ci
npm run check:fast
```

`npm ci` installs the exact dependencies and prepares the Husky hooks without
building the project. Run `npm run build:cached` when you need the standalone
CLI or MCP server; it compiles the runtime and bundles the authored skill.
`npm run build` forces those tasks to rerun. Neither command generates test
catalogs, documentation projections, or managed verification evidence. Turbo
caches deterministic builds and static checks across Git worktrees. After a package, lockfile, or managed-skill version change, run
`npm run metadata:generate` before building.

Repository invariants live in [AGENTS.md](AGENTS.md). Keep provider-specific
protocols in adapters and shared CLI/MCP workflows in the application layer.

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
<https://rea.tools/> serves `website/public/` through Cloudflare Workers. See
the [website README](website/README.md#cloudflare-workers) for previews and
manual deployments.

The separate GitHub Pages host uses only the manual
`.github/workflows/website-pages.yml` workflow on `main`. The repository's
**Settings → Pages → Build and deployment → Source** must be set to
**GitHub Actions** before deploying there.

## Development feedback and PR verification

Select checks for the behavior changed. For a source edit:

```bash
npm run test:focused -- src/config.test.ts
npm run check:fast
```

`test:local` runs source tests without building. `check:changed` combines cached
static checks with source tests affected since the merge base with `origin/main`.
Import-graph selection can miss runtime registration, bridges, and generated data;
select relevant boundary tests explicitly. See [testing](docs/testing.md#developer-commands)
for commands, test placement, pruning, and real-provider prerequisites.

Before requesting review, run relevant tests and `npm run check`; add
`npm run docs:check` when contracts or generated metadata change. Record the
checks and unavailable coverage. CI owns the full deterministic suite and
coverage. `npm run check:pr` is an optional full local gate for broad changes or
CI diagnosis. Packaging/setup/distribution changes additionally require
`npm run verify:package` and `npm pack --dry-run`; provider changes require the
matching real-provider lane. State which host/provider workflows ran.

Pre-commit formats and lints staged files; pre-push runs `check:fast`.

### Generated files and command ownership

`docs:generate` prepares documentation and portable managed evidence;
`evidence:generate` prepares only the managed commitment and its runtime/skill
dependencies. The ignored outputs are `docs/public/product-catalog.json`,
`docs/verification/managed-conformance-*.json`, and `skills/`. Edit authored
skill instructions in `.agents/skills/reverse-engineer-anything/`, where Skills
can discover the public bundle directly from a clean checkout. `verify:package`
installs that bundle with Skills 1.7.2 using default repository-root discovery
and checks every installed file, alongside the packaged setup checks.
CI validates generated outputs and retains them as artifacts; do not commit
them. Reviewed source metadata, including
`src/generatedPackageMetadata.ts` and `docs/error-contract.schema.json`, remains
tracked and checked for freshness.

The packaged skill contains instructions and inventory metadata, not runtime
schema hashes. Its conformance commitment covers that exact bundle and portable
verification; it does not attest optional real-provider runs. Schema-only changes
should not alter that commitment. Doctor and `binary_session` expose runtime
schema identity.

Build/generation commands hold a SQLite transaction around the entire Turbo
graph, including cache restoration. `.cache/rea-command-locks/` databases identify
locks, not stale files; never remove them while commands run. POSIX cancellation
retains process-group ownership until settlement; Windows waits for completion.
Real-provider execution is uncached.

### Temporary files and diagnostics

Tests use `createTestTempDirectory` from `tests/fixtures/temporaryDirectory.ts`
for exact-path, awaited cleanup, including failures and timeouts.
`npm run verify:test-temp-hygiene` runs the suite under a fresh `TMPDIR` and
rejects remaining REA-owned paths. Never glob-clean shared `/tmp/rea-*` content.

`REA_LOG_LEVEL` selects `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or
`silent`. MCP defaults to `info` on stderr; one-shot CLI logging is opt-in on
stdout. Request arguments, bridge tokens, and environment data are redacted
from diagnostic logs.

## Real Hopper changes

Run `npm run verify:hopper` on a supported macOS host or
`npm run verify:hopper:linux` on the supported Linux demo runner. These build
native fixtures and verify the installed engine through CLI/MCP; package or
simulated-provider checks do not establish engine behavior. See
[real-toolchain verification](docs/testing.md#end-to-end-integration-and-golden-evidence)
for prerequisites and scope, and [Hopper setup](docs/installation.md#hopper)
for supported hosts and unattended startup.

Use the default `build/conformance/manifest.json` unless explicitly verifying
another source-built manifest with `REA_HOPPER_CONFORMANCE_MANIFEST_PATH`.
Generated fixtures and manifests remain ignored.

## Maintainer release checklist

Use the [release guide](docs/releasing.md). Main pushes automatically refresh a
Release Please PR with the next version and changelog. Review its migration
notes, wait for the current CI checks to pass, and merge it into main to publish.
The Release workflow validates and tags that merge; both publishers build its
exact SHA. Ordinary main pushes cannot publish packages. An optional manual
`release/VERSION` checkpoint retains explicit preparation and publication.

Keep new implementation commits on main for the next release. The workflow
owns packaged-artifact verification, npm publication, the published CLI/MCP
canary, and MCP Registry publication. Sync manual checkpoint metadata back to
main after publication; see the guide for recovery and verification.
