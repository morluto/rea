# Implementation plan

## Boundary and contract

Add `javaScriptTimeoutPolicySchema` (`z.enum(["stop", "record-and-continue"])`)
and optional `timeout_policy` to `analyzeJavaScriptApplicationInputSchema` in
`src/domain/javascript/javascriptApplicationAnalysis.ts`, `--timeout-policy` in
`src/cli/electronCommands.ts`, and `timeout_policy` in
`src/contracts/javascript/electronToolContracts.ts`. Record `timeout_policy` in
`Evidence.parameters` only when explicitly supplied by the caller.

Update `src/application/javascript/JavaScriptPreloadDiscovery.ts`,
`src/application/javascript/JavaScriptArtifactAnalysis.ts`, and
`src/javascript/analysis/JavaScriptAnalysisWorker.ts` (`#withParentCapacityFailure`)
so per-file `AnalysisTimeoutError` under `timeout_policy: "record-and-continue"`
checks parent result-byte capacity and caller `AbortSignal` state before
recording the timed-out file (`status: "interrupted"`, `worker_timeout_ms`) and
advancing to subsequent files in a fresh worker process.

## Incremental work and validation

1. Add `javaScriptTimeoutPolicySchema`, CLI `--timeout-policy`, and MCP contract
   documentation while omitting unset `timeout_policy` from `Evidence.parameters`.
2. Enforce `#withParentCapacityFailure` on racing static checkpoints in
   `JavaScriptAnalysisWorker.ts` before returning `AnalysisTimeoutError`.
3. Handle `timeout_policy: "record-and-continue"` in `JavaScriptPreloadDiscovery.ts`
   and `JavaScriptArtifactAnalysis.ts`, recording `interrupted` source diagnostics
   and spawning a fresh worker for remaining sources.
4. Link controlled-port, real-worker subprocess, parent-capacity, CLI, and MCP
   tests to requirements and update the
   [JavaScript artifact reconstruction guide](../../../guides/javascript/javascript-artifact-reconstruction.md).

## Effects and compatibility

Default `analyze_javascript_application` calls continue using `"stop"` with
unchanged `Evidence.parameters`, error projections, and `evidence_id` digests.
Timed-out child worker processes are terminated and awaited before replacement
workers start.
