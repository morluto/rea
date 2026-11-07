# Operation-focused provider discovery

Issue: https://github.com/morluto/rea/issues/8565

## Problem and outcome

When the selected deep provider refuses an operation, an agent needs to know
whether another registered provider could serve that one tool. The default
`binary_session` summary omits candidate operation declarations. The complete
view contains them, but in the measured Kuna setup the whole report was 74,348
bytes, more than some clients return inline. Add a single-tool view that answers
the candidate question with only the facts needed for that tool.

## Requirements

- `binary_session` accepts `detail: "operation"` with a required `operation`
  tool name. `operation` is rejected with any other detail, and an operation
  view without `operation` is rejected. Both are refused before candidate
  discovery and, over MCP, before family availability probes.
- The tool's provider requirements come from the compositions that decide its
  availability: its own operation, an enhanced workflow's requirements, or the
  navigation modes of `get_navigation_context`. Groups satisfied by any one
  operation and per-mode requirements stay visible.
- Only tools whose every required operation is declared by some deep provider
  are in scope. Unknown tools, tools served outside deep providers and tools
  hidden by the registered MCP tool families are invalid input.
- Each candidate reports four separate facts: availability, target support,
  selection and the provider's declaration of each required operation
  (`available`, `unavailable` with its reason and code, or `not_declared`), with
  missing operations, per-mode status and the default mode where relevant. No
  combined suitability verdict is produced.
- `unknown` target support stays `unknown`. A declared operation on an
  unavailable provider stays declared. An operation its provider marks
  readiness-gated counts as declared; an operation-specific limit stays
  unavailable even when it shares the provider's rejection code.
- A resource-only session reports target-free candidates in this view; summary
  and complete keep their existing candidate lists.
- The query selects, opens and switches no provider, retries nothing, and leaves
  the binding, target, run and Evidence state unchanged.
- `tool_availability` keeps only the requested tool's entry. Omitted fields are
  listed in `omitted_fields`.
- CLI `rea capabilities --operation <tool>` returns the same candidate
  projection from the same application owner.
- `summary` and `complete` output is unchanged.

## Acceptance

- Application tests cover readiness versus declaration, unknown and unsupported
  target support, no alternative, composed and per-mode requirements,
  navigation modes, resource-only sessions, readiness-gated declarations and
  limits that share a provider code, and invalid input before discovery.
- MCP tests cover summary/complete stability, the detail-keyed output schema,
  unchanged session identity across the query, hidden families and admission
  before probes.
- Provider tests show IDA, Kuna and Ghidra's Windows readiness paths marking only
  readiness-gated operations, with Ghidra's Windows edit ban left unmarked.
- A CLI test covers `capabilities --operation`.
- A real-provider run records the view, the actual operation result and
  unchanged session state, and reports the providers and hosts actually used.

## Out of scope

Automatic provider selection or fallback, re-running a refused operation,
candidate projection for auxiliary workflows and the `binary_overview` helper
shortcut, and any claim about tokens, latency or agent success rate.
