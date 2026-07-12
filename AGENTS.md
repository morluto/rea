# Repository Guidelines

## Project Structure & Module Organization

REA is a layered ESM TypeScript application. Dependencies flow inward: `domain` ← `contracts` ← `hopper` ← `application` ← `server` ← adapters.

See [docs/architecture.mermaid](docs/architecture.mermaid) for a visual architecture diagram.

- `scripts/rea.mjs`: executable dispatcher. Routes only bare `mcp` and `--mcp` to the production stdio server; Incur handles registration utilities and one-shot commands.
- `src/main.ts`: MCP adapter. Parses config, wires the shared session runtime, starts stdio transport, and owns process-lifetime shutdown.
- `src/cli.ts`: one-shot CLI adapter for setup, diagnostics, analysis, and decompilation.
- `src/config.ts`: Zod-validated parsing of environment configuration into `AppConfig`.
- `src/domain/`: pure, side-effect-free modules. `errors.ts` (tagged error algebra), `result.ts` (`Result`/`ok`/`err`), `hopperValues.ts` (boundary parsers for Hopper JSON), `symbolAnalysis.ts` (Swift/ObjC name parsing).
- `src/contracts/`: caller-visible schemas for 33 direct, 10 enhanced, 5 native, 2 artifact, and 18 session tools; `enhancedInputs.ts` owns enhanced input parsing.
- `src/hopper/`: Hopper launch and Unix-socket protocol mechanics. `BridgeLauncher.ts` spawns the Hopper app with the in-process bridge, `HopperClient.ts` correlates request/response over the socket with timeouts and cancellation, `protocol.ts` frames bridge messages.
- `bridge/hopper_bridge.py`: runs inside Hopper and adapts declared operations to Hopper's public Python API. Hopper's bundled MCP server is not used.
- `src/application/`: shared CLI/MCP session composition, setup and diagnostics, and the 8 enhanced workflows.
- `src/server/`: MCP request translation. `createServer.ts` assembles the MCP server, `registerOfficialTools.ts`/`registerEnhancedTools.ts` register each tool set, `toolResult.ts` maps `Result` values to MCP content.
- `tests/`: Vitest suite. `tests/fixtures/` holds the fake launcher and fake Hopper bridge used as production seams.
- `scripts/verify-real-hopper.mjs`: real-Hopper end-to-end verifier.
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
- `npm run verify:package`: pack and test the CLI, setup transaction, skill, and 68-tool target-free MCP server in an isolated environment.
- `npm run docs:generate`: generate API documentation from JSDoc comments into `docs/api/` using TypeDoc.
- `npm run config:print -- /path/to/binary`: print an MCP server config with absolute paths.
- `HOPPER_TARGET_PATH=/path/to/binary npm start`: launch Hopper and run the built stdio MCP server.

Pre-commit hooks via Husky run `oxlint` on staged files before every commit. Use `npm run lint:fix` to auto-correct violations locally.

## Configuration & Environment Variables

- `HOPPER_TARGET_PATH` (optional): absolute initial binary or `.hop` target. Target-free MCP sessions use `open_binary` instead.
- `HOPPER_LAUNCHER_PATH` (optional): override the Hopper executable path (defaults to `/Applications/Hopper Disassembler.app/Contents/MacOS/hopper`).
- `HOPPER_TARGET_KIND` (optional, default `executable`): startup kind for `HOPPER_TARGET_PATH`; dynamic targets are classified from their paths and headers.
- `HOPPER_LOADER_ARGS_JSON` (optional): JSON array overriding derived Hopper loader arguments for supported executable targets, e.g. `["-l","Mach-O","--aarch64"]`.

## Coding Style & Naming Conventions

Use ESM TypeScript, two-space indentation, and Prettier defaults. Keep compiler strictness intact (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`). Use `camelCase` for values/functions, `PascalCase` for classes/types, and `UPPER_SNAKE_CASE` for constants. Parse unknown values at every MCP, environment, and subprocess boundary. Avoid `any`, unchecked casts, non-null assertions, import-time I/O, and floating promises. Exported APIs require concise JSDoc. Model expected failures with the tagged error algebra and `Result`, not broad exception wrappers.

## Testing Guidelines

Name tests `*.test.ts`. Use Vitest and production seams (`tests/fixtures/`) rather than module mocks. Domain tests assert pure behavior; adapter tests use the fake launcher/socket; MCP tests connect with the beta.3 client. Preserve the 33 direct, 10 enhanced, 5 native, 2 artifact, and 18 session tool inventory (68 total). Cover malformed input, cancellation, timeouts, process exit, concurrency, limits, and clean shutdown. Real Hopper claims cannot be replaced by mocks — use `npm run verify:hopper` with two distinct binaries for end-to-end verification.

## Commit & Pull Request Guidelines

Use Conventional Commit subjects because Release Please derives versions and changelogs from them. Examples: `feat: add historical source import`, `fix(process): stop timers after exit`, and `docs: update architecture`. Use `!` or a `BREAKING CHANGE:` footer for breaking changes. Pull request titles must follow the same format because squash merges use the title as the release commit. Pull requests should describe contract or behavior changes, list verification commands, link issues, and include sanitized MCP examples when schemas change. State whether real Hopper verification was performed. Never commit binaries, Hopper documents, credentials, `dist/`, `node_modules/`, or local planning artifacts (e.g. `.codex/`).
