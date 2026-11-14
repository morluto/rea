# Tasks

- [x] Define per-file timeout continuation requirements, contracts, and implementation plan (`spec.md`, `plan.md`).
- [x] Add `timeout_policy` (`"stop" | "record-and-continue"`) to domain schemas, CLI `--timeout-policy`, and MCP `analyze_javascript_application` contracts while preserving default `Evidence.parameters` (**R1**, **R4**; verified in `src/contracts/javascriptRouteDeliveryContracts.test.ts` and `tests/boundary/cli/electronCli.test.ts`).
- [x] Enforce parent result-byte capacity precedence on timed-out checkpoints in `src/javascript/analysis/JavaScriptAnalysisWorker.ts` (**R3**; verified in `tests/boundary/javascript/javascriptParentResultAdmission.test.ts` and `tests/boundary/javascript/javascriptApplicationCancellation.test.ts`).
- [x] Record `interrupted` timed-out sources and continue in a fresh worker across `JavaScriptPreloadDiscovery.ts` and `JavaScriptArtifactAnalysis.ts` (**R1**, **R2**; verified in `tests/boundary/filesystem/javascriptSingleFileAndTimeoutPolicy.test.ts` and `tests/acceptance/applications/javascriptAnalysisLimits.test.ts`).
- [x] Update the JavaScript artifact reconstruction guide, skill references, and `docs/specs/README.md`; pass documentation route and static checks.
