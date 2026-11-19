# Tasks

- [x] Define single-feature scope, contracts and implementation plan (`spec.md`, `plan.md`).
- [x] Extend `goBinarySchema`, MCP contracts, CLI flags and `inspect_analysis_view` (`string_literals`).
- [x] Implement bounded `(ptr, len)` recovery in `src/go/GoStringLiterals.ts` with `O(R log R)` Mach-O region indexing and non-overlapping file-order header scanning.
- [x] Add unit, provider, MCP view and CLI acceptance tests for multi-format recovery, Unicode `\p{Cf}` / ZWNJ / ZWJ filtering, caps, negative-cache bounds and 25,000-section Mach-O scaling.
- [x] Verify CLI and `artifactMcpCall` advertised-schema MCP parity across compiled targets in `scripts/verify-go-binary.mjs`.
- [x] Update the Go binary guide, skill reference and generated catalogs; pass documentation route and static checks.

- [x] Consolidate Go-owned budgets and expose per-call input/report/build-info/search and inferred-string controls in CLI/MCP without changing defaults.
- [x] Preserve source validity and exact exhausted controls, remove the fixed 10,000-item schema ceiling, and deduplicate variable-length candidates with complete offset/length identity.
- [x] Run focused source string/service tests and production service budget-recovery checks over temporary offline fixture files.
- [ ] Run the compiled CLI/MCP boundary lanes and real Go verifier for the new budget selections; source checks do not establish those workflows.
