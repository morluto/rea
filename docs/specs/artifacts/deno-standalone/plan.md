# Implementation plan

## Boundary and contract

Register `deno-standalone` in the existing artifact format owners:
`src/artifacts/artifactFormats.ts`, `ArtifactEmbeddedFormatProbes.ts`,
`ArtifactReader.ts`, `ArtifactReaderAdmission.ts`, `inventory/classify.ts`,
`inventory/scanReader.ts` and `extraction/ArtifactExtraction.ts`. Add the format
metadata and member roles to `src/domain/artifactFormatMetadata.ts`,
`artifactGraph.ts`, `artifactInspection.ts` and `evidenceSubject.ts`, and accept
the format in `src/contracts/artifactToolContracts.ts`. No new tool, provider or
bridge is added; the CLI and MCP changes are additive.

Split the layout into owners under `src/artifacts/deno/`, following Deno
`cli/lib/standalone/binary.rs` and `virtual_fs.rs` at 2.9.8 with libsui 0.16.4
section placement:

- `DenoStandaloneLocation.ts` confirms the carrier name before claiming a file.
  It reads ELF and note headers, walks PE resource directories to the named
  payload through `src/native/pe/PeResourceLayout.ts`, and scans Intel trailers
  to the slice start so an enclosing app wins over a stored executable.
- `DenoSectionLayout.ts` parses metadata JSON, the virtual-filesystem header,
  specifier, redirect and remote tables, and the npm snapshot length.
- `DenoVirtualFs.ts` walks directories, files and symlinks into safe logical
  paths with indexed fallbacks, using `ArtifactPathRegistry.conflicts` in
  `src/artifacts/ArtifactPaths.ts` to avoid occupied paths.
- `DenoStandaloneAdmission.ts` binds the located carrier to the admitted file.

`src/artifacts/DenoStandaloneArtifactReader.ts` projects members, metadata,
limitations and extraction regions through the existing stable artifact read and
safe output tree.

## Incremental work and validation

1. Define the format, member roles and contracts, preserving native inventory
   for files with no confirmed carrier.
2. Implement carrier location for Mach-O, Intel trailer, ELF and PE, with
   duplicate-section checks that reject unequal lengths before hashing.
3. Implement section parsing and the bounded virtual-filesystem walk with
   indexed path fallbacks and remote specifier encoding.
4. Add the reader, inventory and extraction wiring with retained environment
   and CA limitations.
5. Add synthetic layout, location, virtual-filesystem and reader tests, CLI
   acceptance, filesystem boundary and MCP boundary tests.
6. Add `scripts/verify-deno-standalone.mjs` (`npm run verify:deno:standalone`)
   for real Deno 2.9.8 host and cross-target compiles without execution.
7. Update the [usage guide](../../../deno-standalone.md), CLI guide, limits,
   READMEs and skill references.

## Effects and compatibility

Inventory reads existing local files only; nothing is executed, injected or
downloaded. A `deno compile` executable that inventoried as a native binary now
reports `deno-standalone`, and a damaged section keeps the native format. There
is no runtime override for the named ceilings. Deno is a fixture producer for
the verifier only and is not installed by REA.
