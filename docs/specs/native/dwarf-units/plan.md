# Implementation plan

## Boundary and contract

Define the report in `src/domain/native/dwarfUnits.ts`: artifact identity,
container `format`, byte order and architecture, `sections` with stored name,
file offset, stored size and `compression`, `omissions`, the requested `units`
page with per-attribute state and `issues`, `total_units` and `coverage`.
Schema refinements tie attribute state to value presence and require a reason
for `partial` coverage. Add the MCP contract in
`src/contracts/native/binaryDiagnosticsToolContracts.ts` and the CLI command in
`src/cli/binaryDiagnosticsCommands.ts`, registered in the existing binary
diagnostics group.

Parse in `src/native/dwarf/`: `DwarfSections` locates and decompresses debug
sections through `BinaryContainer`, `DwarfAbbrev` decodes abbreviation tables
under a shared work budget, `DwarfReader` is the bounded cursor,
`DwarfUnitParser` frames units and reads the unit DIE, and `DwarfUnitsProvider`
assembles the report. `DwarfUnitsService` in `src/application/binaryDiagnostics/`
reads the selected path through the stable artifact read.

Shared changes stay with their owners: `ElfCompressedSection.ts` and
`ElfSectionNameTable.ts` for section decoding, `MachoImage.ts` and
`BinaryContainer.ts` for an `on_disk` section fact so an unmapped Mach-O
`__DWARF` segment is read by file range, and `artifactOperationError.ts` for a
typed allowance failure.

## Incremental work and validation

1. Define the domain schema, limits, coverage states and MCP/CLI contracts.
2. Implement section location and decompression, abbreviation decoding, the
   bounded reader and the unit parser with synthetic fixtures for each form,
   version and failure path.
3. Wire the provider, service, composition, capability inventory and server
   registration; add boundary, MCP and CLI acceptance tests.
4. Add `scripts/verify-dwarf-units.mjs` to compare compiled fixtures with
   `llvm-dwarfdump`, and record the run.
5. Add the [DWARF compile units guide](../../../guides/native/dwarf-units.md),
   CLI guide entry, README rows and skill guidance; run documentation checks.

## Effects and compatibility

The tool is additive and read-only over one local file. No provider, bridge or
external tool runs at inspection time, the target is never executed, and no
resources are retained. Existing readers keep their output; the `on_disk`
section fact is additive.
