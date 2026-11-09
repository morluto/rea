# Implementation plan

## Boundary and contract

Extend `goBinarySchema` in `src/domain/go/goBinary.ts` with optional
`string_literals` (`evidence_kind: "inferred"`, `items`, `discovered_count`,
`aggregate_bytes`, `max_items`, `truncated`), plus `include_string_literals` and
`max_string_literals` on `src/contracts/go/goToolContracts.ts` and
`src/cli/goCommands.ts`. Add the `string_literals` view projection to
`src/domain/analysisView/goBinaryView.ts` so callers can page recovered literals
from retained Evidence without repeating file parsing.

Implement `recoverGoStringLiterals` in `src/go/GoStringLiterals.ts` on top of
`BinaryContainer` and `createFileMappingIndex`. Pre-index readable `LoadRegion`
intervals once in `O(R log R)` so Mach-O section eligibility runs in `O(log R)`
with periodic `checkActive` cancellation checks. Normalize header-scan spans by
pointer alignment phase, merge overlaps, and sort by ascending file offset so
`reference_count` counts each physical header once and `first_header_offset` is
minimal. Deduplicate target slices in memory with bounded candidate and rejection
caches before sorting deterministically by `(location.offset, location.bytes)`.

## Incremental work and validation

1. Define domain/MCP/CLI schemas, limitation notes and `string_literals` analysis
   view behavior while preserving default omission when not requested.
2. Implement `recoverGoStringLiterals` and wire `GoBinaryImage`,
   `GoBinaryProvider` and `GoBinaryService` with cooperative cancellation.
3. Add unit fixtures across ELF/PE/Mach-O, Unicode format-control filtering,
   budget/cap truncation, overlapping ELF spans, bounded negative caching and
   25,000-section Mach-O indexing/cancellation.
4. Extend `scripts/verify-go-binary.mjs` via `artifactMcpCall` so real compiled Go
   targets verify both CLI and advertised MCP `outputSchema` parity.
5. Update the [Go binary guide](../../../guides/native/go-binaries.md), skill
   guidance, generated catalogs and documentation route checks.

## Effects and compatibility

Default `inspect_go_binary` calls omit `string_literals` and preserve historical
Evidence compatibility. No external tool or target execution is introduced; only
bounded offline byte slicing over the already read `64 MiB` image buffer runs.
