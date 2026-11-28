# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Read [AGENTS.md](AGENTS.md) first.** It holds the binding repository invariants (scope/authority rules, provider mutation limits, ownership and cleanup, error algebra, performance priorities, PR readiness). This file only adds orientation; where they differ, AGENTS.md wins.

## What this is

REA (`rea-agents` on npm) is a local-only reverse-engineering tool exposed as both a one-shot CLI and an MCP stdio server. Both adapters drive the same application workflows over pluggable providers (Hopper, Ghidra, IDA, rizin, GDB, objdump, JADX/Android, Frida, browsers/CDP, WABT, EVMole, binwalk/unblob, etc.). Provider engines are bring-your-own.

## Commands

Toolchain: Node from `.nvmrc` (24.x) and npm from `package.json#packageManager`. Tasks run through Turbo; build/generation commands take checkout-local locks in `.cache/rea-command-locks/` — never delete those while commands run.

```bash
npm ci                                   # install locked deps (+ husky hooks)
npm run build:cached                     # compile CLI/MCP runtime + packaged skill (npm run build forces rerun)
npm run check:fast                       # cached typecheck + lint (also the pre-push hook)
npm run check                            # full static gate before handing off a PR
npm run format                           # oxfmt; lint is oxlint + module-boundary verification
npm run docs:check                       # when contracts or generated metadata change
npm run metadata:generate                # after package, lockfile, or managed-skill version changes
```

Tests (Vitest, multiple projects defined in `vitest.config.ts` / `scripts/lib/test-projects.mjs`):

```bash
npm run test:local -- src/config.test.ts                       # source tests, no build
npm run test:focused -- tests/acceptance/applications/runtime.test.ts  # exact files; builds if the path needs compiled output
npm run test:changed                                           # source tests affected since merge base with origin/main
npm run test:fast                                              # all source projects, no build
npm run test:boundary | test:mcp | test:acceptance             # compiled boundary/acceptance lanes
npm run test:python                                            # LLDB / mitmproxy bridge producer tests
```

Changed-test selection follows the import graph and can miss runtime registration, bridges, shell entrypoints, and generated data — select relevant boundary tests explicitly. An empty selection is not verification. Use `createTestTempDirectory` (`tests/fixtures/temporaryDirectory.ts`) for temp dirs. `REA_LOG_LEVEL` controls stderr logging; stdout carries only protocol messages / command results. Details: [docs/testing.md](docs/testing.md), [CONTRIBUTING.md](CONTRIBUTING.md#development-feedback-and-pr-verification).

## Architecture

Full diagram: [docs/architecture.mermaid](docs/architecture.mermaid). Dependencies flow inward:

- **Entry points** — `scripts/rea.mjs` dispatches to `src/cli.ts` + `src/cli/` (one-shot CLI) or `src/main.ts` + `src/main/` (MCP server: config, session, process lifetime).
- **Composition** — `src/composition/`: production wiring; fresh typed provider/session factories per provider family.
- **MCP adapter** — `src/server/`: `createServer`, `register*Tools.ts`, contract-bound handlers (`contractToolHandler.ts`), admission and progress.
- **Contracts** — `src/contracts/`: caller-visible Zod/JSON schemas for every tool family; `errorSchemas.ts` feeds CLI diagnostics and the generated `docs/error-contract.schema.json`.
- **Application** — `src/application/`: shared CLI/MCP workflows. Key pieces: `SessionProviderRouter`/`BinarySession` (one immutable deep-provider binding per target), `AnalysisProviderRegistry` (deterministic selection, no fallback), `investigation/` (evidence ledger, unknowns), snapshot caches.
- **Providers** — one directory per engine/format under `src/` (`hopper/`, `ghidra/`, `ida/`, `rizin/`, `gdb/`, `android/`, `browser/`, `wasm/`, `evm/`, `firmware/`, `native/`, …). Engine protocols stay here. In-engine bridges live in `bridge/` (Python for Hopper/Cutter/LLDB/mitmproxy, Java for Ghidra/JADX, Swift for macOS native UI).
- **Process foundation** — `src/process/`: owned process groups, private roots, deadlines, bounded reads, cleanup. Reuse it for any child process. `src/windows/` + `native/windows/` provide Windows job/ACL controls (native addon is not built by `npm ci`; see `native/windows/README.md`).
- **Domain** — `src/domain/`: pure, side-effect-free evidence, comparison, and error modules. `src/domain/result.ts` is the `Result` type; `analysisError*.ts` is the tagged error algebra.
- **Config** — `src/config/`: Zod-validated environment parsing.

Layering is enforced by `npm run verify:module-boundaries` (part of lint) and `npm run verify:architecture-guards`.

Tests: unit/source tests sit next to code as `*.test.ts`; `tests/` holds `boundary/`, `acceptance/`, `composition/`, `conformance/`, `evaluation/`, `process-global/` (CLI module mocks belong here) and `fixtures/` (fake launchers, bridges, CDP seams).

## Generated files

Ignored outputs — never commit, regenerate instead: `skills/` (edit `.agents/skills/reverse-engineer-anything/`), `docs/public/product-catalog.json`, `docs/verification/managed-conformance-*.json`, `.cache/mcp-tool-catalog.json` (test metadata; `npm run test:prepare` or `mcp-catalog:generate`). Tracked but generated and freshness-checked: `src/generatedPackageMetadata.ts`, `docs/error-contract.schema.json`.

## Conventions

Conventional Commit subjects and PR titles (`!` / `BREAKING CHANGE:` for breaking changes). Keep PRs in draft and leave the template's **Author readiness** boxes unchecked for the human owner. Provider claims need real-provider evidence; simulated providers don't count.
