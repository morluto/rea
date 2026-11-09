# JavaScript per-file worker timeout continuation policy

## Problem and outcome

During multi-file `analyze_javascript_application` runs, per-file worker
`AnalysisResourceConstraintError` failures recorded the unavailable source and
continued analyzing remaining files, whereas a single per-file
`AnalysisTimeoutError` (`analysis_timeout_ms`) unconditionally aborted the loop
and left every subsequent application chunk `"not-started"`. Add an explicit
`timeout_policy` (`"stop" | "record-and-continue"`, defaulting to `"stop"`) so
callers can opt in to recording timed-out vendor bundles as partial coverage and
continuing across remaining files in a fresh worker subprocess.

## Requirements

- **R1 — Backward-compatible default `"stop"` contract**: Keep `timeout_policy`
  optional, omit it from `Evidence.parameters` when unset so default calls
  preserve identical `evidence_id` digests, and preserve `"stop"` behavior by
  attaching partial `Evidence` to `provider_timeout` and halting remaining files.
- **R2 — Opt-in `"record-and-continue"` partial Evidence**: When
  `timeout_policy: "record-and-continue"` (CLI `--timeout-policy record-and-continue`)
  is selected and caller cancellation has not fired, terminate and await the
  timed-out worker subprocess, record the timed-out source as an `unknown`
  `analyze-javascript-source` record (`analysis_status: "interrupted"`,
  `limits.worker_timeout_ms`, `graph.coverage.status: "partial"`,
  `semantic_graph.coverage.status: "partial"`, and
  `javascript_analysis_worker_timeout_ms` in `graph.coverage.limits`), and
  continue analyzing remaining files (and preload discovery) in a newly spawned
  worker.
- **R3 — Parent result capacity and cancellation precedence**: Honor caller
  `AbortSignal` cancellation immediately and escalate to `AnalysisResourceConstraintError`
  (`parent_result_budget_exhausted: true`) if retaining a static checkpoint from
  a timed-out worker exhausts the parent result-byte budget.
- **R4 — Explicit per-source deadline semantics**: Document in CLI options, MCP
  tool contracts, and owning guides that `analysis_timeout_ms` bounds each
  worker invocation per source rather than imposing a separate whole-run
  wall-clock deadline.

## Acceptance

- **R1 & R2**: Verified by
  `tests/boundary/filesystem/javascriptSingleFileAndTimeoutPolicy.test.ts`
  (controlled-port `"stop"` versus `"record-and-continue"` behavior and real
  worker-subprocess timeout termination and replacement across subsequent files)
  and `tests/acceptance/applications/javascriptAnalysisLimits.test.ts` (end-to-end
  CLI `--timeout-policy record-and-continue` partial `Evidence` output).
- **R3**: Verified by
  `tests/boundary/javascript/javascriptParentResultAdmission.test.ts`
  (`unadvertised-checkpoint` and `advertised-checkpoint-racing-timeout` parent
  capacity enforcement in `JavaScriptAnalysisWorker.#withParentCapacityFailure`)
  and `tests/boundary/javascript/javascriptApplicationCancellation.test.ts`
  (caller cancellation precedence).
- **R4**: Verified by `src/contracts/javascriptRouteDeliveryContracts.test.ts`,
  `tests/boundary/cli/electronCli.test.ts`, `npm run mcp-catalog:check`, and
  `npm run docs:check`.

## Out of scope

Changing the default `timeout_policy` away from `"stop"` or introducing a
separate aggregate multi-file wall-clock timeout parameter beyond caller
`AbortSignal` cancellation and `source_paths` scoping.
