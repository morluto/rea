# Implementation plan

## Boundary and contract

`src/domain/native/elfUnwindRanges.ts` owns the input and result schemas,
limits and the shared limitation strings. `src/native/elf/ElfUnwindTables.ts`
decodes `.eh_frame` and `.eh_frame_hdr` over the existing ELF image reader.
Dynamic entries use the shared `readElfDynamicEntry`.
`src/native/elf/ElfIntervalIndex.ts` builds the section address and file-offset
indexes once per image.

`src/application/binaryDiagnostics/ElfUnwindRangesService.ts` depends on the
domain and its port and validates the report shape. It is composed and
registered beside the sibling binary diagnostics tools in
`src/composition/` and `src/server/createServer.ts`.

## Incremental work and validation

1. Define the schemas, limits and limitations, with domain tests.
2. Decode CIEs and FDEs over synthetic fixtures for both widths and
   endiannesses, including pointer encodings and extended lengths.
3. Decode `.eh_frame_hdr`, compare it with the FDEs, and bound the search
   table.
4. Resolve symbols and containing sections through indexes, with a combined
   symbol budget.
5. Register the CLI command and MCP tool, then add acceptance, filesystem and
   MCP boundary tests.
6. Add the `verify:elf:unwind-ranges` script against a compiled C++ program.
7. Write the guide and the CLI reference entry, update the skill reference,
   and run focused tests, lint, typecheck and docs checks.

## Effects and compatibility

Additive: one new read-only tool, one CLI command and one verifier script.
Existing tools and Evidence shapes do not change.
