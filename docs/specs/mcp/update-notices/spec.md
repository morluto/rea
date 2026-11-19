# Opt-in MCP release notices

Scope: proposed in [#6477](https://github.com/morluto/rea/pull/6477). No linked
issue or separate maintainer scope decision is recorded.

A long-running MCP registration keeps serving the version it started with. The
user of that client has no signal that a newer `rea-agents` release exists
unless they check outside the session. The current contract is owned by
[MCP update notices](../../../reference/mcp-contracts.md#update-notices).

## Requirements

1. Release checks are offline by default. Only `REA_MCP_UPDATE_CHECK=1` in the
   server environment enables them; omission, `0` and any other value stay
   offline.
2. A tool request starts the lookup in the background and never waits for it.
   Discovery alone starts none. The lookup requests only the public
   `rea-agents` dist-tags from `registry.npmjs.org`, refuses redirects, sends no
   target, Evidence, client, configuration or session data, and is bounded by a
   five-second deadline and a 16 KiB metadata ceiling.
3. Each connection owns its lookup state in memory. A lookup, successful or
   not, is repeated on a tool request only after 24 hours. A failed or invalid
   refresh retains an earlier observation; a successful one replaces it, or
   clears it when no newer release is reported.
4. A newer release is announced as an MCP `notifications/message` with level
   `notice` and logger `rea.update`, related to the request whose successful
   tool result it accompanies. A result with `isError: true` does not carry or
   consume the notice. A notification that does not fit the configured receive
   budget is withheld and stays pending.
5. A connection attempts each version at most once. The attempt is recorded
   before sending, so a filtered or failed delivery is not retried.
6. Tool results, their target-content provenance markers, Evidence and catalog
   schemas are unchanged. A lookup or notification failure never changes or
   delays an analysis result.
7. Closing a transport or the server cancels the connection's pending lookup
   and joins it. The server keeps that ownership after the SDK has discarded a
   closed transport. Each HTTP session receives fresh notice state.
8. The deferred and the eager startup paths apply the same opt-in.

## Acceptance

Source tests cover the opt-in parsing, lookup bounds and failure outcomes, the
24-hour interval, retention across failed refreshes, single announcement under
concurrent requests, receive-budget and client log-level handling, the
error-then-success sequence, cancellation and joining at close, and HTTP session
replacement. Compiled stdio acceptance cases cover the offline, deferred and
eager entries against a deterministic registry seam.

## Non-goals

The server does not install updates, write configuration, reconnect clients or
persist lookup results to disk. `rea setup` does not forward the opt-in into
client registrations. How a client presents logging notifications to a user or
an AI is outside this feature.
