# Implementation plan

## Boundary and contract

`src/domain/native/dwarfLines.ts` owns the request/result Zod schemas,
constants, limits, coverage invariants, and shared limitation messages, and
`src/domain/analysisView/dwarfLinesView.ts` owns the `dwarf-lines` summary and
paged collection projections for `inspect_analysis_view`.

`src/native/dwarf/DwarfSections.ts` is extended cleanly with an optional
section-role selection (`locateDwarfSections(..., roles)`) and per-section
relocation target tracking (`relocatedRoles`) so `inspect_dwarf_units` keeps its
exact section set and behavior unchanged while `inspect_dwarf_lines` locates
`.debug_line`, `.debug_line_str`, `.debug_str`, and `.debug_str_offsets`.

`src/native/dwarf/DwarfLineParser.ts` decodes DWARF 2–5 line-number program
headers and executes the line-number state machine over `DwarfCursor`, builds
per-sequence `[start_address, end_address)` spans for address lookups, and
enforces string, row, program, and opcode-step budgets.
`src/native/dwarf/DwarfLinesProvider.ts` performs stable artifact reads, universal
Mach-O slice selection, and typed error mapping.

`src/application/binaryDiagnostics/DwarfLinesService.ts` implements
`DwarfLinesPort` validation and builds digest-bound `Evidence` with section and
program `file-offset-range` locations. It is composed in
`src/composition/binaryDiagnostics.ts`, bound in
`src/server/serviceToolBindings.ts` with `summary`, and exposed on CLI via
`src/cli/binaryDiagnosticsCommands.ts`.

## Incremental work and validation

1. Define domain contracts, limits, invariants, and unit tests in
   `src/domain/native/dwarfLines.ts` and `dwarfLines.test.ts`.
2. Parameterize `DwarfSections.ts` cleanly for `.debug_line` discovery and
   per-role `ET_REL` relocation awareness without regressing `DwarfUnits`.
3. Implement `DwarfLineParser.ts`, synthetic/fixture builders
   (`DwarfLines.fixture.ts`), and exhaustive unit + provider tests.
4. Implement `dwarfLinesView.ts`, `DwarfLinesPort.ts`, `DwarfLinesService.ts`,
   capability declarations/services, CLI command, and MCP bindings.
5. Add acceptance, filesystem boundary, MCP boundary, view, and lifecycle/schema
   conformance tests, plus a compiler cross-check script/verification against
   `readelf`.
6. Add `docs/guides/native/dwarf-lines.md`, update navigation, CLI guide,
   README/translations, `docs/specs/README.md`, skill guidance, and regenerate
   package/schema metadata; run `check`, `docs:check`, focused tests, and
   cross-checks.

## Effects and compatibility

Additive: one new read-only tool (`inspect_dwarf_lines`), one CLI command
(`inspect-dwarf-lines`), and one analysis view kind (`dwarf-lines`). Existing
tools, including `inspect_dwarf_units`, keep their schemas and outputs intact.
