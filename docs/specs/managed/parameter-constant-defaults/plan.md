# Implementation plan

## Boundary and contract

`src/domain/managed/managedArtifact.ts` adds `parameter_defaults` to each
method: a required, nullable array of `{ token, row_offset, sequence, name,
flags, constant }`, where `constant` is the existing field constant record. The
CLI and MCP changes are additive output fields. No new tool, provider or bridge
is added.

## Owners

- `src/dotnet/ManagedConstants.ts` (formerly `ManagedFieldConstants.ts`) is the
  single `Constant`-table owner. It indexes `Field` and `Param` parents once and
  decodes a declaration on demand for a selected owner.
- `src/dotnet/ManagedParameterDefaults.ts` attributes `ParamList` runs in one
  pass over MethodDef coordinates, checks once per inspection for unowned
  `Param` rows that declare a default, and reads each owned row in isolation.
- `src/dotnet/ManagedMemberPointers.ts` keeps validated pointer positions with
  their lookup, so `memberListListsDefinition` answers without throwing per row
  and `memberListDefinitionRow` resolves a position to its definition row.
- `src/dotnet/ManagedMethodDefinitionRows.ts` reads raw `ParamList` coordinates.
- `src/dotnet/ManagedMemberRows.ts` wires the reader into method rows.
- `src/domain/managed/managedMemberComparisonCoverage.ts` adds the comparison
  limitation.

## Reads and budget

`Param` columns, `ParamList` coordinates and pointer positions are read through
the checked `BinaryReader`, as the raw-read architecture guard requires. Layout
admission bounds every row. A retained default reserves its row bookkeeping;
rows without a default are neither retained nor charged.
