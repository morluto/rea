# Implementation plan

## Boundary and contract

`src/domain/native/elfDependencies.ts` owns the input and result schemas,
limits and the shared limitation strings, and
`src/domain/analysisView/elfDependenciesView.ts` owns the retained-Evidence
view. `src/native/elf/ElfDependencyParser.ts` decodes the dynamic table,
GNU version tables and dynamic symbols over the existing ELF image reader, and
`src/native/elf/ElfDependenciesProvider.ts` admits the selected file and
applies the budgets.

`src/application/binaryDiagnostics/ElfDependenciesService.ts` depends on the
domain and `src/ports/binaryDiagnostics/ElfDependenciesPort.ts` and validates
the report shape. It is composed beside the sibling binary diagnostics tools in
`src/composition/binaryDiagnostics.ts` and bound in
`src/server/serviceToolBindings.ts`.

## Incremental work and validation

1. Define the schemas, limits and limitations, with domain tests.
2. Decode `PT_DYNAMIC`, the `DT_*` strings and flags, and `PT_INTERP` over
   synthetic fixtures for both widths and endiannesses.
3. Walk `.gnu.version_r` and `.gnu.version_d`, derive the per-namespace
   maxima, and join undefined `.dynsym` imports to `library@version`.
4. Locate tables from section headers only when they agree with `DT_*`, and
   from `PT_LOAD` when section headers are stripped, with partial coverage
   for anything unreadable.
5. Add the summary view and its `inspect_analysis_view` collections.
6. Register the CLI command and MCP tool, then add acceptance, filesystem and
   MCP boundary tests.
7. Write the guide and the CLI reference entry, update the skill reference,
   and run focused tests, lint, typecheck and docs checks.

## Effects and compatibility

Additive: one new read-only tool, one CLI command and one analysis view kind.
Existing tools and Evidence shapes do not change.
