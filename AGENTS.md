# Repository Guidelines

## Project Structure & Module Organization

The server is a layered ESM TypeScript application. Dependencies flow inward: `domain` ← `contracts` ← `hopper` ← `application` ← `server` ← `main`.

- `src/main.ts`: composition root. Parses config, wires the Hopper client, starts the stdio MCP transport, and owns process-lifetime shutdown.
- `src/config.ts`: Zod-validated parsing of environment configuration into `AppConfig`.
- `src/domain/`: pure, side-effect-free modules. `errors.ts` (tagged error algebra), `result.ts` (`Result`/`ok`/`err`), `hopperValues.ts` (boundary parsers for Hopper JSON), `symbolAnalysis.ts` (Swift/ObjC name parsing).
- `src/contracts/`: caller-visible tool schemas. `toolContracts.ts` declares the 31 official-proxy + 8 enhanced tool inventory; `enhancedInputs.ts` holds Zod input schemas for enhanced tools.
- `src/hopper/`: Hopper launch and Unix-socket protocol mechanics. `BridgeLauncher.ts` spawns the Hopper app with the in-process bridge, `HopperClient.ts` correlates request/response over the socket with timeouts and cancellation, `protocol.ts` frames bridge messages.
- `bridge/hopper_bridge.py`: runs inside Hopper and adapts declared operations to Hopper's public Python API. Hopper's bundled MCP server is not used.
- `src/application/`: enhanced workflows. `HopperToolPort.ts` defines the port the official tools proxy through; `EnhancedTools.ts` implements the 8 RE-specific tools.
- `src/server/`: MCP request translation. `createServer.ts` assembles the MCP server, `registerOfficialTools.ts`/`registerEnhancedTools.ts` register each tool set, `toolResult.ts` maps `Result` values to MCP content.
- `tests/`: Vitest suite. `tests/fixtures/` holds the fake launcher and fake Hopper bridge used as production seams.
- `scripts/verify-real-hopper.mjs`: real-Hopper end-to-end verifier.

## Build, Test, and Development Commands

- `npm ci`: install exact lockfile dependencies.
- `npm run build`: compile `src/` into `dist/`.
- `npm test`: build, then run the Vitest suite once.
- `npm run typecheck`: run strict TypeScript checks without emitting files.
- `npm run lint`: apply type-aware ESLint rules.
- `npm run format:check`: verify Prettier formatting.
- `npm run check`: run typecheck, lint, format:check, and tests.
- `npm run verify:hopper`: build and run the real-Hopper verifier (requires a binary).
- `HOPPER_TARGET_PATH=/path/to/binary npm start`: launch Hopper and run the built stdio MCP server.

## Configuration & Environment Variables

- `HOPPER_TARGET_PATH` (required): absolute path to the binary or `.hop` database to analyze.
- `HOPPER_LAUNCHER_PATH` (optional): override the Hopper executable path (defaults to `/Applications/Hopper Disassembler.app/Contents/MacOS/hopper`).
- `HOPPER_TARGET_KIND` (optional, default `executable`): `executable` or `database` (for `.hop` files).
- `HOPPER_LOADER_ARGS_JSON` (optional): JSON array of strings passed to the Hopper launcher before the target, e.g. `["-l","Mach-O","--aarch64"]`.

## Coding Style & Naming Conventions

Use ESM TypeScript, two-space indentation, and Prettier defaults. Keep compiler strictness intact (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`). Use `camelCase` for values/functions, `PascalCase` for classes/types, and `UPPER_SNAKE_CASE` for constants. Parse unknown values at every MCP, environment, and subprocess boundary. Avoid `any`, unchecked casts, non-null assertions, import-time I/O, and floating promises. Exported APIs require concise JSDoc. Model expected failures with the tagged error algebra and `Result`, not broad exception wrappers.

## Testing Guidelines

Name tests `*.test.ts`. Use Vitest and production seams (`tests/fixtures/`) rather than module mocks. Domain tests assert pure behavior; adapter tests use the fake launcher/socket; MCP tests connect with the beta.3 client. Preserve the 31 official-proxy plus 8 enhanced tool inventory (39 total). Cover malformed input, cancellation, timeouts, process exit, concurrency, limits, and clean shutdown. Real Hopper claims cannot be replaced by mocks — use `npm run verify:hopper` for end-to-end verification.

## Commit & Pull Request Guidelines

Use concise imperative subjects, optionally scoped, such as `Add Hopper timeout classification`. Pull requests should describe contract or behavior changes, list verification commands, link issues, and include sanitized MCP examples when schemas change. State whether real Hopper verification was performed. Never commit binaries, Hopper documents, credentials, `dist/`, `node_modules/`, or local planning artifacts (e.g. `.codex/`).
