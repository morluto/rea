# Implementation plan

## Boundary and contract

Define the report schema, issue kinds and failure reasons in
`src/domain/unreal/unrealPak.ts`, the MCP contract in
`src/contracts/unreal/unrealToolContracts.ts` and the CLI command in
`src/cli/unrealCommands.ts`. Add the `unreal-pak` projection in
`src/domain/analysisView/unrealPakView.ts` so callers page `entries` and
`issues` from retained Evidence without reopening the file; the view matches a
retained subject by format and digest, not its display path.

Decode the footer and index in `src/unreal/UnrealPakFile.ts`, holding only the
footer and index regions in memory. `src/unreal/UnrealPakPathHash.ts`
implements the version 11+ path hash. `src/unreal/UnrealPakProvider.ts` reads
the file through the stable artifact reader, hashes it for identity, admits one
inspection per reader, maps limits to `resource` failures and keeps
partial source Evidence when the file was hashed before a failure.
`src/application/unreal/UnrealPakService.ts` and `src/composition/unreal.ts`
wire the provider into the CLI and MCP server.

## Incremental work and validation

1. Define the domain schema, MCP and CLI contracts, capability declarations and
   the `unreal-pak` analysis view.
2. Decode footers for versions 1 to 12 and legacy and version 10+ indexes,
   with issues for redundant facts that disagree and typed rejections for
   untrusted structure.
3. Bound regions, entries, path text and report size, pace long decodes for
   cancellation, and release descriptors on every failure path.
4. Add unit, boundary, MCP and CLI acceptance tests over synthetic fixtures,
   and `scripts/verify-unreal-pak.mjs` for CLI and MCP parity on a real pak.
5. Write the [Unreal pak guide](../../../unreal-pak.md), register it in the
   documentation directory, and update skill guidance and generated catalogs.

## Effects and compatibility

The tool is new and read-only; existing tools and Evidence are unchanged. No
Unreal process, external tool or decompressor runs, and no file data outside
the footer and index regions is held in memory.
