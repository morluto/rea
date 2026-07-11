# Repository Guidelines

## Project Structure & Module Organization

Runtime code lives under `src/`. `src/main.ts` is the composition root; `src/hopper/` owns Hopper launch and Unix-socket protocol mechanics; `bridge/hopper_bridge.py` adapts declared operations to Hopper's public Python API; `src/server/` translates MCP requests; `src/application/` implements enhanced workflows; and `src/domain/` contains pure parsers, analysis, errors, and results. Schemas live in `src/contracts/`, tests in `tests/`, and migration state in `.codex/hopper-mcp-typescript-v2/`.

## Build, Test, and Development Commands

- `npm ci`: install exact lockfile dependencies.
- `npm run build`: compile `src/` into `dist/`.
- `npm test`: build, then run the Vitest suite once.
- `npm run typecheck`: run strict TypeScript checks without emitting files.
- `npm run lint`: apply type-aware ESLint rules.
- `npm run format:check`: verify Prettier formatting.
- `npm run check`: run all static checks, tests, and the production build.
- `HOPPER_TARGET_PATH=/path/to/binary npm start`: launch Hopper and run the built stdio MCP server.

## Coding Style & Naming Conventions

Use ESM TypeScript, two-space indentation, and Prettier defaults. Keep compiler strictness intact. Use `camelCase` for values/functions, `PascalCase` for classes/types, and `UPPER_SNAKE_CASE` for constants. Parse unknown values at every MCP, environment, and subprocess boundary. Avoid `any`, unchecked casts, non-null assertions, import-time I/O, and floating promises. Exported APIs require concise JSDoc. Model expected failures with the tagged error algebra and `Result`, not broad exception wrappers.

## Testing Guidelines

Name tests `*.test.ts`. Use Vitest and production seams rather than module mocks. Domain tests assert pure behavior; adapter tests use the fake launcher/socket; MCP tests connect with the beta.3 client. Preserve the 31 established plus 8 enhanced tool inventory. Cover malformed input, cancellation, timeouts, process exit, concurrency, limits, and clean shutdown. Real Hopper claims cannot be replaced by mocks.

## Commit & Pull Request Guidelines

Use concise imperative subjects, optionally scoped, such as `Add Hopper timeout classification`. Pull requests should describe contract or behavior changes, list verification commands, link issues, and include sanitized MCP examples when schemas change. State whether real Hopper verification was performed. Never commit binaries, Hopper documents, credentials, `dist/`, or `node_modules/`.
