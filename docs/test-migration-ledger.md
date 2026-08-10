# Test architecture migration ledger

This ledger records how the flat test suite was classified during the
coordinated architecture cutover. It is an evidence index, not a declaration
that every test became independent merely because its path changed.

## Classification batches

The following mappings are grounded in the current moved paths. They describe
ownership only; decomposition and evidence replacement must be recorded in the
per-suite table below.

| Previous path                                                                                       | Current path                                                                                               | Classification                            |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `tests/applicationWorkflowCli.test.ts`                                                              | `tests/acceptance/applications/applicationWorkflowCli.test.ts`                                             | Acceptance application workflow           |
| `tests/setupLifecycle.test.ts`                                                                      | `tests/acceptance/setup/setupLifecycle.test.ts`                                                            | Acceptance setup workflow                 |
| `tests/cdpBrowserProvider.test.ts`                                                                  | `tests/boundary/browser/cdpBrowserProvider*.test.ts`                                                       | Browser boundary                          |
| `tests/ghidraClient.test.ts`                                                                        | `tests/boundary/providers/ghidra/ghidraClient.test.ts`                                                     | Ghidra provider boundary                  |
| `tests/processOwnership.test.ts`                                                                    | `tests/boundary/process/processOwnership*.test.ts`                                                         | Process boundary                          |
| `tests/binarySession.test.ts`                                                                       | `tests/composition/analysis-sessions/binarySession.*.test.ts`                                              | Analysis-session composition              |
| `tests/javascriptSemanticAnalysis.test.ts`                                                          | `src/domain/javascriptSemanticAnalysis.*.test.ts`                                                          | Colocated pure-domain behavior            |
| `tests/config.test.ts`                                                                              | `src/config.test.ts`                                                                                       | Colocated configuration adapter           |
| `tests/composition/analysis-sessions/runtime.test.ts`                                               | `tests/acceptance/applications/runtime.test.ts`                                                            | Compiled MCP acceptance workflow          |
| `tests/composition/runtime-observation/webCaptureDiff.test.ts`                                      | `tests/boundary/browser/webCaptureDiff.test.ts`                                                            | Browser boundary                          |
| `tests/composition/analysis-sessions/analysisSnapshot.test.ts`                                      | `src/{application,domain}/analysisSnapshot*.test.ts`, `tests/boundary/filesystem/analysisSnapshot.test.ts` | Module behavior plus persistence boundary |
| `tests/composition/evidence-investigations/reconstructionCoverage.test.ts`                          | `src/domain/reconstructionCoverage.test.ts`, `tests/boundary/filesystem/reconstructionCoverage.test.ts`    | Domain closure plus persistence boundary  |
| `tests/conformanceFixtures.test.ts`                                                                 | `tests/conformance/providers/conformanceFixtures.test.ts`                                                  | Provider conformance                      |
| `tests/codexAgentEval.test.ts`                                                                      | `tests/evaluation/model-evals/codexAgentEval.test.ts`                                                      | Deterministic model-evaluator logic       |
| `tests/composition/analysis-sessions/{boundedCartesianProjection,symbolAnalysis,jsonShape}.test.ts` | `src/domain/{boundedCartesianProjection,symbolAnalysis,jsonShape}.test.ts`                                 | Colocated pure-domain behavior            |

The same directory mapping applies to the other files moved in each batch:
`tests/acceptance/{analysis,applications,investigations,setup}`,
`tests/boundary/{browser,cli,filesystem,mcp,process,providers}`,
`tests/composition/{analysis-sessions,evidence-investigations,javascript-applications,process-capture,runtime-observation,setup-lifecycle}`,
`tests/conformance`, and `tests/evaluation`. Git rename detection remains the
canonical source for the complete old-to-new path list.

## Per-suite evidence record

Add a row when a legacy suite is materially decomposed, consolidated, replaced,
or removed. “Replacement evidence” must identify executable behavior, a
generated artifact comparison, a protocol probe, or an explicit verifier; a new
path alone is not replacement evidence.

