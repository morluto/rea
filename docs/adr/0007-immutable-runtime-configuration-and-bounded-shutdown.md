# ADR-0007: Immutable runtime configuration and bounded shutdown

- Status: Proposed
- Date: 2026-10-08
- Implementation status: Not implemented. The current SIGHUP handler updates a
  disconnected configuration object, and shutdown can wait indefinitely for
  active calls or provider closure.

## Context

The MCP entry point constructs its logger, session, provider registry, server,
and transport from startup configuration. The SIGHUP path reparses environment
state but does not atomically rebuild or update those components. Reporting that
configuration was reloaded would therefore be misleading.

Shutdown awaits active calls and multiple cleanup paths without an outer
deadline. A hung transport, request, provider, or platform cleanup can keep the
process alive indefinitely.

## Decision proposal

1. Treat runtime configuration as immutable after startup. SIGHUP reports
   `restart_required` and does not mutate a shadow configuration object.
2. A future live-reload feature requires a separate ADR that classifies every
   field as live-reloadable, session-restart-required, or process-restart-required
   and defines one atomic generation transition.
3. Shutdown enters a visible state machine:
   - stop admitting work;
   - abort/cancel active operations;
   - close transport;
   - drain sessions until a bounded deadline;
   - stop owned providers and platform helpers;
   - verify owned-process cleanup;
   - emit a structured completion or incomplete-cleanup result;
   - terminate with a documented non-zero code if the outer deadline expires.
4. Each shutdown phase receives a sub-deadline within one outer process deadline.
   No cleanup promise can extend process lifetime indefinitely.
5. Forced termination is a last resort and preserves enough bounded diagnostic
   context to identify the incomplete owner without leaking secrets.
6. CLI one-shot workflows retain `try/finally` ownership. Android CLI execution
   must enter its cleanup scope before service execution so thrown operations
   cannot bypass provider closure.

## Options considered

### Preserve the current shadow reload

Rejected. It changes state that running components do not consume and creates a
false operational signal.

### Implement full live reload now

Deferred. Provider/session reconstruction and in-flight request semantics need a
larger transactional design than the current production-readiness slice.

### Immutable configuration plus bounded shutdown

Proposed. It is simple, truthful, and establishes deterministic process
lifecycle behavior.

## Consequences

- Operators restart REA to apply environment/configuration changes.
- Shutdown may exit non-zero after the deadline even if some best-effort cleanup
  continues at the operating-system boundary.
- Tests need permanently pending calls/providers, repeated signals, stdin EOF,
  cancellation, and cleanup-rejection cases.
- Implementing this ADR changes observable lifecycle behavior and requires a
  focused compatibility review before acceptance.

## Acceptance tests

- SIGHUP leaves runtime behavior and configuration generation unchanged and
  returns a restart-required diagnostic.
- A permanently pending request cannot keep the process alive beyond the outer
  deadline.
- Repeated signals are idempotent and do not start competing shutdowns.
- Android CLI provider closure runs after execution errors and cancellation.
- Owned process groups/jobs are either verified stopped or named in the
  incomplete-cleanup result.
