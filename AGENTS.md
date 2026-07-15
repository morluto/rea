# Repository Guidelines

## Product Direction

REA exposes reverse-engineering tools through a CLI and MCP server. Hopper is the current operation-capable deep binary-analysis provider. The Linux x64 Ghidra provider currently supplies discovery, exact profile commitment, and a private read-only headless session but intentionally declares no binary operations. Keep provider-specific code out of the domain and application layers.

Prioritize:

- tool results that distinguish observations, inferences, and unknowns;
- equivalent behavior through the CLI and MCP;
- additive, idempotent configuration with backups;
- end-to-end tests for packaged artifacts and real Hopper/Ghidra claims.

Installers must not install or upgrade Homebrew, Node.js, npm, Java, Ghidra, or other unrelated software. Ghidra is bring-your-own. `rea setup` must print its planned changes and require approval before writing files or installing Hopper.

REA is a local-only tool; do not sanitize actionable local diagnostics such as artifact paths, digests, mismatch locations, or analysis metadata, while continuing to redact genuine secrets such as credentials and authorization headers.

## Project Structure & Module Organization

REA is a layered ESM TypeScript application. Dependencies flow inward: `domain` underlies `contracts` and the shared `process` primitives; providers depend on those layers, followed by `application`, `server`, and the entry adapters.

See [docs/architecture.mermaid](docs/architecture.mermaid) for a visual architecture diagram.

- `scripts/rea.mjs`: executable dispatcher. Routes only bare `mcp` and `--mcp` to the production stdio server; Incur handles registration utilities and one-shot commands.
- `src/main.ts`: MCP adapter. Parses config, wires the shared session runtime, starts stdio transport, and owns process-lifetime shutdown.
- `src/cli.ts`: one-shot CLI adapter for setup, diagnostics, analysis, and decompilation.
- `src/config.ts`: Zod-validated parsing of environment configuration into `AppConfig`.
- `src/domain/`: pure, side-effect-free modules. `errors.ts` (tagged error algebra), `result.ts` (`Result`/`ok`/`err`), `hopperValues.ts` (boundary parsers for Hopper JSON), `symbolAnalysis.ts` (Swift/ObjC name parsing).
- `src/contracts/`: caller-visible schemas for 33 direct, 10 enhanced, 5 native, 2 artifact, 8 browser, 2 Electron, and 18 session tools; `enhancedInputs.ts` owns enhanced input parsing.
- `src/process/`: provider-neutral process ownership and lifecycle primitives. It owns private runtime roots, absolute startup deadlines, correlated request waits, bounded output capture, and TERM-to-KILL cleanup without defining any provider wire protocol.
- `src/browser/`: loopback CDP discovery, bounded WebSocket transport, exact-origin target authorization, and passive browser observation normalization.
- `src/hopper/`: Hopper launch and Unix-socket protocol mechanics. `BridgeLauncher.ts` spawns the Hopper app with the in-process bridge, `HopperClient.ts` correlates request/response over the socket with timeouts and cancellation, `protocol.ts` frames bridge messages.
- `bridge/hopper_bridge.py`: runs inside Hopper and adapts declared operations to Hopper's public Python API. Hopper's bundled MCP server is not used.
- `src/ghidra/`: exact Ghidra 12.1.2/JDK 21 installation inspection, analysis-profile commitment, isolated `analyzeHeadless` launch, authenticated Unix-socket client, and the intentionally capability-empty provider foundation.
- `bridge/ghidra/ReaGhidraBridge.java`: packaged `HeadlessScript` loaded through Ghidra's `scriptPath`; it reports post-analysis identity and supports only authenticated `ping`/`shutdown` in the foundation release.
- `src/application/`: shared CLI/MCP session composition, setup and diagnostics, and enhanced workflows. `AnalysisProviderRegistry` discovers overlapping deep candidates without starting them; `SessionProviderRouter` binds one candidate per target and composes it with disjoint auxiliary providers.
- `src/server/`: MCP request translation. `createServer.ts` assembles the MCP server, `registerOfficialTools.ts`/`registerEnhancedTools.ts` register each tool set, `toolResult.ts` maps `Result` values to MCP content.
- `docs/product-catalog.json`: generated package, tool-family, provider, setup-client, schema-version, and CLI facts. Regenerate it from source; do not edit it by hand.
- `tests/`: Vitest suite. `tests/fixtures/` holds reusable provider-process fixtures plus the fake launcher, Hopper bridge, and CDP seams.
- `scripts/verify-real-hopper.mjs`: real-Hopper end-to-end verifier.
- `scripts/verify-real-ghidra.mjs`: real Linux Ghidra verifier for one isolated read-only import, handshake, and complete cleanup.
- `scripts/verify-real-browser.mjs`: real Chrome end-to-end verifier for the passive CDP provider.
- `scripts/print-mcp-config.mjs`: prints an MCP server config with absolute paths filled in (`npm run config:print -- /path/to/binary`).

## Build, Test, and Development Commands

