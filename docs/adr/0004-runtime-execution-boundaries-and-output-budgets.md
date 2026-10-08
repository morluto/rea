# ADR-0004: Runtime execution boundaries and output budgets

- Status: Accepted
- Date: 2026-10-08
- Implementation status: Partially implemented. Native command capture and CDP
  discovery now have fixed byte ceilings, and `capture_process_scenario` is
  truthfully marked destructive. Default-disabled process execution, environment
  scrubbing, and an external sandbox remain required before the default MCP
  surface is considered hardened.

## Context

REA intentionally composes external reverse-engineering tools and can capture a
caller-selected process scenario. Those operations cross the host-execution
boundary: they can consume unbounded output, inherit ambient authority, write
files, contact the network, or expose environment data. MCP annotations are
client hints, not a security boundary.

Several process adapters historically accumulated complete stdout and stderr.
CDP discovery similarly accepted an unbounded local HTTP response. A noisy or
hostile local process could therefore exhaust the REA host even when the
operation eventually failed.

## Decision

1. Every process, protocol, and local HTTP boundary has an explicit byte,
   time, item-count, and nesting budget. A missing budget is a defect, not an
   invitation to retain everything.
2. Diagnostic capture keeps a bounded tail or fails with a typed resource-limit
   error. Limits apply before decoding and parsing.
3. Tools that launch caller-selected executables are classified as destructive
   and as host-code execution regardless of their normal investigative intent.
4. MCP process execution is disabled by default in the hardened profile. Enabling
   it requires explicit startup policy, a scrubbed environment, constrained
   working roots and executable policy, and an independent caller/user approval
   boundary. Tool annotations never satisfy that approval.
5. Passive browser discovery remains loopback-only and additionally enforces
   connect/response deadlines, response-byte limits, bounded target counts, and
   bounded strings.
6. New provider adapters must declare their execution and retention budgets in
   their contract tests.

## Options considered

### Retain complete diagnostics

Rejected. It preserves maximum debugging detail but gives an untrusted producer
control over REA heap growth.

### Optional limits at individual call sites

Rejected. Callers omit optional policies over time, producing inconsistent
protection.

### Foundational defaults with narrower caller overrides

Accepted. The foundation remains safe when a call site forgets to opt in, while
specific providers may choose a smaller documented limit.

## Consequences

- Extremely large command output can fail with `output-limit` instead of being
  returned incompletely as if it were complete.
- Tests must cover stdout and stderr floods, slow/stalled producers, and cleanup
  after limit termination.
- Process capture cannot be described as passive or non-destructive.
- Provider-specific limits become part of compatibility and operational
  observability.

## Follow-up

- Add a default-disabled MCP configuration gate for caller-selected process
  execution.
- Scrub inherited environment variables and document the minimum retained set.
- Add a dedicated worker/sandbox profile where supported; fail closed rather
  than silently degrading.
- Extend the same mandatory budget policy to every `ProviderProcessSupervisor`
  caller.
