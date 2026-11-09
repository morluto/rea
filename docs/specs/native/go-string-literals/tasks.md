# Tasks

- [x] Define single-feature scope, contracts and implementation plan (`spec.md`, `plan.md`).
- [x] Extend `goBinarySchema`, MCP contracts, CLI flags and `inspect_analysis_view` (`string_literals`).
- [x] Implement bounded `(ptr, len)` recovery in `src/go/GoStringLiterals.ts` with `O(R log R)` Mach-O region indexing and non-overlapping file-order header scanning.
- [x] Add unit, provider, MCP view and CLI acceptance tests for multi-format recovery, Unicode `\p{Cf}` / ZWNJ / ZWJ filtering, caps, negative-cache bounds and 25,000-section Mach-O scaling.
- [x] Verify CLI and `artifactMcpCall` advertised-schema MCP parity across compiled targets in `scripts/verify-go-binary.mjs`.
- [x] Update the Go binary guide, skill reference and generated catalogs; pass documentation route and static checks.
