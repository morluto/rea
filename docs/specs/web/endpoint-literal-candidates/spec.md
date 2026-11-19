# Declared endpoint literals in web bundles

## Problem

A browser bundle declares its endpoints before it calls them: route tables,
`const`-bound base URLs and array literals carry paths that a capture may never
request. The domain analyzer reported only endpoints it could tie to an observed
request, so a script whose table was never exercised produced no endpoint
evidence at all and the analyst had no inventory to compare against. Related:
#3539.

## Requirements

- Report a declared path or URL string as an endpoint candidate when it is an
  element of a literal table or the value of a `const` initializer, and say that
  it is a declaration rather than a request.
- Bound the facet with one per-script ceiling,
  `web.bundle_endpoint_literal_candidates`, seeded by
  `REA_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES`, default 1024, accepted range
  1–4096. Reject other values through the existing setting admission.
- Keep the facet inside the existing per-script result byte budget. Never drop a
  non-literal fact to admit a literal, keep the surviving literals in source
  order, and skip a literal that does not fit instead of ending the pass.
- Record an omission once, separating literals dropped by the ceiling from those
  dropped by the byte budget, because raising the setting recovers only the
  former. A result that kept every candidate carries no record.
- Return a result that already fits unchanged, even when the omission record
  would be wider than the candidate it replaces.
- Preserve the cross-analyzer parity contract: a string passed as a call
  argument is not a declared endpoint.

## Acceptance

An array table and a `const` URL in one captured script both appear as
candidates while the same strings seen as `fetch(...)` arguments stay
observations. Lowering the ceiling to one candidate reports the remainder as a
ceiling omission naming the setting; a lowered per-script result budget reports
a byte omission naming the budget, and the two are explained with different
recovery. Raising the ceiling recovers count drops and does not recover byte
drops. The worker reports the same facts over its request and result files, and
the CLI and MCP surfaces expose the setting without changing defaults. The
existing configuration, navigation and static-analysis parity tests keep
passing.

## Non-goals

No inference from call arguments, wrapper functions or computed strings; no
synthesized requests or execution; no new byte budget of its own; no change to
route-fact collection or to the defaults of any existing setting.