| Legacy suite or claim                           | Disposition           | Replacement evidence                                                                                                                                                                               | Validation                                                                                           | Remaining gap                                                                               |
| ----------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Flat path classification                        | Moved                 | Vitest configuration contract proves every deterministic test belongs to exactly one project                                                                                                       | Configuration contract test                                                                          | Record any exceptions discovered during cutover                                             |
| Direct session construction outside owner tests | Consolidated          | Production exposes `composeBinarySession`; tests use `createTestBinarySession` over the fixed-provider router without widening the production constructor                                          | Repository search plus session-composition and acceptance tests                                      | None                                                                                        |
| Repeated temporary-directory setup              | Consolidated          | `createTestTempDirectory` delegates every test-owned root to the typed workspace fixture with HOME/XDG projection and awaited cleanup                                                              | Repository search plus filesystem, process, runtime suites, and the Vitest topology hygiene contract | None; direct `mkdtemp` remains only in the workspace fixture and package-canary source text |
| Repeated CLI/MCP connection helpers             | Consolidated          | Focused workspace-CLI and MCP fixtures under `tests/support`; the unused aggregate fixture and loopback seam were removed                                                                          | Acceptance startup, typed failure, lifecycle, and teardown tests                                     | Provider-specific protocol harnesses remain local                                           |
| Implementation-shaped assertions                | Replaced              | Package identity is proven by generated metadata and package verification; MCP registration is proven through the SDK wire projection and transport behavior; layer imports are enforced by Oxlint | Focused boundary tests, metadata checks, package verification, and the static gate                   | Re-audit changed boundary families when their supported contracts change                    |
| Runtime object identity and SDK self-behavior   | Intentionally removed | Independent server object identity was not caller-visible; direct parser and SDK output-validation checks duplicated stronger wire and schema behavior                                             | MCP server transport tests and generated catalog wire projection                                     | None                                                                                        |
| Module mocks and spies                          | Replaced              | Recording adapters and caller-visible outcomes                                                                                                                                                     | Repository search plus focused reload, Ghidra, and enhanced-tool tests                               | None                                                                                        |
| `processCapture.test.ts`                        | Consolidated          | Ten lifecycle, observation, reactive, replay, terminal, validation, and trace suites                                                                                                               | 42 focused boundary tests                                                                            | None                                                                                        |
| `cdpBrowserProvider.test.ts`                    | Consolidated          | Five discovery, document/script, network, lifecycle, and sensitive-data suites                                                                                                                     | 36 focused browser-boundary tests                                                                    | None                                                                                        |
| `javascriptSemanticAnalysis.test.ts`            | Consolidated          | Six structure, call, dataflow, runtime, native-binding, and rejection suites with a colocated immutable source fixture                                                                             | 29 focused domain tests                                                                              | None                                                                                        |
| `binarySession.test.ts`                         | Consolidated          | Nine provider binding, lifecycle, cache, Evidence, permissions, and shutdown suites                                                                                                                | Focused composition tests and shared composition-seam test                                           | None                                                                                        |
| MCP mega-suites                                 | Consolidated          | Tool/resource-family suites plus catalog-wide identity and lifecycle coverage                                                                                                                      | Focused MCP tests and complete deterministic run                                                     | None                                                                                        |
| Provider client mega-suites                     | Consolidated          | Capability-named protocol, timeout, ownership, error, and cleanup suites                                                                                                                           | 85 focused provider tests                                                                            | Real systems remain in `verify:*` lanes                                                     |
| Pure domain proofs                              | Moved                 | Colocated graph, Evidence, snapshot, reconstruction, process-trace, projection, symbol, and JSON-shape tests with focused production-owned fixtures                                                | Domain Vitest project                                                                                | External filesystem, process, provider, and transport claims remain in their boundary lanes |

Use these dispositions consistently:

- **Moved**: the same material claim now has depth-appropriate ownership.
- **Replaced**: stronger executable evidence supersedes the old assertion.
- **Consolidated**: one retained test proves a claim previously duplicated.
- **Intentionally removed**: the claim was not public or independent; the row
  must still name the retained evidence or explain why none is warranted.
- **In progress**: classification exists but the replacement audit is not
  complete. No final-cutover row may retain this disposition.

The exact old-to-new inventory is mechanically enforced by the project
classification contract and retained in Git rename metadata. Real-system lanes,
coverage, repeated-run stability, and benchmark timing are release evidence;
they are reported separately because they depend on the execution host and
installed external systems.
