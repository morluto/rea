# Repository Guidelines

## Product Direction

REA exposes reverse-engineering tools through a CLI and MCP server. Hopper and the bring-your-own Ghidra adapter are operation-capable deep binary-analysis providers. Ghidra is supported on Linux x64 and has an experimental Windows x64 P0 boundary for approved native x86-64 PE applications; it supplies admitted read-only inventory and function-analysis operations but no GUI or mutation authority. Keep provider-specific code out of the domain and application layers.

Prioritize:

- tool results that distinguish observations, inferences, and unknowns;
- equivalent behavior through the CLI and MCP;
- additive, idempotent configuration with backups;
- end-to-end tests for packaged artifacts and real Hopper/Ghidra claims.

Installers must not install or upgrade Homebrew, Node.js, npm, Java, Ghidra, or other unrelated software. Ghidra is bring-your-own. `rea setup` must print its planned changes and require approval before writing files or installing Hopper.

REA is a local-only tool; do not sanitize actionable local diagnostics such as artifact paths, digests, mismatch locations, or analysis metadata, while continuing to redact genuine secrets such as credentials and authorization headers.

## Project Structure & Module Organization

REA is a layered ESM TypeScript application. Dependencies flow inward from pure domain logic through contracts, providers, application workflows, and CLI/MCP adapters. See [docs/architecture.mermaid](docs/architecture.mermaid) for the component map.

- `src/domain/` owns pure provider-neutral semantics; `src/contracts/` owns caller-visible schemas and the canonical tool inventory.
- `src/hopper/`, `src/ghidra/`, `src/browser/`, `src/replay/`, `src/native/`, `src/artifacts/`, and `src/dotnet/` own provider-specific boundaries. Keep provider protocols out of domain and application code.
- `src/application/` composes shared CLI/MCP workflows; `src/server/` translates MCP requests; `src/cli.ts` and `src/main.ts` are the CLI and MCP entry points.
- `src/process/` owns shared process lifecycle primitives, not provider wire protocols. `bridge/` contains provider-side adapters.
- `tests/` contains unit, composition, boundary, acceptance, and conformance tests. `scripts/verify-*` contains real-toolchain checks.
- `docs/product-catalog.json` is generated. Update its source contracts and regenerate it; do not edit it directly.

## Build, Test, and Development Commands

- `npm ci`: install the locked dependencies.
- `npm run build:cached`: build the CLI and MCP server.
- `npm run test:local`: run focused tests for changed code.
- `npm run check:fast`: run cached typecheck and lint checks.
- `npm run check:pr`: run the deterministic PR gate and generated-document checks.
- For provider-dependent changes, see [docs/testing.md](docs/testing.md) and run the matching real-provider verification.
- Keep each verification lane's prerequisites limited to the claim it checks. Use host-native fixtures for host/provider acceptance; put optional cross-target formats and their external toolchains in a separate lane. Preflight required commands and report the missing dependency and lane clearly.

See [docs/testing.md](docs/testing.md) for test scopes and verification lanes and [CONTRIBUTING.md](CONTRIBUTING.md) for contribution checks. Pre-commit formats and lints staged source; pre-push runs `npm run check:fast`.

## Configuration & Environment Variables

Configuration is parsed and validated by `src/config.ts` and `src/config/`. Keep user-facing setup and provider configuration in [README.md](README.md) and the relevant guide under `docs/`; do not maintain a second environment-variable catalogue here.

## Coding Style & Naming Conventions

Use ESM TypeScript, two-space indentation, and Prettier defaults. Keep compiler strictness intact (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`). Use `camelCase` for values/functions, `PascalCase` for classes/types, and `UPPER_SNAKE_CASE` for constants. Parse unknown values at every MCP, environment, and subprocess boundary. Avoid `any`, unchecked casts, non-null assertions, import-time I/O, and floating promises. Exported APIs require concise JSDoc. Model expected failures with the tagged error algebra and `Result`, not broad exception wrappers.

## Designing MCP Tools

Start from the analyst question and desired result, not a provider API. Before adding a tool, inspect the existing contract and its nearest alternative.

- Prefer reusable, composable primitives: inspect one explicit object or
  relationship and return evidence that can support different analyst
  questions. Compose primitives into a workflow only for a recurring outcome
  that benefits from joining evidence sources; keep one-application or
  business-domain interpretations out of general tool contracts.
- Use **inspect/search** tools for facts about a target or candidate set; use **trace** tools for relationships; use **compare** tools for explicitly paired inputs.
- Add a **workflow** when observed agent use shows a repeated sequence that REA can compose without losing analyst control. Return useful results inline so callers can choose their next action.
- Use **observe/capture/replay** only when runtime activity is required, and declare authority and lifecycle effects in the contract.
- Extend an existing tool when intent and result contract are unchanged. Add a tool for a distinct analyst outcome or materially different authority.
- Keep caller-facing names and results provider-neutral. Put engine-specific behavior in provider adapters and report each provider's exact coverage.
- Keep results complete by default. Add a limit only when it follows from a real format, protocol, authority, or resource-safety constraint; explain truncation and unsupported facets. Keep observed, derived, inferred, and unknown results distinct.
- Include artifact identity, source locations, Evidence references, actionable errors, and relevant limitations when they affect conclusions. Return the evidence needed for the next analysis inline rather than requiring a resource or identifier lookup.
- Implement shared application workflows behind CLI and MCP adapters. Update canonical contracts and generated catalog together.

See [docs/tool-design.md](docs/tool-design.md) for the design checklist. When usability or tool selection changes, evaluate representative CLI/MCP tasks as well as schema and transport behavior.

## Testing Guidelines

Name tests `*.test.ts`. Use Vitest and production seams (`tests/fixtures/`) rather than module mocks. Domain tests assert pure behavior; adapter tests use fake launcher/socket seams; MCP tests connect with the client SDK version pinned in `package.json`. Preserve the canonical tool inventory defined by `TOOL_CONTRACTS` and verified through `CATALOG_IDENTITY` and generated product metadata. Cover malformed input, cancellation, lifecycle cleanup, and actual format, protocol, and permission boundaries. Do not add tests that merely freeze arbitrary caps or prescribed call sequences. Real Hopper, Ghidra, browser, JavaScript replay, managed conformance, and any real managed-tool claims cannot be replaced by mocks; use the corresponding `verify:*` command.

Keep tool catalogs complete and self-describing; prefer capability- and session-scoped availability over schema truncation. Serialized bytes alone do not measure agent usability or model context cost.

## Commit & Pull Request Guidelines

Use Conventional Commit subjects because Release Please derives versions and changelogs from them. Examples: `feat: add historical source import`, `fix(process): stop timers after exit`, and `docs: update architecture`. Use `!` or a `BREAKING CHANGE:` footer for breaking changes. Pull request titles must follow the same format because squash merges use the title as the release commit. Pull requests should describe contract or behavior changes, list verification commands, link issues, and include sanitized MCP examples when schemas change. State whether real Hopper/Ghidra verification was performed. Never commit binaries, Hopper or Ghidra project documents, credentials, `dist/`, `node_modules/`, or local planning artifacts (e.g. `.codex/`).