- `npm ci`: install exact lockfile dependencies.
- `npm run build`: compile `src/` into `dist/`.
- `npm test`: build, then run the Vitest suite once.
- `npm run typecheck`: run strict TypeScript checks without emitting files.
- `npm run lint`: apply oxlint rules (complexity, max-lines, unused vars, and TypeScript-specific checks).
- `npm run lint:fix`: auto-fix oxlint violations where possible.
- `npm run format:check`: verify Prettier formatting.
- `npm run check`: run typecheck, lint, format:check, and tests.
- `npm run knip`: detect unused files, dependencies, and exports.
- `npm run jscpd`: detect duplicate code blocks.
- `npm run scan:todos`: scan for TODO, FIXME, and HACK markers.
- `npm run verify:hopper`: build and run the real-Hopper verifier with two distinct binaries.
- `npm run verify:ghidra`: build and run the real-Ghidra verifier against `GHIDRA_INSTALL_DIR` and optional `GHIDRA_TARGET_PATH`.
- `npm run verify:browser`: build and run the real Chrome verifier against `REA_BROWSER_EXECUTABLE` or a platform-default Chrome-family executable.
- `npm run verify:package`: pack and test the CLI, setup transaction, skill, and 78-tool target-free MCP server in an isolated environment.
- `npm run docs:generate`: generate API documentation from JSDoc comments into `docs/api/` using TypeDoc.
- `npm run docs:check`: verify generated package metadata, the canonical product catalog, caller-visible documentation facts, TypeDoc output, and the error JSON schema without rewriting them.
- `npm run config:print -- /path/to/binary`: print an MCP server config with absolute paths.
- `HOPPER_TARGET_PATH=/path/to/binary npm start`: launch Hopper and run the built stdio MCP server.

Pre-commit hooks via Husky run `oxlint` on staged files before every commit. Use `npm run lint:fix` to auto-correct violations locally.

## Configuration & Environment Variables

- `REA_ANALYSIS_PROVIDER` (optional, default `auto`): require one deep-analysis provider ID for startup and one-shot commands, or use deterministic automatic selection. A request-level `provider_id`/`--provider` takes precedence.
- `GHIDRA_INSTALL_DIR` (optional): absolute root of an extracted official Ghidra 12.1.2 distribution. The current adapter supports Linux x64 only.
- `JAVA_HOME` (optional): absolute 64-bit full JDK 21 root used by Ghidra. When absent, doctor probes `java`/`javac` from `PATH`.
- `HOPPER_TARGET_PATH` (optional): absolute initial binary or `.hop` target. Target-free MCP sessions use `open_binary` instead.
- `HOPPER_LAUNCHER_PATH` (optional): override the Hopper executable path (defaults to `/Applications/Hopper Disassembler.app/Contents/MacOS/hopper`).
- `HOPPER_TARGET_KIND` (optional, default `executable`): startup kind for `HOPPER_TARGET_PATH`; dynamic targets are classified from their paths and headers.
- `HOPPER_LOADER_ARGS_JSON` (optional): JSON array overriding derived Hopper loader arguments for supported executable targets, e.g. `["-l","Mach-O","--aarch64"]`.
- `REA_BROWSER_OBSERVE_ENABLED` (optional, default `false`): add browser observation authority to the administrator ceiling.
- `REA_BROWSER_CDP_ENDPOINTS_JSON` (optional): approved literal loopback CDP HTTP endpoints.
- `REA_BROWSER_ALLOWED_ORIGINS_JSON` (optional): exact HTTP(S) page origins approved for passive observation.

## Coding Style & Naming Conventions

Use ESM TypeScript, two-space indentation, and Prettier defaults. Keep compiler strictness intact (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`). Use `camelCase` for values/functions, `PascalCase` for classes/types, and `UPPER_SNAKE_CASE` for constants. Parse unknown values at every MCP, environment, and subprocess boundary. Avoid `any`, unchecked casts, non-null assertions, import-time I/O, and floating promises. Exported APIs require concise JSDoc. Model expected failures with the tagged error algebra and `Result`, not broad exception wrappers.

## Testing Guidelines

Name tests `*.test.ts`. Use Vitest and production seams (`tests/fixtures/`) rather than module mocks. Domain tests assert pure behavior; adapter tests use fake launcher/socket seams; MCP tests connect with the beta.3 client. Preserve the 33 direct, 10 enhanced, 5 native, 2 artifact, 8 browser, 2 Electron, and 18 session tool inventory (78 total). Cover malformed input, cancellation, timeouts, process exit, concurrency, limits, and clean shutdown. Real Hopper, Ghidra, and browser claims cannot be replaced by mocks; use `npm run verify:hopper` with two distinct binaries, `npm run verify:ghidra` with the exact supported BYO installation, and `npm run verify:browser` with Chrome.

## Commit & Pull Request Guidelines

Use Conventional Commit subjects because Release Please derives versions and changelogs from them. Examples: `feat: add historical source import`, `fix(process): stop timers after exit`, and `docs: update architecture`. Use `!` or a `BREAKING CHANGE:` footer for breaking changes. Pull request titles must follow the same format because squash merges use the title as the release commit. Pull requests should describe contract or behavior changes, list verification commands, link issues, and include sanitized MCP examples when schemas change. State whether real Hopper/Ghidra verification was performed. Never commit binaries, Hopper or Ghidra project documents, credentials, `dist/`, `node_modules/`, or local planning artifacts (e.g. `.codex/`).
