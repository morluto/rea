# Tasks

- [x] Add the opt-in factory and the bounded, redirect-refusing dist-tags lookup
      (R1, R2).
- [x] Keep per-connection observations with the 24-hour interval and retention
      across failed or invalid refreshes (R3).
- [x] Announce through a related logging notification on a successful tool
      result, within the receive budget, at most once per version (R4, R5).
- [x] Keep a failed tool call from carrying or consuming the notice (R4).
- [x] Leave tool results, provenance markers and schemas unchanged (R6).
- [x] Cancel and join lookups at transport and server close; give each HTTP
      session fresh state (R7).
- [x] Wire the deferred and eager startup paths (R8).
- [x] Document the contract in the MCP reference and the installation guide.
- [x] Cover the behavior with source tests and compiled stdio acceptance cases
      (acceptance).

## Verification (2026-11-19)

- On a macOS host with Node 24.22.1, at `b823bbafc`: `npm run lint` and
  `oxfmt --check .` passed, and all 259 `src/server` tests passed, including the
  27 in `src/server/UpdateNotices.test.ts`. `npm run typecheck` passed there
  with Node 26.13.0.
- The error-then-success regression failed without the `isError` guard and
  passed with it, for pinned protocol `2025-03-26` and default negotiation.
- At `cfcee508a` the three compiled acceptance cases passed, and 24 of 24
  repeated runs passed under parallel load. Before the test called until the
  notice arrived, 2 of 28 runs failed because the registry marker is written
  before the server observes the lookup result.
- The full `mcp-boundary` project passed at the earlier tree `b47ee4b00` on the
  same host. Later heads rely on CI for it.
- Not verified: how AI clients present the notice, a lookup against the real
  registry, and current startup or request performance.
- CI results are recorded in the PR.
