# Implementation plan

## Boundary and contract

The domain contract lives in
[`src/domain/native/nativeInitializers.ts`](https://github.com/morluto/rea/blob/main/src/domain/native/nativeInitializers.ts):
input schema, entry and coverage schemas, kinds, resolutions, standing
limitations and budgets. `NativeInitializersService` validates caller input,
re-parses provider output, checks paging and artifact identity, and builds
Evidence with a file-offset location per returned slot. CLI and MCP adapters
call the same service; the tool is registered with the `evidence` effect.

## Parsers

`NativeInitializersProvider` selects one image (thin or universal slice) and
dispatches to the ELF or Mach-O parser. Both produce `CollectedInitializer`
rows, and `finishInitializerReport` pages them, counts examined slots and
appends limitations after the standing ones. Both parsers record observations
through `InitializerNotes`, which keeps distinct messages to the note budget
and tallies per-row reasons, so the limitations list stays bounded.

- `ElfInitializers.ts` reads the consumed `DT_*` tags once, builds sources in
  declaration order with a shared slot budget, and resolves each slot. Dynamic
  relocation writes come from the owner,
  `readElfRelocationWritesSteps` in `ElfPointerRelocations.ts`; the RELATIVE
  type per machine comes from the same owner's `elfRelativeRelocationType`.
  Section names and fallback file offsets come from an `addressRangeIndex`
  built once over the section headers and searched by address.
- `ElfInitializerSymbols.ts` loads symbol tables under one total symbol
  budget and decodes section REL / RELA records under one total record budget,
  checking the caller signal during that walk.
- `MachoInitializers.ts` reuses the shared Mach-O container and chained-fixup
  decoders, reads symbols under one budget across every `LC_SYMTAB`, and
  names target sections through the same address index.

## Effects and compatibility

The tool reads one stable local file and never executes it. It adds a new
contract and changes no existing tool. `slot_va` is nullable only for
`DT_INIT` / `DT_FINI` whose value field is unmapped.
