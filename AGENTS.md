# Repository Guidelines

## Product Direction

REA exposes reverse-engineering tools through a CLI and MCP server. Hopper, the bring-your-own Ghidra adapter, and the bring-your-own IDA MCP adapter are operation-capable deep binary-analysis providers. Ghidra is supported on Linux x64 and macOS x64/arm64 with matching native decompiler tools, and has an experimental Windows x64 P0 boundary for approved native x86-64 PE applications; on Linux and macOS it supplies inventory, function analysis, and atomic function annotation edits in an ephemeral database, without modifying executable bytes or controlling a GUI. Windows P0 has no mutation authority. IDA adapts upstream legacy attached GUI and modern headless database-supervisor profiles for live read-only analysis; initial real verification covers Windows, and an attached GUI database is never saved or closed. Keep provider-specific code out of the domain and application layers.

Prioritize:

- tool results that distinguish observations, inferences, and unknowns;
- equivalent behavior through the CLI and MCP;
- additive, idempotent configuration with backups;
- end-to-end tests for packaged artifacts and real Hopper/Ghidra claims.

Installers must not install or upgrade Homebrew, Node.js, npm, Java, Ghidra, or other unrelated software. Ghidra is bring-your-own. `rea setup` must print its planned changes and require approval before writing files or installing Hopper.

REA is a local-only tool. Preserve caller-selected inputs, captured output, URLs, paths, digests, mismatch locations, and analysis metadata. Do not guess that local evidence is secret from environment-variable names, argument names, or text patterns. Redact transport authentication credentials and values the caller explicitly marks sensitive; do not persist the entire ambient environment merely because a child inherits it.

## Project Structure & Module Organization

REA is a layered ESM TypeScript application. Dependencies flow inward from pure domain logic through contracts, providers, application workflows, and CLI/MCP adapters. See [docs/architecture.mermaid](docs/architecture.mermaid) for the component map.

- `src/domain/` owns pure provider-neutral semantics; `src/contracts/` owns caller-visible schemas and the canonical tool inventory.
- `src/hopper/`, `src/ghidra/`, `src/ida/`, `src/browser/`, `src/inspector/`, `src/native/`, `src/artifacts/`, and `src/dotnet/` own provider-specific boundaries. Keep provider protocols out of domain and application code.
- `src/application/` composes shared CLI/MCP workflows; `src/server/` translates MCP requests; `src/cli.ts` and `src/main.ts` are the CLI and MCP entry points.
- `src/process/` owns shared process lifecycle primitives, not provider wire protocols. `bridge/` contains provider-side adapters.
- `tests/` contains unit, composition, boundary, acceptance, and conformance tests. `scripts/verify-*` and capability directories under `scripts/verify/` contain real-toolchain checks.
- `docs/product-catalog.json` is generated. Update its source contracts and regenerate it; do not edit it directly.

## Build, Test, and Development Commands

- `npm ci`: install the locked dependencies.
- `npm run build:cached`: build the CLI and MCP server.
- `npm run test:local`: run changed source tests without building; pass exact source test paths to run them regardless of Git status.
- `npm run test:focused -- PATH...`: run exact test files; build first for boundary, acceptance, or process-global tests.
- `npm run check:changed`: run cached static checks and source tests affected since the branch merge base (default `origin/main`).
- `npm run check:fast`: run cached typecheck and lint checks.
- `npm run check:pr`: opt into the complete local deterministic gate and generated-document checks for broad changes; CI owns full coverage. Routine iterations need focused tests and relevant checks, not the whole gate each time.
- `npm run docs:check`: check committed generated documents; `npm run docs:generate` regenerates them.
- For provider-dependent changes, see [docs/testing.md](docs/testing.md) and run the matching real-provider verification.
- Keep each verification lane's prerequisites limited to the claim it checks. Use host-native fixtures for host/provider acceptance; put optional cross-target formats and their external toolchains in a separate lane. Preflight required commands and report the missing dependency and lane clearly.

See [docs/testing.md](docs/testing.md) for test scopes and verification lanes and [CONTRIBUTING.md](CONTRIBUTING.md) for contribution checks. Pre-commit formats and lints staged source; pre-push runs `npm run check:fast`.

## Configuration & Environment Variables

Configuration is parsed and validated by `src/config.ts` and `src/config/`. Keep user-facing setup and provider configuration in [README.md](README.md) and the relevant guide under `docs/`; do not maintain a second environment-variable catalogue here.

## Coding Style & Naming Conventions

