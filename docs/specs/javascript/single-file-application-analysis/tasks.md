# Tasks

- [x] Define single-file analysis requirements, contracts, and implementation plan (`spec.md`, `plan.md`).
- [x] Extend `format` / `--artifact-format` schemas, views, reconciliation schemas, CLI flags, and MCP contracts with `"file"` (**R1**, **R4**; verified in `tests/boundary/filesystem/javascriptApplicationInputSelection.test.ts` and `tests/boundary/cli/githubActionsExample.test.ts`).
- [x] Implement `SingleFileJavaScriptArtifactReader`, root `"javascript-bundle"` checks, basename inventory projection, and symlinked JS/TS extension classification (**R1**, **R2**; verified in `tests/boundary/filesystem/javascriptSingleFileAndTimeoutPolicy.test.ts` and `tests/acceptance/applications/javascriptAnalysisLimits.test.ts`).
- [x] Add exact single-file runtime path mapping in `src/domain/javascript/javascriptRuntimeStaticCandidates.ts` without widening sibling-file scope (**R3**; verified in `tests/boundary/filesystem/javascriptSingleFileAndTimeoutPolicy.test.ts` and `tests/boundary/filesystem/javascript-applications/javascriptRuntimeReconciliation.test.ts`).
- [x] Update JavaScript reconstruction and reconciliation guides, skill instructions, and `docs/specs/README.md`; pass documentation route and static checks.