Use ESM TypeScript, two-space indentation, and the committed Oxfmt configuration. Keep compiler strictness intact (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`). Use `camelCase` for values/functions, `PascalCase` for classes/types, and `UPPER_SNAKE_CASE` for constants. Parse unknown values at every MCP, environment, and subprocess boundary. Avoid `any`, unchecked casts, non-null assertions, import-time I/O, and floating promises. Exported APIs require concise JSDoc. Model expected failures with the tagged error algebra and `Result`, not broad exception wrappers.

## Boundary Contracts

Treat a boundary as a contract between the producer's actual representation and the consumer's required meaning. When implementing or auditing a boundary, trace the value through parsing, normalization, authorization, serialization, and the CLI/MCP result. Establish affected callers from their code paths; similar tool names or workflows do not prove that they share a schema or failure mode.

Keep portable evidence and scenario validation distinct from host-native execution checks. Absolute filesystem paths, file URLs, and HTTP paths have different semantics; do not substitute one platform's syntax for the domain concept. Interpret provider metadata according to its documented or observed producer behavior. When a transformation loses information, preserve the reported value and an explicit unknown rather than guessing a canonical identity.

Preserve meaningful failure reasons through application and adapter layers. Malformed input is distinct from an unsupported target, unavailable provider, or host operating-system permission denial. Diagnostics should identify the failed constraint and the target or lifecycle request it applies to. Recovery advice must address that reason and point to an available workflow; generic catches must not erase actionable validation details.

Leave meaningful target, action, capture, and output choices to the agent. A selected operation already expresses intent; do not require approval booleans or repeated permission declarations. Trace each setting to its consumer: remove ignored options and single-value confirmations, derive built-in lifecycle behavior, and supply defaults for omitted optional metadata. Report actual effects and limitations where they help interpret results rather than asking callers to restate them.

Verify the representation consumed at the next boundary. Internal validator success does not establish JSON Schema validity or client compatibility: validate advertised input and output schemas against their declared dialect after SDK conversion, and keep generated contracts aligned. Use representative producer data and regressions that exercise the failed behavior. Platform and provider support claims require the corresponding real workflow; package startup, capability probes, and mock transport tests establish only their narrower claims. Report unverified coverage explicitly.

Bind tool handlers to named contracts, preserving their exact input and output types. Catalog ordering is presentation metadata; changing that order must not select a different schema or operation for an existing handler.

## Designing MCP Tools

Start from the analyst question and desired result, not a provider API. Before adding a tool, inspect the existing contract and its nearest alternative.

Let agents compose experiments with ordinary commands, scripts, and local fixture servers. REA tools should perform the requested inspection or capture and return evidence. A custom orchestration language, replay engine, or separate prepare/execute plan needs an observed requirement that those primitives cannot satisfy. A plan-only tool without an executor does not establish runtime behavior; expose the useful inspection directly.

- Prefer reusable, composable primitives: inspect one explicit object or
  relationship and return evidence that can support different analyst
  questions. Compose primitives into a workflow only for a recurring outcome
  that benefits from joining evidence sources; keep one-application or
  business-domain interpretations out of general tool contracts.
- Use **inspect/search** tools for facts about a target or candidate set; use **trace** tools for relationships; use **compare** tools for explicitly paired inputs.
- Add a **workflow** when observed agent use shows a repeated sequence that REA can compose without losing analyst control. Return useful results inline so callers can choose their next action.
- Use **observe/capture** only when runtime activity is required, and declare authority and lifecycle effects in the contract.
- Extend an existing tool when intent and result contract are unchanged. Add a tool for a distinct analyst outcome or materially different authority.
- Keep caller-facing names and results provider-neutral. Put engine-specific behavior in provider adapters and report each provider's exact coverage.
- Keep results complete by default. Add a limit only when it follows from a real format, protocol, authority, or resource-safety constraint; explain truncation and unsupported facets. Keep observed, derived, inferred, and unknown results distinct.
- Include artifact identity, source locations, Evidence references, actionable errors, and relevant limitations when they affect conclusions. Return the evidence needed for the next analysis inline rather than requiring a resource or identifier lookup.
- Implement shared application workflows behind CLI and MCP adapters. Update canonical contracts and generated catalog together.

See [docs/tool-design.md](docs/tool-design.md) for the design checklist. When usability or tool selection changes, evaluate representative CLI/MCP tasks as well as schema and transport behavior.

## Testing Guidelines

Name tests `*.test.ts`. Use Vitest and production seams (`tests/fixtures/`) rather than module mocks. Domain tests assert pure behavior; adapter tests use fake launcher/socket seams; MCP tests connect with the client SDK version pinned in `package.json`. Preserve the canonical tool inventory defined by `TOOL_CONTRACTS` and verified through `CATALOG_IDENTITY` and generated product metadata. Cover malformed input, cancellation, lifecycle cleanup, and actual format, protocol, host-permission, and target-identity boundaries. Do not add tests that merely freeze arbitrary caps or prescribed call sequences. Real Hopper, Ghidra, browser, managed conformance, and any real managed-tool claims cannot be replaced by mocks; use the corresponding `verify:*` command.

Keep tool catalogs complete and self-describing; prefer capability- and session-scoped availability over schema truncation. Serialized bytes alone do not measure agent usability or model context cost.

## Cursor Cloud specific instructions

Development requires Node.js 24.18.0 and npm 11.16.0 (`.nvmrc` and `packageManager`). The Cloud Agent image places an older `node` on `PATH` ahead of a normal install. Environment setup installs the pinned toolchain under `/usr/local` and prepends `/usr/local/bin` for login shells. Confirm `node -v` is `v24.18.0` before installing dependencies.

`npm ci` installs locked dependencies. `npm run build:cached` produces the CLI and MCP server. `npm run check:fast` is the pre-push typecheck and lint. Hopper, Ghidra, and IDA are optional bring-your-own providers. JavaScript analysis and the deterministic Vitest suites do not need them. `rea doctor` reports those engines as missing until they are configured.

## Commit & Pull Request Guidelines

Use Conventional Commit subjects because Release Please derives versions and changelogs from them. Examples: `feat: add historical source import`, `fix(process): stop timers after exit`, and `docs: update architecture`. Use `!` or a `BREAKING CHANGE:` footer for breaking changes. Pull request titles must follow the same format because squash merges use the title as the release commit. Pull requests should describe contract or behavior changes, list verification commands, link issues, and include sanitized MCP examples when schemas change. State whether real Hopper/Ghidra verification was performed. Never commit binaries, Hopper or Ghidra project documents, credentials, `dist/`, `node_modules/`, or local planning artifacts (e.g. `.codex/`).

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
